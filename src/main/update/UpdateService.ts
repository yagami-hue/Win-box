// src/main/update/UpdateService.ts
// ★ 2026-09-29：启动强制更新（主进程侧）—— 查 GitHub 最新 Release → 版本比对 → 代理加速下载
//   Setup 安装包（带进度）→ 拉起安装程序。
//
// 依赖：undici（与全项目出站口径一致，走 `dispatchChain` 复用用户的网络代理设置）。
// 红线：**检查失败不得锁死软件**（check() 返回 updateAvailable=false）；下载只会从
//   `cacheDir()/update/` 落盘（应用私有目录，不与 Chromium 缓存冲突）。
import { Agent, request } from 'undici';
import { app, shell } from 'electron';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import {
  GH_ACCEL_PREFIXES,
  UPDATE_RELEASES_API,
  buildAccelUrls,
  isUpdateAvailable,
  parseLatestRelease,
  pickSetupAsset,
  rankBySpeed,
  sampleBps,
  type ReleaseJson,
  type SpeedSample,
  type UpdateAsset,
  type UpdateCheckResult,
  type UpdateProgress,
} from '../../shared/update';
import { cacheDir } from '../util/paths';
import { dispatchChain } from '../net/proxy';
import type { Logger } from '../../shared/types';

const agent = new Agent({ connect: { timeout: 20000 } });
const UA = 'Win-Box-Updater';

/**
 * ★ 2026-09-30（用户要求「更新时优先走代理链路，先测速挑最快的下载，别连上 GitHub 就走直连」）：
 *   检查接口候选地址 = **代理加速优先、直连垫底**，且**全部并发**抢第一个成功响应
 *   （直连在国内常能连通但极慢；串行试代理会白等 each×8s）。
 */
function checkUrls(): string[] {
  const out: string[] = [];
  for (const p of GH_ACCEL_PREFIXES) {
    const pre = p.endsWith('/') ? p : p + '/';
    out.push(pre + UPDATE_RELEASES_API);
  }
  out.push(UPDATE_RELEASES_API);
  return out;
}

/** 测速窗口：单条线路最多测这么久 / 最多收这么多字节（够比较速率即可，别拖时间） */
const SPEED_TEST_MS = 3500;
const SPEED_TEST_BYTES = 2 * 1024 * 1024;
/** 视为「该线路可用」的最小样本字节数（挡住加速站返回的错误页/秒断） */
const SPEED_MIN_BYTES = 256 * 1024;

export class UpdateService {
  private lastAsset: UpdateAsset | null = null;
  private lastPath = '';

  constructor(private readonly log: Logger) {}

  /** 安装包落盘目录（应用私有缓存；`cacheDir()/update`） */
  private updateDir(): string {
    return join(cacheDir(), 'update');
  }

  /**
   * 检查更新。**任何失败都返回 updateAvailable=false**（不锁死软件），并带上 error 说明。
   * updateAvailable=true 的条件：远端版本更高 **且** 找到 Setup 安装包。
   * ★ 2026-09-30：候选地址（代理优先 + 直连）**并发抢首响**，第一个 200 即用，其余立即放弃。
   */
  async check(): Promise<UpdateCheckResult> {
    const localVersion = app.getVersion();
    const base: UpdateCheckResult = { localVersion, remoteVersion: '', tag: '', updateAvailable: false };

    const { json, lastErr } = await this.fetchLatestRelease();
    if (!json) {
      this.log.w(`更新检查失败（按「无更新」放行）：${lastErr}`);
      return { ...base, error: lastErr || '网络不可达' };
    }

    const rel = parseLatestRelease(json);
    const newer = isUpdateAvailable(localVersion, rel.version);
    const chosen = newer ? pickSetupAsset(rel.assets, rel.version) : null;
    const asset: UpdateAsset | undefined = chosen
      ? {
          name: chosen.name,
          url: chosen.browser_download_url,
          size: Number(chosen.size) || 0,
          accelUrls: buildAccelUrls(chosen.browser_download_url),
        }
      : undefined;
    if (newer && !asset) this.log.w(`更新检查：远端 ${rel.version} 更高，但未找到 .exe 安装包，跳过强制更新`);
    if (newer && asset) this.log.i(`更新检查：本地 ${localVersion} < 远端 ${rel.version}，需强制更新（${asset.name}）`);

    this.lastAsset = asset || null;
    return {
      localVersion,
      remoteVersion: rel.version,
      tag: rel.tag,
      updateAvailable: !!asset,
      releaseName: rel.name,
      releaseNotes: rel.notes,
      publishedAt: rel.publishedAt,
      asset,
    };
  }

