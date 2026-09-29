// src/engine/util/imageStego.ts
// ★ 2026-09-29：「图片尾部隐写」提取 —— 订阅 URL 返回图片时，从**图片结束标记之后**取出真实配置。
//
// 参照实现：kankejiang/CatClawVideo `CatClawVideo.Core/Providers/TvBoxSubscriptionManager.cs:548-617`
//   （饭太硬等订阅站的防直连机制：真实 base64 配置附在图片结束标记之后，浏览器/播放器看到的只是一张图）。
//   对方链路：明文直读 → **图片尾部隐写** → 远程 jiemi.php；我们这一档补的是中间那级。
//
// 算法（逐条对齐参照实现，两处加固见 ★）：
//   ① 定位图片结束标记：JPEG 取**最靠后**的 FF D9（载荷是 ASCII，不会再出现 FF D9）；
//      PNG 取 `IEND` + 4 字节 CRC 之后；
//   ② 结束标记之后全部字节按 ASCII 读，**清除非 base64 字符**（`[^A-Za-z0-9+/]`，含 `=`，补齐由解码方做）；
//   ③ 先按 4 字节对齐逐偏移（步长 4、上限 256 字符）试解码，取「解出来是 JSON」的起点；
//   ④ 「盐前缀 + base64」形态（参照实现 2026-09-26 实测补丁，勿删）：盐本身是合法 base64 字符，
//      与配置黏连后**任何 4 字节对齐都解不出**（盐长 10 → 真起点 mod 4 = 2）→ 直接找
//      「base64(JSON 开头)」的铁打标志再解码：
//        `eyJ` = base64(`{"`)；`W1si` = base64(`[["`)；`W3si` = base64(`[{"`)。
//   ★ 加固一：参照实现只取「第一个 IEND / 最后一个 FFD9」一处；这里对候选结束标记**逐个尝试**
//     （PNG 从头找、最多 8 处；JPEG 只取最后一处），任一处能解出配置即返回 —— 载荷里混入
//     假 `IEND` 文本时不至于整条链失败（解不出仍是失败关闭，不会误报）。
//   ★ 加固二：解出来必须 `JSON.parse` 成功且是对象/数组（参照实现只看首字符是不是 `{`/`[`），
//     避免把巧合解码的垃圾当配置返回、让导入在更靠后的步骤报出看不懂的错。
//
// 纪律：本模块只做「字节 → 配置文本」，不做网络、不写盘；失败一律返回 null（由调用方继续下一档兜底）。

/** 参与提取的图片类型（参照实现只处理 JPEG/PNG；BMP 识别了但没有结束标记处理，等价于不支持） */
export type StegoImageKind = 'jpeg' | 'png';

export interface StegoResult {
  text: string;
  kind: StegoImageKind;
  /** 载荷起点（结束标记之后）在本 buffer 中的偏移，仅用于日志/诊断 */
  offset: number;
}

/** 尾部载荷里非 base64 字符（含 `=`：参照实现会清掉，解码前再按 4 对齐补 `=`） */
const NON_BASE64 = /[^A-Za-z0-9+/]/g;

/** 「base64(JSON 开头)」标志（见文件头 ④；顺序即尝试顺序） */
const JSON_MARKERS = ['eyJ', 'W1si', 'W3si'];

/** JPEG 魔数 `FF D8`（参照实现 `bytes[0]==0xFF && bytes[1]==0xD8`） */
export function imageKindOf(buf: Buffer): StegoImageKind | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  return null;
}

/** 像不像图片（含 GIF/BMP）—— 只用于「导入失败诊断」文案，不参与提取 */
export function looksLikeImage(buf: Buffer): boolean {
  if (!buf.length) return false;
  if (imageKindOf(buf)) return true;
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return true; // BM
  return false;
}

/** 候选载荷起点（结束标记之后）。PNG：各 IEND + 8（最多 8 处）；JPEG：最后一处 FF D9 + 2 */
function tailStarts(buf: Buffer, kind: StegoImageKind): number[] {
  const out: number[] = [];
  if (kind === 'png') {
    for (let i = 0; i + 8 <= buf.length && out.length < 8; i++) {
      if (buf[i] === 0x49 && buf[i + 1] === 0x45 && buf[i + 2] === 0x4e && buf[i + 3] === 0x44) out.push(i + 8);
    }
    return out;
  }
  for (let i = buf.length - 2; i >= 0; i--) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd9) {
      out.push(i + 2);
      break;
    }
  }
  return out;
}

/** 试解一段纯 base64 文本：补齐 → 解码 → 必须是 JSON 对象/数组（纯函数，失败返回 null） */
function tryDecodeJson(seg: string): string | null {
  if (seg.length < 8) return null;
  const padded = seg.length % 4 === 0 ? seg : seg + '='.repeat(4 - (seg.length % 4));
  const decoded = Buffer.from(padded, 'base64').toString('utf-8');
  const text = decoded.replace(/^\0+/, '').trimStart();
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  const accept = (s: string): string | null => {
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === 'object' ? s : null;
    } catch {
      return null;
    }
  };
  const direct = accept(text);
  if (direct) return direct;
  // ★ 载荷尾部偶尔混入几个 base64 字符的尾巴（解码后是 JSON 之后的垃圾）→ 退到最后一个 } 或 ] 再试一次
  const cut = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  return cut > 0 ? accept(text.slice(0, cut + 1)) : null;
}

/** 从某处结束标记之后的字节里提配置（纯函数） */
function extractFrom(start: number, buf: Buffer): string | null {
  const tail = buf.subarray(start).toString('latin1');
  const clean = tail.replace(NON_BASE64, '');
  if (clean.length < 16) return null;
  // ③ 4 字节对齐逐偏移（无盐 / 盐长恰好 4 的倍数时的常规形态）
  const maxSkip = Math.min(256, clean.length - 4);
  for (let skip = 0; skip < maxSkip; skip += 4) {
    const hit = tryDecodeJson(clean.slice(skip));
    if (hit) return hit;
  }
  // ④ 盐前缀形态：从 base64(JSON 开头) 的标志处解
  for (const marker of JSON_MARKERS) {
    let at = clean.indexOf(marker);
    while (at >= 0) {
      const hit = tryDecodeJson(clean.slice(at));
      if (hit) return hit;
      at = clean.indexOf(marker, at + marker.length);
    }
  }
  return null;
}

/**
 * 提取图片尾部隐写的订阅配置。非图片 / 没有载荷 / 载荷不是 JSON → 返回 null。
 * @param buf 订阅地址的**原始响应字节**（⚠️ 不能先转成 utf-8 字符串：二进制会被替换字符毁掉）
 */
export function extractStegoConfig(buf: Buffer): StegoResult | null {
  const kind = imageKindOf(buf);
  if (!kind) return null;
  for (const start of tailStarts(buf, kind)) {
    if (start >= buf.length) continue;
    const text = extractFrom(start, buf);
    if (text) return { text, kind, offset: start };
  }
  return null;
}