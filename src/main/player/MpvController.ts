// src/main/player/MpvController.ts
// ★ 2026-10-08（用户拍板「内置官方构建」）：MPV 高兼容播放内核的主进程侧 —— 单会话管理。
//
// 生命周期：渲染层 `mpvStart` → spawn mpv（`--wid` 钉进播放器窗口）→ 等 JSON IPC 管道就绪 →
//   下发属性观察 + `loadfile`；状态由 mpv 事件驱动（节流 200ms 推给渲染层）；`mpvStop`/换集/
//   关窗口/退出应用都会 quit + 兜底 kill，绝不留下孤儿进程。
//
// 单会话是刻意的：同一时刻只有「独立播放器窗口」的一个 mpv（换集 = stop + start 新进程）。
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Logger } from '../../shared/types';
import type { MpvCommand, MpvKernelState, MpvStartOptions, MpvStatus } from '../../shared/player';
import { IPC } from '../../shared/ipc-channels';
import { cacheDir, resourcesDir } from '../util/paths';
import { playerSettings } from './playerSettings';
import {
  buildMpvArgs,
  initialKernelState,
  mpvCmdLine,
  mpvCommandLines,
  mpvObserveLines,
  reduceMpvMessage,
  resolveMpvPath,
} from './mpvCore';

/** 状态推送节流（mpv 的 time-pos 事件很密；200ms ≈ 进度条刷新率，够用） */
const PUSH_INTERVAL_MS = 200;
/** IPC 管道连接总超时（mpv 启动到建管道通常 <1s） */
const CONNECT_TIMEOUT_MS = 6000;
/** quit 后的强杀宽限 */
const QUIT_GRACE_MS = 1500;

/** 取窗口 HWND（Windows 指针宽度的十进制字符串，mpv `--wid` 接受十进制 int64） */
export function hwndOf(win: BrowserWindow): string {
  try {
    const buf = win.getNativeWindowHandle();
    if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
    return String(buf.readUInt32LE(0));
  } catch {
    return '';
  }
}

export class MpvController {
  private proc: ChildProcess | null = null;
  private sock: Socket | null = null;
  private state: MpvKernelState = initialKernelState();
  private session = 0;
  private target: BrowserWindow | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private retiring = new Set<ChildProcess>();
  private pipeSeq = 0;
  private lineBuf = '';
  /** 本次会话是否已挂上外挂字幕（换字幕前先 sub-remove） */
  private subOn = false;

  constructor(private log: Logger) {}

  /** mpv 可用性与路径（配置覆盖 → 随包内置 → 本机探测） */
  status(): MpvStatus {
    const bundled = join(resourcesDir(), 'mpv', 'mpv.exe');
    const r = resolveMpvPath({
      override: playerSettings.settings.mpvPath,
      bundled,
      env: process.env,
      exists: existsSync,
    });
    const note =
      r.source === 'override'
        ? '使用自定义路径'
        : r.source === 'bundled'
          ? '使用随包内置构建（安装目录内）'
          : r.source === 'system'
            ? '使用本机已安装的 mpv'
            : '未找到 mpv：随包构建缺失且本机未安装（可在配置页「播放」指定 mpv.exe 路径）';
    return { available: r.source !== 'none', path: r.path, source: r.source, note };
  }

  get running(): boolean {
    return !!this.proc;
  }

  /**
   * 启动一次 mpv 会话（换集/换源 = 新会话）。
   * 注意：本方法返回时 mpv 已 `loadfile` 目标地址；状态经 MPV_STATE 事件持续推送。
   */
  async start(win: BrowserWindow, opts: MpvStartOptions): Promise<{ session: number; path: string }> {
    const st = this.status();
    if (!st.available) throw new Error(st.note);
    const url = String(opts?.url || '').trim();
    if (!url) throw new Error('播放地址为空');

    this.stop();
    const reservation = this.session;
    // A retiring process must release the embedded HWND before another VO attaches to it.
    await Promise.all([...this.retiring].map(proc => new Promise<void>(resolve => {
      if (proc.exitCode !== null || proc.signalCode !== null) { resolve(); return; }
      proc.once('exit', () => resolve());
    })));
    if (reservation !== this.session) return { session: reservation, path: st.path };
    this.session += 1;
    const session = this.session;
    this.target = win;
    this.state = initialKernelState(!!opts.live);
    this.subOn = false;
    this.lineBuf = '';

    const hwnd = hwndOf(win);
    if (!hwnd) throw new Error('无法取得播放器窗口句柄（mpv 无法嵌入）');
    const pipe = `\\\\.\\pipe\\winbox-mpv-${process.pid}-${++this.pipeSeq}-${Date.now().toString(36)}`;
    const args = buildMpvArgs({
      pipe,
      wid: hwnd,
      start: opts.startTime,
      volume: opts.volume ?? 1,
      rate: opts.rate ?? 1,
      fit: opts.fit,
    });
    this.log.i(`mpv: 启动（session=${session}，${st.note}）→ ${url.slice(0, 120)}`);
    const proc = spawn(st.path, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.on('error', (e) => {
      this.log.w(`mpv: 进程错误 ${e.message}`);
      if (session === this.session) this.markExited();
    });
    proc.on('exit', (code) => {
      this.log.i(`mpv: 进程退出 code=${String(code)}`);
      if (session === this.session) this.markExited();
    });
    const onOut = (chunk: Buffer): void => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const s = line.trim();
        if (s) this.log.w(`mpv: ${s.slice(0, 200)}`);
      }
    };
    proc.stdout?.on('data', onOut);
    proc.stderr?.on('data', onOut);

