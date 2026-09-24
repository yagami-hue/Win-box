// src/main/subtitle/archive.ts
// 字幕压缩包解压（主进程专属）：魔数分派 → zip/gz 纯 Node 解，rar/7z/bz2 走 wasm（离线可用、不依赖外部程序）。
//   - zip：复用 engine/util/syncZip（仅 store/deflate，同步）；解出 0 条目（zip64/加密）时回退 7z-wasm 一次
//   - gz ：node:zlib（gunzipSync）
//   - rar：node-unrar-js（官方 unrar 编译的 wasm，MIT）
//   - 7z / bz2：7z-wasm（7-Zip 24.09 编译的 wasm）
// ★ wasm 二进制一律用 `wasmBinary` 显式传入（从 node_modules 路径读字节）——两个库都支持该参数，
//   这样既不依赖库内部基于 __dirname 的 wasm 定位，也能在 app.asar 内正常工作（Electron 会给 fs 打补丁）。
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { readZipEntries } from '../../engine/util/syncZip';

export type ArchiveKind = 'zip' | 'gz' | 'rar' | '7z' | 'bz2';

export interface ArchiveEntry {
  /** 包内条目名（含相对路径，目录项已被剔除） */
  name: string;
  bytes: Buffer;
}

/** 归档类型识别（魔数；非归档返回 null）。允许短 Buffer（按已有字节判断） */
export function detectArchiveKind(buf: Buffer): ArchiveKind | null {
  if (buf.length < 2) return null;
  if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) return 'rar'; // Rar!
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip'; // PK
  if (buf[0] === 0x1f && buf[1] === 0x8b) return 'gz';
  if (
    buf.length >= 6 &&
    buf[0] === 0x37 && buf[1] === 0x7a && buf[2] === 0xbc && buf[3] === 0xaf && buf[4] === 0x27 && buf[5] === 0x1c
  ) {
    return '7z';
  }
  if (buf[0] === 0x42 && buf[1] === 0x5a && buf[2] === 0x68) return 'bz2'; // BZh
  return null;
}

/**
 * 解出归档内的全部文件条目（目录项剔除）。
 * 解不出来时返回空数组（调用方据此给出可读原因），**绝不抛错**。
 */
export async function extractArchiveEntries(buf: Buffer): Promise<ArchiveEntry[]> {
  const kind = detectArchiveKind(buf);
  if (!kind) return [];
  try {
    if (kind === 'zip') {
      const list = zipEntries(buf);
      if (list.length) return list;
      // 结构上确实是 zip（有中央目录结束记录：zip64/加密条目等 syncZip 读不出的情况）才值得上 7z 兜底；
      // 完全损坏的字节不浪费一次 wasm 实例化。
      if (hasZipEocd(buf)) return await extractWith7z(buf, 'zip');
      return [];
    }
    if (kind === 'gz') return gunzipEntry(buf);
    if (kind === 'rar') return await extractWithUnrar(buf);
    return await extractWith7z(buf, kind); // 7z / bz2
  } catch {
    return [];
  }
}

/** zip 是否含「中央目录结束记录」（EOCD 0x06054b50；从尾部最多回扫 64KB+22，注释最长 65535） */
function hasZipEocd(buf: Buffer): boolean {
  const min = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return true;
  }
  return false;
}

/** zip：同步读（store/deflate）；不支持的条目会被 readZipEntries 内部跳过 */
function zipEntries(buf: Buffer): ArchiveEntry[] {
  try {
    return readZipEntries(buf)
      .filter((e) => !/\/$/.test(e.name) && e.bytes.length > 0)
      .map((e) => ({ name: e.name, bytes: e.bytes }));
  } catch {
    return [];
  }
}

/** gzip：单文件流；条目名优先取头里的 FNAME，缺失时用占位名 */
function gunzipEntry(buf: Buffer): ArchiveEntry[] {
  const out = gunzipSync(buf);
  return [{ name: gzName(buf) || 'subtitle.srt', bytes: Buffer.from(out) }];
}

/** gzip 头 FNAME 字段（FLG bit3；偏移 10 起，0 结尾） */
function gzName(buf: Buffer): string {
  if (buf.length < 11) return '';
  const flg = buf[3];
  if (!(flg & 0x08)) return '';
  let end = 10;
  while (end < buf.length && buf[end] !== 0) end++;
  return buf.toString('latin1', 10, end).replace(/\\/g, '/').split('/').pop() || '';
}

// ---------- wasm 解压（rar / 7z / bz2）：懒加载 + 显式 wasmBinary ----------

