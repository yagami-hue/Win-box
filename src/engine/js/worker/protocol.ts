// src/engine/js/worker/protocol.ts
// ★★ 2026-09-30（用户报「另一台设备用自用本地包搜索时软件卡死」）★☆
//   JS 蜘蛛（drpy/hiker）此前跑在**主进程内**（node:vm）。而同步 `req()` 是用
//   `spawnSync` 实现的 —— 它同步阻塞主进程：实测单个源连续同步请求每次冻住 400ms~1.5s，
//   指向本机回环（`/pkg/…` 等自家本地代理路由）时更会与主进程**互等死锁**（实测 11.6s，
//   日志里 `97_search.js` 之后整整 62s 无任何日志 = 软件假死）。
//   修法：把 JS 沙箱整体搬进 **worker_threads**，同步阻塞只卡 worker；宿主能力（http/kv/logger）
//   经本协议回主进程执行（http 走消息往返，kv/同步 http 走 SharedArrayBuffer + Atomics，
//   让 worker 能保持真同步语义而不冻主进程）。
//
// 约定：`sab` 通道的数据布局 = [0]=状态(0 未就绪/1 完成, Int32) [1]=字节长度(Int32) [8..]=UTF-8 JSON。

import type { HttpRequest, HttpResponse } from '../../../shared/types';

/** SAB 数据区起点（前 8 字节是两个 Int32 控制位） */
export const SAB_HEADER = 8;
/** 单次同步往返的最大载荷（够装一个大页面/JSON；超出截断由调用侧按空响应处理） */
export const SAB_MAX_BYTES = 8 * 1024 * 1024;

/** worker → 主进程（宿主调用） */
export type HostCall =
  | { t: 'http'; id: number; req: HttpRequest }
  | { t: 'httpSync'; id: number; req: HttpRequest; sab: SharedArrayBuffer }
  | { t: 'kv'; id: number; op: 'get' | 'set' | 'delete'; key: string; val?: string; sab: SharedArrayBuffer }
  | { t: 'log'; level: 'i' | 'w' | 'e'; msg: string };

/** 主进程 → worker（任务） */
export type WorkerTask =
  // ★ open 也带 id：脚本加载/init 失败必须**立刻回执**（否则池只能等 OPEN_TIMEOUT 杀 worker 重来，
  //   表现为「JS 源连环打开超时」）—— 与 call 共用 pending 回执通道。
  | { t: 'open'; id: number; key: string; api: string; ext: string }
  | { t: 'setExt'; key: string; ext: string }
  | { t: 'call'; id: number; key: string; names: string[]; args: unknown[]; timeoutMs: number }
  | { t: 'destroy'; key: string };

/** worker → 主进程（任务结果）：ok/err 按 id 配对（open 的成功值 = 方法名风格） */
export type WorkerReply =
  | { t: 'ok'; id: number; value?: unknown }
  | { t: 'err'; id: number; message: string };

/** 主进程 → worker 的宿主回执（异步 http） */
export type HostReply = { t: 'httpRes'; id: number; res: HttpResponse } | { t: 'httpErr'; id: number; message: string };

/** 同步通道（SAB）的载荷格式 */
export interface SabPayload<T> {
  ok: boolean;
  value?: T;
  error?: string;
}