    let sock: Socket;
    try { sock = await this.connectPipe(pipe, CONNECT_TIMEOUT_MS); }
    catch (e) { if (proc === this.proc) this.stop(); throw e; }
    // 连接期间可能已被 stop/换集 → 丢弃这条管道
    if (session !== this.session || proc !== this.proc) {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      return { session, path: st.path };
    }
    this.sock = sock;
    sock.on('data', (d: Buffer) => this.onSockData(d, session));
    sock.on('error', () => undefined);
    sock.on('close', () => {
      if (this.sock === sock) this.sock = null;
    });
    sock.write(mpvObserveLines().join(''));
    sock.write(mpvCmdLine(['loadfile', url, 'replace']));
    return { session, path: st.path };
  }

  /** 控制命令（成功只代表已写入管道） */
  command(cmd: MpvCommand): boolean {
    const sock = this.sock;
    if (!sock) return false;
    try {
      if (cmd?.type === 'sub-add') {
        const text = String(cmd.text || '');
        if (!text.trim()) return false;
        const dir = join(cacheDir(), 'mpv');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, 'subtitle.srt');
        writeFileSync(file, text, 'utf-8');
        if (this.subOn) sock.write(mpvCmdLine(['sub-remove']));
        sock.write(mpvCmdLine(['sub-add', file, 'select']));
        this.subOn = true;
        return true;
      }
      if (cmd?.type === 'sub-clear') {
        if (this.subOn) sock.write(mpvCmdLine(['sub-remove']));
        this.subOn = false;
        return true;
      }
      const lines = mpvCommandLines(cmd);
      if (!lines.length) return false;
      for (const l of lines) sock.write(l);
      return true;
    } catch {
      return false;
    }
  }

  /** 停止会话（quit → 宽限后强杀；幂等） */
  stop(): void {
    const sock = this.sock;
    const proc = this.proc;
    this.sock = null;
    this.proc = null;
    this.target = null;
    this.session += 1; // 在途事件/连接立即作废
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    try {
      sock?.write(mpvCmdLine(['quit']));
    } catch {
      /* ignore */
    }
    try {
      sock?.end();
    } catch {
      /* ignore */
    }
    if (proc && !proc.killed && proc.exitCode === null && proc.signalCode === null) {
      this.retiring.add(proc);
      const quitTimer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }, QUIT_GRACE_MS);
      proc.once('exit', () => {
        clearTimeout(quitTimer);
        this.retiring.delete(proc);
      });
    }
    this.state = initialKernelState();
    this.subOn = false;
  }

  /** 退出应用（index.ts will-quit） */
  dispose(): void {
    this.stop();
  }

  // ---- 内部 ----

  private async connectPipe(pipe: string, timeoutMs: number): Promise<Socket> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ok = await new Promise<Socket | null>((resolve) => {
        const s = connect(pipe);
        const onErr = (): void => {
          s.removeListener('connect', onOk);
          s.destroy();
          resolve(null);
        };
        const onOk = (): void => {
          s.removeListener('error', onErr);
          resolve(s);
        };
        s.once('error', onErr);
        s.once('connect', onOk);
      });
      if (ok) return ok;
      if (Date.now() > deadline) throw new Error('mpv 通信管道连接超时（进程可能启动失败）');
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  private onSockData(d: Buffer, session: number): void {
    if (session !== this.session) return;
    this.lineBuf += String(d);
    const lines = this.lineBuf.split('\n');
    this.lineBuf = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const changed = reduceMpvMessage(this.state, msg);
      if (!changed) continue;
      // 关键节点（加载完成/播完）立即推，其余节流合并
      this.schedulePush(this.state.loaded || this.state.eof || this.state.exited);
    }
  }

  private markExited(): void {
    if (this.state.exited) return;
    this.state.exited = true;
    this.schedulePush(true);
  }

  private schedulePush(immediate: boolean): void {
    if (immediate) {
      this.pushNow();
      return;
    }
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.pushNow();
    }, PUSH_INTERVAL_MS);
  }

  private pushNow(): void {
    const w = this.target;
    if (!w || w.isDestroyed()) return;
    try {
      w.webContents.send(IPC.MPV_STATE, { session: this.session, state: { ...this.state } });
    } catch {
      /* 窗口已关：忽略 */
    }
  }
}
