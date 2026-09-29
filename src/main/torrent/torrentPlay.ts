// src/main/torrent/torrentPlay.ts
// ★ 2026-09-29：磁力播放编排（磁力 B）——「magnet → 起任务 → 选片 → 等首段可读 → 交播放器」。
//
// 两条出口（按容器/编码自动选，见 engine/torrent/magnet 的 webPlayBlockReason）：
//   · **内联**：mp4/webm 等 Chromium 能播的形态 → 返回本机中继地址 `http://127.0.0.1:9978/bt/<hash>/<idx>`，
//     由 `/bt` 路由做 Range + piece 门控（`waitCovered`）；
//   · **外部接力**：mkv/hevc 等 → 拉起已安装的桌面播放器（PotPlayer / VLC / mpv / MPC-HC），
//     把同一个中继地址交给它边下边播（不内置 ffmpeg 转封装 —— 用户拍板的取舍）。
//
// 会话表：按 infoHash 常驻（同一磁力重复点播/切集复用已下 piece），空闲 10 分钟或超过 3 个会话时回收。
// 下载进度经 `onSpeed` 推渲染层 —— 复用播放器既有的「缓存中 x MB/s」显示，不新造面板。

import { statSync } from 'node:fs';
import { LOCAL_PROXY_BASE } from '../../shared/constants';
import type { Logger } from '../../shared/types';
import {
  parseMagnet,
  withTrackers,
  withTorrentOffsets,
  pickVideoFile,
  webPlayBlockReason,
  addUriOptions,
  firstFollowedBy,
  isPieceRangeSet,
  piecesForByteRange,
  btStreamUrl,
  BT_HEAD_GATE_BYTES,
  type TorrentFile,
} from '../../engine/torrent/magnet';
import { Aria2Sidecar } from './Aria2Sidecar';
import { detectPlayers, launchPlayer } from './externalPlayer';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
};

/** 元数据（磁力握手/文件清单）等待上限 */
const META_TIMEOUT_MS = 45_000;
/** 起播门控：等文件头 BT_HEAD_GATE_BYTES 落盘的上限（做种冷时早点给用户结论，别一直转圈） */
const HEAD_GATE_TIMEOUT_MS = 45_000;
/** 起播门控的「零进度」放弃阈值 */
const HEAD_GATE_STALL_MS = 30_000;
/** 播放中单次区间门控：总上限 / 零进度放弃阈值（拖到未下载区时，还要给播放器持续供流的机会） */
const STREAM_GATE_TIMEOUT_MS = 20 * 60_000;
const STREAM_GATE_STALL_MS = 120_000;
/** 会话回收：空闲多久停 / 最多同时保留几个 */
const IDLE_STOP_MS = 10 * 60_000;
const MAX_SESSIONS = 3;

interface BtSession {
  infoHash: string;
  gid: string;
  /** 显示名（`dn` 或选中文件名） */
  title: string;
  /** 选中文件名（含路径；用于容器/编码判定） */
  fileName: string;
  fileIndex: number;
  absPath: string;
  fileLength: number;
  /** 该文件在 torrent 数据流内的偏移（piece 映射必需） */
  fileOffset: number;
  pieceLength: number;
  /** 全部文件（含偏移；`withTorrentOffsets` 产物，供换集预留） */
  files: TorrentFile[];
  lastAccess: number;
  /** 已下完（置位后 /bt 不再做 piece 门控） */
  complete: boolean;
}

export type BtPlayOutcome =
  | { kind: 'inline'; url: string; infoHash: string; fileIndex: number; title: string }
  | { kind: 'external'; player: string; title: string }
  /** 引擎缺失 / 冷门无做种 / 无外部播放器… → 调用方走 A 的「人话提示 + 复制链接」兜底 */
  | { kind: 'unsupported'; reason: string };

export class TorrentPlay {
  private sidecar: Aria2Sidecar;
  private sessions = new Map<string, BtSession>();
  /** 下载速率（KB/s）推送：main 注入 → net:speed（播放器「缓存中」显示） */
  onSpeed?: (kbs: number) => void;

  constructor(
    private logger: Logger,
    /** 用户配置的外部播放器路径（空 = 自动探测） */
    private externalPlayerPath: () => string = () => '',
  ) {
    this.sidecar = new Aria2Sidecar(logger);
  }

  /** `/bt` 路由取流入口：命中会话且文件序号一致才给（其余一律 404） */
  resolveStream(infoHash: string, fileIndex: number): { absPath: string; length: number; fileOffset: number; pieceLength: number } | null {
    const s = this.sessions.get(infoHash);
    if (!s || s.fileIndex !== fileIndex) return null;
    s.lastAccess = Date.now();
    return { absPath: s.absPath, length: s.fileLength, fileOffset: s.fileOffset, pieceLength: s.pieceLength };
  }

