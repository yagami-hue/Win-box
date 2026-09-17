// src/engine/util/logger.ts
import type { Logger } from '../../shared/types';

export const NullLogger: Logger = {
  i: () => {},
  w: () => {},
  e: () => {},
};

/** 带前缀的日志包装（JS 沙箱用 js:<siteKey>，网络用 net:） */
export function prefixLogger(prefix: string, base: Logger): Logger {
  return {
    i: (t) => base.i(`${prefix} ${t}`),
    w: (t) => base.w(`${prefix} ${t}`),
    e: (t, err) => base.e(`${prefix} ${t}`, err),
  };
}
