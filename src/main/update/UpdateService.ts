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
  type ReleaseJson,
  type UpdateAsset,
  type UpdateCheckResult,
  type UpdateProgress,
} from '../../shared/update';
import { cacheDir } from '../util/paths';
import { dispatchChain } from '../net/proxy';
import type { Logger } from '../../shared/types';

const agent = new Agent({ connect: { timeout: 20000 } });
const UA = 'Win-Box-Updater';

/** 检查接口候选地址：直连优先，其次加速前缀（容错，任一成功即可） */
function checkUrls(): string[] {
  const out = [UPDATE_RELEASES_API];
  for (const p of GH_ACCEL_PREFIXES) {
    const pre = p.endsWith('/') ? p : p + '/';
    out.push(pre + UPDATE_RELEASES_API);
  }
  return out;
}

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
   */
  async check(): Promise<UpdateCheckResult> {
    const localVersion = app.getVersion();
    const base: UpdateCheckResult = { localVersion, remoteVersion: '', tag: '', updateAvailable: false };

    let json: ReleaseJson | null = null;
    let lastErr = '';
    for (const url of checkUrls()) {
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
          lastErr = `HTTP ${res.statusCode}`;
          continue;
        }
        json = JSON.parse(await res.body.text()) as ReleaseJson;
        this.log.i(`更新检查：命中 ${url.replace(/https?:\/\//, '').slice(0, 60)}…`);
        break;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
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
    for (const url of asset.accelUrls) {
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
