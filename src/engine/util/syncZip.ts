// src/engine/util/syncZip.ts
// 极简**同步** zip 读写（只依赖 node:zlib），用于把 raw jar 里的非 dex 资源
// 原样搬进 dex2jar 的转换产物。
//
// 为什么自己写而不是用现成库：
// - `yauzl` 是事件驱动（异步）的，而 `doConvert()` 的调用点（`execFileSync` 之后）是同步流程，
//   在同步函数里等异步回调只能靠阻塞事件循环，属于禁忌；
// - `yazl` 等写库未安装，且本项目要求依赖最小化。
//
// 只实现真正需要的部分：
// - 读：中央目录 → 本地头 → `deflate`/`store` 解压
// - 写：全部以 `store`（method 0）写入 —— 资源文件通常已被压缩（.so/.guard），
//   再 deflate 收益极小，而 store 让实现无压缩状态机、字节可预测，便于单测。
import { inflateRawSync } from 'node:zlib';

export interface ZipEntryData {
  /** zip 内路径（目录条目以 `/` 结尾） */
  name: string;
  /** 已解压的字节 */
  bytes: Buffer;
}

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  crc32: number;
  dosTime: number;
  dosDate: number;
  externalAttrs: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** 列出 zip 内全部条目名（含目录条目）。文件不是合法 zip 时抛错。 */
export function listZipEntries(buf: Buffer): string[] {
  return readCentralDirectory(buf).map((e) => e.name);
}

/**
 * 读取 zip 内全部条目（解压后的字节）。
 * 遇到无法解析的条目（如 zip64/加密）直接跳过，不抛错 —— 调用方要的是"尽量多搬一点资源"。
 */
export function readZipEntries(buf: Buffer): ZipEntryData[] {
  const out: ZipEntryData[] = [];
  for (const e of readCentralDirectory(buf)) {
    try {
      const bytes = readEntryBytes(buf, e);
      if (bytes) out.push({ name: e.name, bytes });
    } catch {
      /* 跳过坏条目 */
    }
  }
  return out;
}

/** 判断一段字节是否是合法 zip（本地文件头魔数）。 */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === LOC_SIG;
}

/** 用 `store` 方式构建 zip。`entries` 顺序即写入顺序，重复名以后者为准（调用方负责去重）。 */
export function buildZip(entries: ZipEntryData[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.bytes;
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(LOC_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // 通用标志：UTF-8 文件名
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const isDir = /\/$/.test(e.name);
    const cen = Buffer.alloc(46 + nameBuf.length);
    cen.writeUInt32LE(CEN_SIG, 0);
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10); // method
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30); // extra
    cen.writeUInt16LE(0, 32); // comment
    cen.writeUInt16LE(0, 34); // disk
    cen.writeUInt16LE(0, 36); // internal attrs
    cen.writeUInt32LE(isDir ? 0x41ed0010 : 0x81a40000, 38); // external attrs（目录带 D 位）
    cen.writeUInt32LE(offset, 42);
    nameBuf.copy(cen, 46);
    centrals.push(cen);

    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

function readCentralDirectory(buf: Buffer): CentralEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是合法的 zip（找不到中央目录结束记录）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: CentralEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    out.push({
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      method: buf.readUInt16LE(p + 10),
      crc32: buf.readUInt32LE(p + 16),
      compressedSize: buf.readUInt32LE(p + 20),
      uncompressedSize: buf.readUInt32LE(p + 24),
      dosTime: buf.readUInt16LE(p + 12),
      dosDate: buf.readUInt16LE(p + 14),
      externalAttrs: buf.readUInt32LE(p + 38),
      localHeaderOffset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 从尾部向前找 EOCD（注释最长 65535，所以最多回扫 64KB+22） */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readEntryBytes(buf: Buffer, e: CentralEntry): Buffer | null {
  if (/\/$/.test(e.name) && e.uncompressedSize === 0) return Buffer.alloc(0);
  const p = e.localHeaderOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC_SIG) return null;
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return inflateRawSync(raw);
  return null; // 其它压缩方式不支持
}

// ---- CRC32（zip 规范）----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** 计算 zip 条目 CRC32（返回无符号 32 位） */
export function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