  /**
   * 门控：等 [start,end]（文件内相对字节）所在 piece 全部落盘校验完成。
   * 返回 false = 超时/零进度放弃（调用方应 503，而不是喂零字节坏流）。
   */
  async waitCovered(
    infoHash: string,
    fileIndex: number,
    start: number,
    end: number,
    opts: { timeoutMs?: number; stallMs?: number } = {},
  ): Promise<boolean> {
    const s = this.sessions.get(infoHash);
    if (!s || s.fileIndex !== fileIndex) return false;
    s.lastAccess = Date.now();
    if (s.complete) return true;
    const timeoutMs = opts.timeoutMs ?? STREAM_GATE_TIMEOUT_MS;
    const stallMs = opts.stallMs ?? STREAM_GATE_STALL_MS;
    const t0 = Date.now();
    let prevDone = -1;
    let prevAt = t0;
    for (;;) {
      let st: Awaited<ReturnType<Aria2Sidecar['status']>> | null = null;
      try {
        st = await this.sidecar.status(s.gid, ['status', 'completedLength', 'downloadSpeed', 'pieceLength', 'bitfield']);
      } catch (e) {
        this.logger.w(`BT 门控轮询失败：${(e as Error).message}`);
      }
      if (st) {
        const speed = num(st.downloadSpeed);
        if (speed > 0) this.onSpeed?.(speed / 1024);
        if (st.status === 'error') {
          this.logger.w(`BT 任务出错：${st.status} code=${st.errorCode ?? ''} ${st.errorMessage ?? ''}`);
          return false;
        }
        const done = num(st.completedLength);
        const pl = num(st.pieceLength) || s.pieceLength;
        const hex = st.bitfield || '';
        if (st.status === 'complete') {
          s.complete = true;
          return true;
        }
        if (done !== prevDone) {
          prevDone = done;
          prevAt = Date.now();
        }
        if (hex && pl > 0) {
          const { first, last } = piecesForByteRange(s.fileOffset, pl, start, end);
          if (isPieceRangeSet(hex, first, last) && this.fileHasBytes(s.absPath, end + 1)) return true;
        }
      }
      const now = Date.now();
      if (now - t0 > timeoutMs) {
        this.logger.w(`BT 门控超时（${Math.round(timeoutMs / 1000)}s）：${infoHash.slice(0, 8)} [${start},${end}]`);
        return false;
      }
      if (now - prevAt > stallMs) {
        this.logger.w(`BT 门控零进度放弃（${Math.round(stallMs / 1000)}s 无新增）：${infoHash.slice(0, 8)} [${start},${end}]`);
        return false;
      }
      await sleep(400);
    }
  }

  /** 磁盘上是否真的已有这么多字节（file-allocation=none 时文件是长出来的） */
  private fileHasBytes(absPath: string, need: number): boolean {
    try {
      return statSync(absPath).size >= need;
    } catch {
      return false;
    }
  }

