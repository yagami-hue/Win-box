// src/main/torrent/Aria2Sidecar.ts
// ★ 2026-09-29：内置 BT 引擎（aria2c sidecar，磁力 B 的地基）。
//
// 为什么是 aria2c（而不是 webtorrent / MonoTorrent）：
//   · 纯 exe、无运行时依赖（CatClaw 的 Windows 侧要拖一整套 .NET + MonoTorrent；我们这里是 Electron/JS）；
//   · 自带 DHT / PEX / UDP tracker / 元数据预取 / 选择性下载（`select-file`），全部是磁力播放的刚需；
//   · JSON-RPC 可控，`bitfield` 能**精确回答「某段字节是否已落盘校验」**，这是本地中继不喂零字节的前提。
//
// 生命周期（对齐项目既有做法）：
//   · **懒启动**：首次磁力播放才拉起，不拖慢应用首帧；常驻复用（一个进程服务所有会话）；
//   · `--stop-with-process=<本进程 pid>`（Windows 专有）→ 应用被强杀也不留孤儿 aria2c；
//   · 退出走 `dispose()`（main/index.ts 的 will-quit）。
//
// 真机取证（2026-09-29，aria2 1.37.0 win64，见 .tmp 冒烟脚本）：
//   `pause-metadata` + `followedBy`（**数组**，源码 `gatherProgressCommon` 用 List）+ `changeOption('select-file')`
//   + `unpause` 全链路可行；元数据 2~8s 到手；`bitfield` 为 MSB-first 十六进制（`BitfieldMan::setBitInternal`
//   的 `mask = 128 >> (index % 8)`）；下载中文件可直接按偏移读（mp4 `ftyp` 头正确、已校验区无零填充）。

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resourcesDir, cacheDir } from '../util/paths';
import type { Logger } from '../../shared/types';

/** aria2 `getFiles` 条目（数值字段 JSON 里是**字符串**） */
export interface Aria2FileRaw {
  index: number | string;
  path: string;
  length: number | string;
  completedLength?: number | string;
  selected?: string | boolean;
}

/** aria2 `tellStatus` 关心的字段（只取用得到的，减少轮询开销） */
export interface Aria2Status {
  status?: string;
  totalLength?: string;
  completedLength?: string;
  downloadSpeed?: string;
  pieceLength?: string;
  numPieces?: string;
  bitfield?: string;
  connections?: string;
  numSeeders?: string;
  errorCode?: string;
  errorMessage?: string;
  followedBy?: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 取一个空闲端口（aria2 RPC 只监听 127.0.0.1） */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/** aria2c 命令行（导出供单测/排障对拍：参数写错会静默劣化体验，值得锁死） */
export function aria2Args(port: number, secret: string, dir: string, stopWithPid?: number): string[] {
  return [
    // ★ 绝不读用户的 aria2.conf：外部配置可能把 dir/端口/限速带偏，甚至与本进程抢端口
    '--no-conf=true',
    '--enable-rpc=true',
    '--rpc-listen-all=false',
    `--rpc-listen-port=${port}`,
    `--rpc-secret=${secret}`,
    `--dir=${dir}`,
    // 不预分配（NTFS 稀疏/整块预分配都会拖住起播）；断点续传靠 .aria2 控制文件
    '--file-allocation=none',
    '--continue=true',
    '--allow-overwrite=false',
    '--auto-file-renaming=false',
    // 元数据落 .torrent：二次播放免 DHT 再拉元数据；未选中文件既不下也不删
    '--bt-save-metadata=true',
    '--bt-remove-unselected-file=false',
    '--seed-time=0',
    // ★ 首尾优先：mp4 的 moov 常在**文件尾**，不取尾片连元数据都读不到（起播慢的第一大坑）
    '--bt-prioritize-piece=head=8M,tail=8M',
    // 死 tracker 默认要拖 60s 才放行，压到 20s；UDP tracker 连接更快失败重试
    '--bt-tracker-timeout=20',
    '--bt-tracker-connect-timeout=10',
    '--enable-dht=true',
    '--enable-dht6=false',
    '--bt-enable-lpd=true',
    '--enable-peer-exchange=true',
    '--max-concurrent-downloads=3',
    '--disk-cache=32M',
    '--console-log-level=error',
    '--log-level=error',
    '--summary-interval=0',
    '--quiet=true',
    // ★ Windows 专有：本进程退（含被强杀）→ aria2c 自行退出，不留孤儿
    ...(stopWithPid ? [`--stop-with-process=${stopWithPid}`] : []),
  ];
}

export class Aria2Sidecar {
  private proc?: ChildProcess;
  private port = 0;
  private secret = '';
  private starting?: Promise<boolean>;
  /** 会话目录（所有 BT 会话共用；按 infoHash 分子目录由 aria2 按种子名自动创建） */
  readonly dir: string;

