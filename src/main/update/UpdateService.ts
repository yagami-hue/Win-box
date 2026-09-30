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
  ACCEL_CHECK_LIMIT,
  ACCEL_FINALISTS,
  ACCEL_PROBE_BYTES,
  ACCEL_PROBE_CONCURRENCY,
  ACCEL_PROBE_LIMIT,
  ACCEL_PROBE_MS,
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
 * ★ 2026-09-30（用户要求「优先走代理链路，别连上 GitHub 就走直连」）：
 *   检查接口候选 = **代理加速前 ACCEL_CHECK_LIMIT 条（池内已按实测速率排序）+ 直连垫底**，
 *   且**全部并发抢首响**。池子有 80 条 —— 全放出去等于 80 个并发请求，必须限量。
 */
function checkUrls(): string[] {
  const out: string[] = [];
  for (const p of GH_ACCEL_PREFIXES.slice(0, ACCEL_CHECK_LIMIT)) {
    const pre = p.endsWith('/') ? p : p + '/';
    out.push(pre + UPDATE_RELEASES_API);
  }
  out.push(UPDATE_RELEASES_API);
  return out;
}

/** 小样本测速窗口（筛出前列）/ 大样本复测窗口（定胜负） */
const PROBE_SMALL = { bytes: ACCEL_PROBE_BYTES, ms: ACCEL_PROBE_MS, headersTimeout: 2500 };
const PROBE_BIG = { bytes: 1536 * 1024, ms: 3000, headersTimeout: 3000 };
/** 视为「该线路可用」的最小样本字节数（挡住加速站返回的错误页/秒断） */
const SPEED_MIN_BYTES = 64 * 1024;

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
   * ★ 2026-09-30（用户要求「池子多一些、挑下载速度最快的下载」）：**两段测速**。
   *   池子有 80 条候选，直接对每条跑大样本测速 = 每条 1.5MB 起（合计上百 MB），不可接受。
   *   ① 小样本筛选：对前 `ACCEL_PROBE_LIMIT` 条并发（`ACCEL_PROBE_CONCURRENCY`）各拉 ≤96KB/2.2s，
   *      速率按**去掉首字节**的段算（小窗口下 TTFB 会带偏排名，实测同一节点 64KB 与 2MB 样本差 20 倍）；
   *   ② 大样本复测：小样本前 `ACCEL_FINALISTS` 名再各拉 ≤1.5MB/3s，用真实持续速率定胜负。
   *   返回 = 下载候选顺序（复测冠军打头 → 其余入围者 → 其余存活线路 → 直连垫底）。
   */
  private async speedTest(urls: string[], onProgress: (p: UpdateProgress) => void): Promise<string[]> {
    if (urls.length <= 1) return urls;
    const pool = urls.slice(0, ACCEL_PROBE_LIMIT);
    const rest = urls.slice(ACCEL_PROBE_LIMIT);
    onProgress({
      phase: 'speedtest',
      received: 0,
      total: 0,
      percent: 0,
      speed: 0,
      message: `正在为 ${pool.length} 条下载线路测速…`,
    });
    const small = await this.collectSamples(pool, PROBE_SMALL, ACCEL_PROBE_CONCURRENCY);
    const alive = small.filter((s) => s.ok && s.bytes >= SPEED_MIN_BYTES).sort((a, b) => sampleBps(b) - sampleBps(a));
    for (const s of alive.slice(0, 8)) this.log.i(`更新测速(小样本)：${this.hostOf(s.url)} ${Math.round(sampleBps(s) / 1024)} KB/s（${Math.round((s.ms - (s.ttfb || 0)))}ms）`);
    if (!alive.length) {
      this.log.w(`更新测速：${pool.length} 条候选全部不可用（改按原顺序尝试下载）`);
      return [...pool, ...rest];
    }

    const finalists = alive.slice(0, ACCEL_FINALISTS);
    const big = await this.collectSamples(finalists.map((s) => s.url), PROBE_BIG, finalists.length);
    for (const s of big) this.log.i(`更新测速(复测)：${this.hostOf(s.url)} ${Math.round(sampleBps(s) / 1024)} KB/s（${s.bytes}B/${s.ms}ms）`);
    const ranked = [
      ...rankBySpeed(big, SPEED_MIN_BYTES),
      ...alive.slice(ACCEL_FINALISTS).map((s) => s.url),
      ...small.filter((s) => !alive.includes(s)).map((s) => s.url),
      ...rest,
    ];
    const best = big.find((s) => s.url === ranked[0]) || finalists.find((s) => s.url === ranked[0]);
    onProgress({
      phase: 'speedtest',
      received: 0,
      total: 0,
      percent: 0,
      speed: best ? sampleBps(best) : 0,
      message: best ? `最快线路：${this.hostOf(best.url)}（${Math.round(sampleBps(best) / 1024)} KB/s）` : '',
    });
    return [...new Set(ranked)];
  }

  private hostOf(url: string): string {
    return url.replace(/^https?:\/\//, '').split('/')[0];
  }

  /**
   * 并发（限流）测速并**限总时长**收集样本：整段最多 `ms + 800ms`（不该被最慢的线路拖住 ——
   * 实测直连 GitHub 会超时，串等会让"测速"花 8s+）。到点仍没回样本的线路按不可用记，
   * 仍保留在候选末尾作回退。
   */
  private async collectSamples(
    urls: string[],
    opts: { bytes: number; ms: number; headersTimeout: number },
    concurrency: number,
  ): Promise<SpeedSample[]> {
    const got: Array<SpeedSample | null> = urls.map(() => null);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < urls.length) {
        const i = cursor++;
        try {
          got[i] = await this.probeSpeed(urls[i], opts);
        } catch {
          got[i] = { url: urls[i], bytes: 0, ms: 0, ok: false };
        }
      }
    };
    await Promise.race([
      Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, urls.length)) }, worker)),
      new Promise((r) => setTimeout(r, opts.ms + 800)),
    ]);
    return urls.map((u, i) => got[i] ?? { url: u, bytes: 0, ms: 0, ok: false });
  }

  /**
   * 单线路限时测速：带 Range 只取头部，收满 `bytes` 或到 `ms` 即断（记 TTFB）。
   * 加速站不支持 Range 时也能用（收到窗口上限就主动 abort，不整包下载）。
   */
  private async probeSpeed(url: string, opts: { bytes: number; ms: number; headersTimeout: number }): Promise<SpeedSample> {
    const ac = new AbortController();
    const t0 = Date.now();
    let first = 0;
    let bytes = 0;
    let ok = false;
    try {
      const res = await request(url, {
        method: 'GET',
        headers: { 'User-Agent': UA, Range: `bytes=0-${opts.bytes - 1}` },
        headersTimeout: opts.headersTimeout,
        bodyTimeout: opts.ms + 500,
        signal: ac.signal,
        dispatcher: dispatchChain(url, agent)[0],
      });
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        await res.body.dump();
        return { url, bytes: 0, ms: Date.now() - t0, ok: false };
      }
      ok = true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { ac.abort(); resolve(); }, opts.ms);
        res.body.on('data', (c: Buffer) => {
          if (!first) first = Date.now();
          bytes += c.length;
          if (bytes >= opts.bytes) {
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
      return { url, bytes, ms: Date.now() - t0, ok: ok && bytes > 0, ttfb: first ? first - t0 : 0 };
    }
    return { url, bytes, ms: Date.now() - t0, ok, ttfb: first ? first - t0 : 0 };
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