/** 从 node_modules 读 wasm 字节（asar 内亦可读）；读不到返回 undefined 交给库自身定位 */
function loadWasm(spec: string): Uint8Array | undefined {
  try {
    if (typeof require !== 'function') return undefined;
    return new Uint8Array(readFileSync(require.resolve(spec)));
  } catch {
    return undefined;
  }
}

function needRequire(): NodeRequire {
  if (typeof require !== 'function') throw new Error('解压库需要在主进程（CJS）环境中运行');
  return require;
}

/** rar：node-unrar-js（官方 unrar wasm） */
async function extractWithUnrar(buf: Buffer): Promise<ArchiveEntry[]> {
  const req = needRequire();
  const mod = req('node-unrar-js') as {
    createExtractorFromData: (o: { data: ArrayBuffer; wasmBinary?: Uint8Array }) => Promise<{
      getFileList: () => { fileHeaders: Iterable<{ name: string; flags: { directory: boolean } }> };
      extract: (o: { files: string[] }) => {
        files: Iterable<{ fileHeader: { name: string; flags: { directory: boolean } }; extraction?: Uint8Array }>;
      };
    }>;
  };
  const wasmBinary = loadWasm('node-unrar-js/dist/js/unrar.wasm');
  const ex = await mod.createExtractorFromData({
    data: toArrayBuffer(buf),
    ...(wasmBinary ? { wasmBinary } : {}),
  });
  const names: string[] = [];
  for (const h of ex.getFileList().fileHeaders) {
    if (h.flags?.directory) continue;
    names.push(h.name);
  }
  if (!names.length) return [];
  const out: ArchiveEntry[] = [];
  for (const f of ex.extract({ files: names }).files) {
    if (f.fileHeader?.flags?.directory) continue;
    if (f.extraction && f.extraction.length) {
      out.push({ name: f.fileHeader.name, bytes: Buffer.from(f.extraction) });
    }
  }
  return out;
}

/** 7z / bz2（以及 zip64 兜底）：7z-wasm 的 7-Zip CLI 语义（写入 MEMFS → callMain('x') → 读出） */
async function extractWith7z(buf: Buffer, kind: ArchiveKind): Promise<ArchiveEntry[]> {
  const req = needRequire();
  const mod = req('7z-wasm') as { default?: unknown } | ((o?: unknown) => Promise<SevenZipModule>);
  const factory = (typeof mod === 'function' ? mod : (mod.default as (o?: unknown) => Promise<SevenZipModule>)) as (
    o?: unknown,
  ) => Promise<SevenZipModule>;
  if (typeof factory !== 'function') throw new Error('7z-wasm 加载失败');
  const wasmBinary = loadWasm('7z-wasm/7zz.wasm');
  const sz = await factory({
    ...(wasmBinary ? { wasmBinary } : {}),
    print: () => undefined,
    printErr: () => undefined,
  });
  const inName = kind === 'zip' ? '/in.zip' : kind === 'bz2' ? '/in.bz2' : '/in.7z';
  sz.FS.writeFile(inName, new Uint8Array(buf));
  try {
    sz.FS.mkdir('/out');
  } catch {
    /* 已存在 */
  }
  try {
    // 7-Zip 正常结束会走 exit 流程（Emscripten 可能抛出退出异常）→ 忽略，结果以 FS 内容为准
    sz.callMain(['x', inName, '-o/out', '-y']);
  } catch {
    /* ignore exit */
  }
  return readMemFs(sz, '/out');
}

interface SevenZipModule {
  FS: {
    writeFile: (p: string, data: Uint8Array) => void;
    mkdir: (p: string) => void;
    readdir: (p: string) => string[];
    stat: (p: string) => { mode: number };
    isDir: (mode: number) => boolean;
    readFile: (p: string) => Uint8Array;
  };
  callMain: (args: string[]) => void;
}

/** 递归读 Emscripten MEMFS 目录 → 条目列表（条目名去掉 /out 前缀） */
function readMemFs(sz: SevenZipModule, dir: string, prefix = '', out: ArchiveEntry[] = []): ArchiveEntry[] {
  let names: string[] = [];
  try {
    names = sz.FS.readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === '.' || name === '..') continue;
    const p = `${dir}/${name}`;
    let st: { mode: number };
    try {
      st = sz.FS.stat(p);
    } catch {
      continue;
    }
    if (sz.FS.isDir(st.mode)) {
      readMemFs(sz, p, `${prefix}${name}/`, out);
      continue;
    }
    try {
      const bytes = Buffer.from(sz.FS.readFile(p));
      if (bytes.length) out.push({ name: `${prefix}${name}`, bytes });
    } catch {
      /* 跳过读不出的条目 */
    }
  }
  return out;
}

/** Buffer → ArrayBuffer（共享内存、零拷贝视图；调用方不得再改原 Buffer） */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}