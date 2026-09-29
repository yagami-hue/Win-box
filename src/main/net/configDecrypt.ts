// src/main/net/configDecrypt.ts
// ★ 2026-09-29：订阅/接口的**解密兜底**（用户口径：「用解密来兜底」）。
//
// 缘起：用户拿来 `饭太硬` 的「全能接口解密」工具（https://www.xn--sss604efuw.cc/jm/）——
//   该工具**本体是服务端 PHP**（前端只转发 `jiemi.php?url=`），算法不公开、前端拿不到，
//   因此无法照搬实现。用户明确要求：不要做成可选项开关，直接把「解密」当最后一档兜底。
//
// 本模块两级兜底（都是"最后手段"，只有在「伪装阶梯全部失败」后才会走到）：
//   ① **本地可解释编码**：整体 base64 / hex 的配置（社区很常见）直接解出来当文本用 —— 不联网、零风险；
//   ② **远程解密服务**：把**原始订阅地址**交给 `jiemi.php` 取回明文。
//      ⚠️ 隐私口径（如实记录，勿删）：这一档会把订阅地址发给第三方服务，因此
//         · 仅在 ①② 之外的常规手段**全部失败**时触发；
//         · 每次使用都写一条 warn 日志，便于用户知情与排查。
import type { HttpClient, Logger } from '../../shared/types';
import { looksLikeSubscribeJson } from '../../engine/config/ApiConfigParser';
import { sniffBody } from '../../engine/util/fetchWithDisguise';

/** 远程解密服务（饭太硬「全能接口解密」的后端；仅作最后兜底） */
export const REMOTE_DECRYPT_ENDPOINT = 'https://www.xn--sss604efuw.cc/jm/jiemi.php';

/** 去掉 `//` 注释行（该服务的返回会在正文前加几行 `//` 横幅；粘贴内容里也常有） */
export function stripLineComments(text: string): string {
  return (text || '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n')
    .trim();
}

/** 本地可解释编码：整体 base64/hex → 解成文本（解不出/不是 JSON 返回 null；纯函数） */
export function decodeLocalCipher(raw: string): { text: string; how: 'base64' | 'hex' } | null {
  const s = stripLineComments(raw).replace(/\s+/g, '');
  if (s.length < 64) return null;
  const kind = sniffBody(Buffer.from(s, 'utf-8')).kind;
  // hex 优先，其次 base64 —— 两者的字符集有重叠（hex ⊆ base64），两种都试一遍最稳
  const tries: Array<'hex' | 'base64'> = kind === 'base64' ? ['base64', 'hex'] : ['hex', 'base64'];
  for (const how of tries) {
    try {
      const out = Buffer.from(s, how).toString('utf-8');
      if (looksLikeSubscribeJson(out)) return { text: out, how };
    } catch {
      /* 该编码解不出 → 试下一种 */
    }
  }
  return null;
}

export interface DecryptOutcome {
  text: string;
  /** 用了哪一档（写日志/诊断用） */
  how: 'local-base64' | 'local-hex' | 'remote-jiemi';
}

/**
 * 解密兜底：本地编码 → 远程解密服务。
 * @param rawUrl 原始订阅地址（远程档需要它；空则跳过远程档）
 * @param rawText 已经拿到的原始响应文本（本地档用它）
 */
export async function tryDecryptConfig(
  http: HttpClient,
  rawUrl: string,
  rawText: string,
  logger?: Logger,
): Promise<DecryptOutcome | null> {
  const local = decodeLocalCipher(rawText);
  if (local) {
    logger?.i(`订阅解密兜底：本地 ${local.how} 解码成功（${local.text.length}B）`);
    return { text: local.text, how: local.how === 'base64' ? 'local-base64' : 'local-hex' };
  }
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return null;
  try {
    const url = `${REMOTE_DECRYPT_ENDPOINT}?url=${encodeURIComponent(rawUrl)}`;
    const res = await http.request({ url, method: 'get', timeoutMs: 25_000, buffer: 0, redirect: 1, headers: { 'User-Agent': 'okhttp/3.12.0' } });
    const text = typeof res.content === 'string' ? res.content : Buffer.from(res.content || []).toString('utf-8');
    if (res.status !== 200 || /解密失败/.test(text)) {
      logger?.w(`订阅解密兜底：远程解密服务未成功（HTTP ${res.status}${/解密失败/.test(text) ? '，返回"解密失败"' : ''}）`);
      return null;
    }
    const body = stripLineComments(text);
    if (!looksLikeSubscribeJson(body)) {
      logger?.w('订阅解密兜底：远程解密服务返回的不是订阅 JSON，放弃');
      return null;
    }
    // ⚠️ 如实记录：这一档把订阅地址发给了第三方解密服务（见文件头隐私口径）
    logger?.w(`订阅解密兜底：已使用**第三方解密服务**取回明文（${body.length}B）—— 该地址已发送给 ${REMOTE_DECRYPT_ENDPOINT}`);
    return { text: body, how: 'remote-jiemi' };
  } catch (e) {
    logger?.w(`订阅解密兜底：远程解密服务请求失败：${(e as Error).message}`);
    return null;
  }
}