  /**
   * 磁力 → 可播地址（inline）/ 外部播放器接力 / 不可用原因。
   * 说明：`title` 用于选片线索与显示（通常传集名或片名）。
   */
  async open(magnet: string, opts: { title?: string } = {}): Promise<BtPlayOutcome> {
    const info = parseMagnet(magnet);
    if (!info) return { kind: 'unsupported', reason: '磁力链接格式无法识别' };
    // 同磁力已在会话表（还在播/还在下）→ 直接复用，不重建任务
    const existed = this.sessions.get(info.infoHash);
    if (existed) return this.handOff(existed);
    if (!this.sidecar.available()) {
      return { kind: 'unsupported', reason: `未内置 BT 引擎（${Aria2Sidecar.exePath()} 缺失）` };
    }
    if (!(await this.sidecar.ensure())) return { kind: 'unsupported', reason: 'BT 引擎启动失败（可查日志 [aria2] 行）' };
    await this.reap();
    try {
      const gid = await this.sidecar.addMagnet(withTrackers(magnet), addUriOptions(this.sidecar.dir));
      const torrentGid = await this.waitFollowed(gid, META_TIMEOUT_MS);
      if (!torrentGid) {
        void this.sidecar.remove(gid);
        return { kind: 'unsupported', reason: '等待种子元数据超时（该磁力可能已无做种/无 tracker 可达）' };
      }
      const raw = await this.sidecar.files(torrentGid);
      const files = withTorrentOffsets(raw.map((f) => ({ index: num(f.index), path: String(f.path || ''), length: num(f.length) })));
      const pick = pickVideoFile(files, opts.title);
      if (!pick) {
        void this.sidecar.remove(torrentGid);
        return { kind: 'unsupported', reason: '种子内未找到视频文件（可能只是字幕/图片包）' };
      }
      // 只下选中的正片（其余文件不占带宽）
      await this.sidecar.selectFile(torrentGid, pick.index);
      await this.sidecar.unpause(torrentGid);
      const st = await this.sidecar.status(torrentGid, ['pieceLength', 'totalLength']);
      const session: BtSession = {
        infoHash: info.infoHash,
        gid: torrentGid,
        title: info.displayName || pick.path.split(/[\\/]/).pop() || pick.path,
        fileName: pick.path,
        fileIndex: pick.index,
        absPath: pick.path, // aria2 返回的就是绝对路径（含 dir 前缀）
        fileLength: pick.length,
        fileOffset: pick.offset,
        pieceLength: num(st.pieceLength),
        files,
        lastAccess: Date.now(),
        complete: pick.length === 0,
      };
      this.sessions.set(info.infoHash, session);
      this.logger.i(
        `BT 会话建立：${info.infoHash.slice(0, 8)}「${session.title}」file#${pick.index} ${Math.round(pick.length / 1048576)}MB`,
      );
      // 起播门控：先等文件头一小段落盘（播放器一上来就要读容器头）
      const gateEnd = Math.min(BT_HEAD_GATE_BYTES, Math.max(0, pick.length - 1));
      const ok = await this.waitCovered(info.infoHash, pick.index, 0, gateEnd, {
        timeoutMs: HEAD_GATE_TIMEOUT_MS,
        stallMs: HEAD_GATE_STALL_MS,
      });
      if (!ok) {
        this.drop(info.infoHash);
        return { kind: 'unsupported', reason: 'BT 缓冲超时（做种者过少或无做种）' };
      }
      return this.handOff(session);
    } catch (e) {
      this.logger.e('BT 会话建立失败', e);
      return { kind: 'unsupported', reason: `BT 会话建立失败：${(e as Error).message.slice(0, 80)}` };
    }
  }

  /** 等 `followedBy`（元数据下载完成 → 生成真正的种子任务）。aria2 1.37 里它是**数组** */
  private async waitFollowed(metaGid: string, timeoutMs: number): Promise<string> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(700);
      try {
        const st = await this.sidecar.status(metaGid, ['status', 'followedBy', 'errorCode', 'errorMessage']);
        const gid = firstFollowedBy(st.followedBy);
        if (gid) return gid;
        if (st.status === 'error' || (st.errorCode && st.errorCode !== '0')) {
          this.logger.w(`BT 元数据下载出错：${st.errorCode ?? ''} ${st.errorMessage ?? ''}`);
          return '';
        }
      } catch {
        /* 轮询失败（引擎重启等）→ 继续；上限由外层收口 */
      }
    }
    return '';
  }

  /** 会话 → 播放出口（内联 / 外部接力 / 不可用原因） */
  private handOff(s: BtSession): BtPlayOutcome {
    s.lastAccess = Date.now();
    const url = btStreamUrl(LOCAL_PROXY_BASE, s.infoHash, s.fileIndex);
    const block = webPlayBlockReason(s.fileName);
    if (!block) return { kind: 'inline', url, infoHash: s.infoHash, fileIndex: s.fileIndex, title: s.title };
    const players = detectPlayers(this.externalPlayerPath());
    if (!players.length) {
      return { kind: 'unsupported', reason: `${block}，且未检测到外部播放器（可安装 PotPlayer / VLC / mpv / MPC-HC）` };
    }
    const p = players[0];
    if (!launchPlayer(p.path, url)) return { kind: 'unsupported', reason: `外部播放器启动失败（${p.name}）` };
    this.logger.i(`BT 外部接力：${p.name} ← ${url}（${block}）`);
    return { kind: 'external', player: p.name, title: s.title };
  }

  /** 回收空闲/超量会话（只在开新会话前跑；正在播的会话靠 lastAccess 保命） */
  private async reap(): Promise<void> {
    const now = Date.now();
    const list = [...this.sessions.values()].sort((a, b) => a.lastAccess - b.lastAccess);
    for (const s of list) {
      const idle = now - s.lastAccess > IDLE_STOP_MS;
      const over = this.sessions.size > MAX_SESSIONS;
      if (!idle && !over) break;
      this.drop(s.infoHash);
    }
  }

  /** 结束一个会话（移除任务 + 清表；下载的部分文件保留在缓存目录，二次播放可续） */
  drop(infoHash: string): void {
    const s = this.sessions.get(infoHash);
    if (!s) return;
    this.sessions.delete(infoHash);
    void this.sidecar.remove(s.gid).catch(() => undefined);
    this.logger.i(`BT 会话结束：${infoHash.slice(0, 8)}`);
  }

  dispose(): void {
    for (const s of [...this.sessions.values()]) this.drop(s.infoHash);
    this.sidecar.dispose();
  }
}