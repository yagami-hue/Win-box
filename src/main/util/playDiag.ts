// src/main/util/playDiag.ts
// ★ 2026-09-28：播放 / 网盘落盘链路的**结构化诊断**（先取证，再定向修）。
//
// 背景（用户第 6 项）：「部分源应该正常，但资源无法正确落盘、无法播放，成功率可能只有 50%」。
// 这类问题跨「蜘蛛解析 → 夸克转存 → 直链 → /play 中继 → 播放器」五段，靠猜很容易修错地方。
// 因此先把每一步的「阶段 / 耗时 / 结果 / 原因」按行落盘（JSONL，便于脚本统计），跑一轮真实数据后再动手。
//
// 输出：`<userData>/logs/play-diag-YYYYMMDD.jsonl`（每行一个 JSON）+ 主日志一行 `[play-diag] …`。
// 隐私：URL 只留 host + 末段，id 只留短哈希 —— 诊断不需要原始串。
//
// ★ 依赖纪律：本模块**不静态依赖 electron 相关模块**（`userDataDir` / `fileLogger`），
//   改由主进程启动时 `initPlayDiag()` 注入（见 src/main/index.ts）——
//   否则任何 import 到 quarkTransfer / LocalProxyServer 的单测都会连带加载 electron 而崩。
import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** 一条诊断事件（字段自由；建议带 `kind` / `stage` / `ok` / `ms` / `reason`） */
export interface PlayDiagEvent {
  /** 事件大类：play（源解析）/ transfer（夸克转存）/ relay（/play 中继）… */
  kind: string;
  /** 阶段：start / done / save / poll / fallback / direct / upstream … */
  stage?: string;
  ok?: boolean;
  ms?: number;
  reason?: string;
  [k: string]: unknown;
}

interface DiagSink {
  /** 诊断目录（惰性取，避开启动顺序问题） */
  logDir: () => string;
  /** 同时打一行到主日志（便于用户直接反馈） */
  log: (msg: string) => void;
}

let sink: DiagSink | null = null;

/** 由主进程启动时注入；未注入（如单测环境）→ 诊断自动静默 */
export function initPlayDiag(s: DiagSink): void {
  sink = s;
}

/** URL 脱敏：只保留 host 与路径末段（丢弃 query 里的签名/cookie 类参数） */
export function redactUrl(u: string): string {
  if (!u) return '';
  try {
    const x = new URL(u);
    const tail = x.pathname.split('/').filter(Boolean).slice(-1)[0] || '';
    return `${x.host}/${tail.slice(0, 40)}`;
  } catch {
    return String(u).slice(0, 40);
  }
}

/** 短哈希（把同一 episode / 直链 在各行日志里对齐，又不落原始串） */
export function shortHash(s: string): string {
  if (!s) return '';
  return createHash('sha1').update(s).digest('hex').slice(0, 8);
}

/** 组一行 JSONL（纯函数，单测用） */
export function formatDiagLine(ev: PlayDiagEvent, ts: number): string {
  return JSON.stringify({ ts, ...ev });
}

let lastDay = '';
let dirReady = false;

/** 落盘一条诊断（任何失败都静默：诊断绝不能影响播放本身） */
export function logPlayDiag(ev: PlayDiagEvent): void {
  if (!sink) return; // 未注入（单测 / 未启动）→ 静默
  try {
    const day = new Date().toISOString().slice(0, 10);
    const dir = sink.logDir();
    if (!dirReady || day !== lastDay) {
      mkdirSync(dir, { recursive: true });
      dirReady = true;
      lastDay = day;
    }
    appendFileSync(join(dir, `play-diag-${day}.jsonl`), formatDiagLine(ev, Date.now()) + '\n', 'utf-8');
  } catch {
    /* 诊断写盘失败无所谓 */
  }
  try {
    sink.log(`[play-diag] ${JSON.stringify(ev)}`);
  } catch {
    /* ignore */
  }
}

/** 计时小工具：`const t = diagTimer()` → `t.ms()` */
export function diagTimer(): { ms: () => number } {
  const t0 = Date.now();
  return { ms: () => Date.now() - t0 };
}
