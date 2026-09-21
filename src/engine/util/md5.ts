// src/engine/util/md5.ts
// 对齐上游 com.github.tvbox.osc.util.MD5.encode / string2MD5（纯 hex 小写）。
import { createHash } from 'node:crypto';

export function md5Hex(input: string): string {
  return createHash('md5').update(input, 'utf-8').digest('hex');
}