  /** 已下载完成的安装包绝对路径（未下载 → ''） */
  downloadedPath(): string {
    if (this.lastPath && existsSync(this.lastPath)) return this.lastPath;
    const a = this.lastAsset;
    if (a) {
      const p = join(this.updateDir(), a.name);
      if (existsSync(p)) return p;
    }
    return '';
  }

  /**
   * ★ 2026-09-30：并发抢首响拉最新 Release（代理链路优先 + 直连垫底）。
   * 全部候选同时发起，谁先回 200 就用谁，其余立刻放弃 —— 既满足「优先走代理」，
   * 又不会因为某条线路不可达白等（串行时每条 8s，最坏 40s+）。
   */
  private async fetchLatestRelease(): Promise<{ json: ReleaseJson | null; lastErr: string }> {
    const urls = checkUrls();
    const errors: string[] = [];
    let settled = false;
    return new Promise((resolve) => {
      const finish = (json: ReleaseJson | null, err: string): void => {
        if (settled) return;
        settled = true;
        resolve({ json, lastErr: err });
      };
      let pending = urls.length;
      for (const url of urls) {
        const host = url.replace(/^https?:\/\//, '').split('/')[0];
        void (async () => {
          try {
            const res = await request(url, {
              method: 'GET',
              headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
              headersTimeout: 8000,
              bodyTimeout: 8000,
              dispatcher: dispatchChain(url, agent)[0],
            });
            if (res.statusCode !== 200) {
              await res.body.dump();
              errors.push(`${host}: HTTP ${res.statusCode}`);
              return;
            }
            const text = await res.body.text();
            if (settled) return; // 别的线路已经赢了
            const json = JSON.parse(text) as ReleaseJson;
            this.log.i(`更新检查：命中 ${host}`);
            finish(json, '');
          } catch (e) {
            errors.push(`${host}: ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            pending--;
            if (pending === 0 && !settled) finish(null, errors.join('；') || '网络不可达');
          }
        })();
      }
    });
  }

  /**
   * ★ 2026-09-30（用户要求「先为代理链路测速，挑下载速度最快的下载」）：
   *   对每条候选线路做**限时测速**（并发；最多 SPEED_TEST_MS / SPEED_TEST_BYTES），
   *   按实测速率排序返回下载顺序。测速失败的线路仍排在末尾作回退（不丢候选）。
   */
  private async speedTest(urls: string[], onProgress: (p: UpdateProgress) => void): Promise<string[]> {
    if (urls.length <= 1) return urls;
    onProgress({
      phase: 'speedtest',
      received: 0,
      total: 0,
      percent: 0,
      speed: 0,
      message: `正在为 ${urls.length} 条下载线路测速…`,
    });
    const samples = await this.collectSamples(urls);
    for (const s of samples) {
      const host = s.url.replace(/^https?:\/\//, '').split('/')[0];
      this.log.i(
        s.ok && s.bytes > 0
          ? `更新测速：${host} ${Math.round(sampleBps(s) / 1024)} KB/s（${s.bytes}B/${s.ms}ms）`
          : `更新测速：${host} 不可用（${s.bytes}B）`,
      );
    }
    const ranked = rankBySpeed(samples, SPEED_MIN_BYTES);
    const best = samples.find((s) => s.url === ranked[0]);
    onProgress({
      phase: 'speedtest',
      received: 0,
      total: 0,
      percent: 0,
      speed: best ? sampleBps(best) : 0,
      message: best ? `最快线路：${best.url.replace(/^https?:\/\//, '').split('/')[0]}` : '',
    });
    return ranked;
  }

  /**
   * 并发测速并**限总时长**收集样本：整段最多 SPEED_TEST_MS + 800ms（不该被最慢的线路拖住 ——
   * 实测直连 GitHub 会超时，串等会让"测速"花 8s+）。到点仍没回样本的线路按不可用记，
   * 仍保留在候选末尾作回退。
   */
  private async collectSamples(urls: string[]): Promise<SpeedSample[]> {
    const got: Array<SpeedSample | null> = urls.map(() => null);
    const probes = urls.map((u, i) =>
      this.probeSpeed(u).then((s) => {
        got[i] = s;
        return s;
      }),
    );
    await Promise.race([
      Promise.all(probes),
      new Promise((r) => setTimeout(r, SPEED_TEST_MS + 800)),
    ]);
    return urls.map((u, i) => got[i] ?? { url: u, bytes: 0, ms: 0, ok: false });
  }

  /**
   * 单线路限时测速：带 Range 只取头部，收满 SPEED_TEST_BYTES 或到 SPEED_TEST_MS 即断。
   * 加速站不支持 Range 时也能用（收到窗口上限就主动 destroy，不整包下载）。
   */
  private async probeSpeed(url: string): Promise<SpeedSample> {
    const ac = new AbortController();
    const t0 = Date.now();
    let bytes = 0;
    let ok = false;
    try {
      const res = await request(url, {
        method: 'GET',
        headers: { 'User-Agent': UA, Range: `bytes=0-${SPEED_TEST_BYTES - 1}` },
        // 连接/首字节给 3s（死线路快速出局），body 窗口另算
        headersTimeout: 3000,
        bodyTimeout: SPEED_TEST_MS + 500,
        signal: ac.signal,
        dispatcher: dispatchChain(url, agent)[0],
      });
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        await res.body.dump();
        return { url, bytes: 0, ms: Date.now() - t0, ok: false };
      }
      ok = true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { ac.abort(); resolve(); }, SPEED_TEST_MS);
        res.body.on('data', (c: Buffer) => {
          bytes += c.length;
          if (bytes >= SPEED_TEST_BYTES) {
            clearTimeout(timer);
            ac.abort();
            resolve();
          }
        });
        res.body.on('end', () => { clearTimeout(timer); resolve(); });
        res.body.on('error', () => { clearTimeout(timer); resolve(); });
      });
    } catch {
      // abort 属预期（测速窗口到）；其它异常按不可用处理
      return { url, bytes, ms: Date.now() - t0, ok: ok && bytes > 0 };
    }
    return { url, bytes, ms: Date.now() - t0, ok };
  }

  /**
   * 下载上次 check() 选中的安装包到 `cacheDir()/update/<name>`（带进度回调）。
   * 已存在且大小一致 → 直接复用（避免每次启动重下 150MB）。
   * 逐个尝试加速地址，全部失败才报错。
   */
  async download(onProgress: (p: UpdateProgress) => void): Promise<{ ok: boolean; path?: string; error?: string }> {
    const asset = this.lastAsset;
    if (!asset) return { ok: false, error: '没有可下载的安装包（请先检查更新）' };
    mkdirSync(this.updateDir(), { recursive: true });
    const dest = join(this.updateDir(), asset.name);

    if (existsSync(dest) && asset.size > 0 && statSync(dest).size === asset.size) {
      this.lastPath = dest;
      onProgress({ phase: 'done', received: asset.size, total: asset.size, percent: 100, speed: 0, message: '已下载完成' });
      this.log.i(`更新下载：复用已下载安装包 ${dest}`);
      return { ok: true, path: dest };
    }

    const part = dest + '.part';
    let lastErr = '下载失败';
    // ★ 2026-09-30：先并发测速，按实测速率排序后再下载（最快的那条打头，其余仍作回退）
    let urls = asset.accelUrls;
    try {
      urls = await this.speedTest(asset.accelUrls, onProgress);
    } catch (e) {
      this.log.w(`更新测速失败（改按原顺序下载）：${(e as Error).message}`);
    }
    for (const url of urls) {
      const host = url.replace(/^https?:\/\//, '').split('/')[0];
      try {
        this.log.i(`更新下载：尝试 ${host}`);
        await this.downloadOne(url, part, asset.size, onProgress, 0);
        rmSync(dest, { force: true });
        renameSync(part, dest);
        this.lastPath = dest;
        onProgress({ phase: 'done', received: asset.size, total: asset.size, percent: 100, speed: 0, message: '已下载完成' });
        this.log.i(`更新下载：完成 ${dest}（${statSync(dest).size} B，源 ${host}）`);
        return { ok: true, path: dest };
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        this.log.w(`更新下载失败（${host}）：${lastErr}`);
        rmSync(part, { force: true });
      }
    }
    onProgress({ phase: 'error', received: 0, total: asset.size, percent: 0, speed: 0, error: lastErr });
    return { ok: false, error: lastErr };
  }

  /** 单地址流式下载（自行跟随 302；写 `<dest>.part`，成功后由调用方改名） */
  private async downloadOne(
    url: string,
    partPath: string,
    expectSize: number,
    onProgress: (p: UpdateProgress) => void,
    depth: number,
  ): Promise<void> {
    const res = await request(url, {
      method: 'GET',
      headers: { 'User-Agent': UA },
      headersTimeout: 20000,
      // 大文件慢速下载：关闭 body 超时（连接阶段仍有时限）
      bodyTimeout: 0,
      dispatcher: dispatchChain(url, agent)[0],
    });
    const loc = res.headers['location'];
    if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
      await res.body.dump();
      if (depth >= 8) throw new Error('重定向次数过多');
      const next = new URL(String(loc), url).toString();
      return this.downloadOne(next, partPath, expectSize, onProgress, depth + 1);
    }
    if (res.statusCode !== 200) {
      await res.body.dump();
      throw new Error(`HTTP ${res.statusCode}`);
    }

    const total = Number(res.headers['content-length']) || expectSize || 0;
    let received = 0;
    let lastT = Date.now();
    let lastB = 0;
    let speed = 0;
    res.body.on('data', (chunk: Buffer) => {
      received += chunk.length;
      const now = Date.now();
      if (now - lastT >= 300) {
        speed = Math.round(((received - lastB) * 1000) / (now - lastT));
        lastT = now;
        lastB = received;
        const percent = total ? Math.min(99, Math.floor((received * 100) / total)) : 0;
        onProgress({ phase: 'downloading', received, total, percent, speed });
      }
    });

    // 有明确大小但服务端没给 content-length 时，用 API 的 size 兜底校正
    const ws = createWriteStream(partPath);
    await pipeline(res.body, ws);
    if (total && received !== total) {
      // 不强制失败：部分加速站 content-length 与实际略有出入；以文件落盘为准
      this.log.w(`更新下载：字节数不符（收到 ${received} / 预期 ${total}）`);
    }
    onProgress({ phase: 'downloading', received, total: total || received, percent: 100, speed });
  }

  /** 启动安装包（EXE 直接后台拉起）；返回的错误串为空即成功 */
  async launch(path: string): Promise<{ ok: boolean; error?: string }> {
    const err = await shell.openPath(path);
    if (err) return { ok: false, error: err };
    this.log.i(`更新安装：已拉起安装程序 ${path}`);
    return { ok: true };
  }
}