  constructor(private logger: Logger) {
    this.dir = join(cacheDir(), 'bt');
  }

  /** aria2c 可执行文件位置（dev = 仓库 resources/aria2；打包 = process.resourcesPath/aria2） */
  static exePath(): string {
    return join(resourcesDir(), 'aria2', 'aria2c.exe');
  }

  /** 引擎文件是否就位（缺文件时上层给「未内置 BT 引擎」的人话提示，而不是空等超时） */
  available(): boolean {
    try {
      return existsSync(Aria2Sidecar.exePath());
    } catch {
      return false;
    }
  }

  get alive(): boolean {
    return !!this.proc && this.port > 0;
  }

  /** 懒启动 + 就绪等待（幂等；并发调用共享同一次启动） */
  async ensure(): Promise<boolean> {
    if (this.alive) return true;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start(): Promise<boolean> {
    const exe = Aria2Sidecar.exePath();
    if (!existsSync(exe)) {
      this.logger.w(`BT 引擎缺失：${exe}（磁力播放不可用，将回落到「复制链接」提示）`);
      return false;
    }
    try {
      mkdirSync(this.dir, { recursive: true });
      this.port = await freePort();
      this.secret = randomBytes(12).toString('hex');
      const args = aria2Args(this.port, this.secret, this.dir, process.platform === 'win32' ? process.pid : undefined);
      const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      proc.stderr?.on('data', (b: Buffer) => {
        const line = b.toString('utf-8').trim();
        if (line) this.logger.w(`[aria2] ${line.slice(0, 300)}`);
      });
      proc.on('exit', (code, signal) => {
        this.logger.w(`BT 引擎退出（code=${code} signal=${signal}）`);
        if (this.proc === proc) {
          this.proc = undefined;
          this.port = 0;
        }
      });
      this.proc = proc;
      // 等 RPC 起（正常 < 1s；冷启动磁盘慢时给足 8s）
      for (let i = 0; i < 40; i++) {
        await sleep(200);
        try {
          await this.call<string>('aria2.getVersion', [], 2000);
          this.logger.i(`BT 引擎就绪：aria2c pid=${proc.pid} rpc=127.0.0.1:${this.port} dir=${this.dir}`);
          return true;
        } catch {
          /* 还没起：继续等 */
        }
      }
      this.logger.e('BT 引擎启动超时（RPC 未就绪）');
      this.dispose();
      return false;
    } catch (e) {
      this.logger.e('BT 引擎启动异常', e);
      this.dispose();
      return false;
    }
  }

  /** JSON-RPC（只连本机；token 认证） */
  private async call<T>(method: string, params: unknown[], timeoutMs = 15000): Promise<T> {
    if (!this.port || !this.secret) throw new Error('aria2 未启动');
    const res = await fetch(`http://127.0.0.1:${this.port}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'winbox', method, params: [`token:${this.secret}`, ...params] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(`${method}: ${json.error.message || 'rpc error'}`);
    return json.result as T;
  }

  /** 加磁力（只下元数据并暂停，等上层按文件清单 select-file） */
  async addMagnet(magnet: string, options: Record<string, string>): Promise<string> {
    return this.call<string>('aria2.addUri', [[magnet], options], 20000);
  }

  status(gid: string, keys: readonly string[]): Promise<Aria2Status> {
    return this.call<Aria2Status>('aria2.tellStatus', [gid, keys], 15000);
  }

  async files(gid: string): Promise<Aria2FileRaw[]> {
    return this.call<Aria2FileRaw[]>('aria2.getFiles', [gid], 15000);
  }

  /** 选择性下载（对**暂停中**的下载改选项 —— aria2 官方文件选择流程，真机已验证） */
  async selectFile(gid: string, fileIndex: number): Promise<void> {
    await this.call('aria2.changeOption', [gid, { 'select-file': String(fileIndex) }], 15000);
  }

  async unpause(gid: string): Promise<void> {
    await this.call('aria2.unpause', [gid], 15000);
  }

  /** 移除任务（忽略「已不存在」类错误） */
  async remove(gid: string): Promise<void> {
    try {
      await this.call('aria2.remove', [gid], 10000);
    } catch {
      try { await this.call('aria2.removeDownloadResult', [gid], 10000); } catch { /* ignore */ }
    }
  }

  /** 退出清理：杀进程（`--stop-with-process` 是第二重保险） */
  dispose(): void {
    const proc = this.proc;
    this.proc = undefined;
    this.port = 0;
    this.secret = '';
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
}