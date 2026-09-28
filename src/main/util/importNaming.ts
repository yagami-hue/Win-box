// src/main/util/importNaming.ts
// ★ 2026-09-27（用户要求）：导入**本地文件**（.json 订阅 / .py 源）时，如果没有自填名字，
//   就按**原始文件名**命名（去扩展名）——而不是一律叫「新订阅 xx」或一串 md5。
import { basename } from 'node:path';

/**
 * 本地文件导入用的名字：自填名优先；否则取原始文件名去掉最后一个扩展名。
 * 例：`D:\订阅\我的影视仓.json` → `我的影视仓`；`掘金.py` → `掘金`。
 * 文件名为空/全是扩展名时返回原 basename（兜底，避免空串落到「未命名配置」）。
 */
export function nameFromLocalFile(filePath: string, custom?: string): string {
  const c = (custom || '').trim();
  if (c) return c;
  const base = basename(filePath || '').trim();
  const noExt = base.replace(/\.[^./\\]+$/, '').trim();
  return noExt || base;
}