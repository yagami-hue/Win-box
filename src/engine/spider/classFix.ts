// src/engine/spider/classFix.ts
// ★★ 2026-09-30（用户报「除饭太硬外其他接口的『盘搜』类型源搜索出来的结果无法正常展示详情」）：
//   转换产物（dex2jar）里存在**自递归 `invokespecial`** —— DEX 的
//     `invoke-super {p0, …}, L<当前类>;->m(…)`（即源码里的 `super.m(...)`，该方法声明在**更上层**的祖先类）
//   被 dex2jar 原样转成 `invokespecial <当前类>.m` —— JVM 解析后指向**方法自身** ⇒ 无限递归 ⇒
//   `StackOverflowError`。
//
//   实测（潇洒订阅 sun.json 的全局 jar）：`com.github.catvod.spider.Pan.init` 里就这一处，
//   而 `MiPan / PanSou / Baiku / KuLe / QuPanSo / GuiGui / AiPan / KKPan / RenRen / Jike / ShuangXing /
//   Yidong4K / 4KZhinan` 等**整族盘搜蜘蛛**的 `init` 都调 `super.init(...)` ⇒ 一进来就栈溢出 ⇒
//   全族源「搜都搜不出来」。
//
//   修复 = 把该 Methodref 的 owner（class_index）**就地**改写成 `super_class`：
//   JVM 的方法解析会从该超类起**向上**查找，语义与 DEX invoke-super 一致
//   （等价于 javac 为 `super.m()` 生成的 `invokespecial <声明该方法的祖先类>.m`）。
//
// 安全护栏（宁可漏修，绝不误伤 —— 误改会把「合法递归」变成错误调用）：
//   · 只改写「方法体里 `invokespecial` 指向**本类**同名同签名方法」的引用；
//   · 该 Methodref **只被这一处使用**（被别的指令复用 → 保守跳过）；
//   · 不碰 `private` 方法（自调用是真递归，不是 invoke-super 残迹）；
//   · 不碰 `<init>` / `<clinit>`（构造器委托 `this(...)` 合法且常见）；
//   · 只在该方法确实在**超类链**上被声明时才改写（invoke-super 的前提；祖先类解析不到 → 跳过）。
//
// 只做 2 字节就地改写、不重排字节码（不改代码布局 ⇒ 不涉及栈映射帧；运行器本就带 `-noverify`）。
import { readFileSync } from 'node:fs';
import { buildZip, listZipEntries, readZipEntries, type ZipEntryData } from '../util/syncZip';

// ---- class 文件解析（只取需要的东西：常量池 / 方法表 / 方法体内的 invoke 指令）----

interface CpEntry {
  tag: number;
  /** Utf8 文本 / Class 的 name_index / NameAndType 的 name+desc / Methodref 的 class+nat */
  s?: string;
  a?: number;
  b?: number;
}

interface MethodInfo {
  access: number;
  name: string;
  desc: string;
  /** Code 属性内的指令流（仅记录 invoke 类指令） */
  invokes: Array<{ op: number; ref: number }>;
}

export interface ClassInfo {
  buf: Buffer;
  cp: CpEntry[];
  /** 各常量池项的字节偏移（改写 class_index 用） */
  cpOff: Int32Array;
  thisClass: number;
  superClass: number;
  name: string;
  superName: string;
  methods: MethodInfo[];
  /** Methodref 常量池下标 → 全类范围的使用位置（含来自哪个方法） */
  usage: Map<number, Array<{ op: number; method: number }>>;
}

/** 指令长度表（tableswitch / lookupswitch / wide 特判；其余按 JVM 规范）。
 *
 * ★★ 2026-10-08（用户报「打开就卡死/闪退」的真根因，勿回退）：**长度必须恒 ≥ 1**。
 *   畸形/错位字节码里 `tableswitch` 的 `hi < lo`、`lookupswitch` 的 `n < 0` 都会让旧实现
 *   算出**负数长度**，调用方 `i += len` 原地打转 ⇒ **死循环**（实测：某 227KB 混淆类
 *   `merge/A/f1.class` 必现）—— 而这条链跑在**主进程**（jar 收编 → classFix），
 *   一旦命中整个应用冻结、且产物永远收编不完 ⇒ 每次启动都在同一处卡死（用户侧「崩溃」）。
 *   宁可漏修（解析错位后本就不该误改），绝不卡死：一律钳到 ≥1 保证扫描单调前进。
 */
export function instrLen(code: Buffer, i: number): number {
  const op = code[i];
  if (op === 0xaa) {
    let j = i + 1;
    while ((j - i) % 4 !== 0) j++;
    const lo = code.readInt32BE(j + 4);
    const hi = code.readInt32BE(j + 8);
    const cnt = hi - lo + 1;
    const len = j - i + 12 + cnt * 4;
    return len >= 1 ? len : 1;
  }
  if (op === 0xab) {
    let j = i + 1;
    while ((j - i) % 4 !== 0) j++;
    const n = code.readInt32BE(j + 4);
    const len = j - i + 8 + n * 8;
    return len >= 1 ? len : 1;
  }
  if (op === 0xc4) return code[i + 1] === 0x84 ? 6 : 4; // wide
  if (
    op === 0x10 ||
    op === 0x12 ||
    (op >= 0x15 && op <= 0x19) ||
    (op >= 0x36 && op <= 0x3a) ||
    op === 0xa9 ||
    op === 0xbc
  ) {
    return 2;
  }
  if (
    op === 0x11 ||
    op === 0x13 ||
    op === 0x14 ||
    op === 0x84 ||
    (op >= 0x99 && op <= 0xa8) ||
    (op >= 0xb2 && op <= 0xb8) ||
    op === 0xbb ||
    op === 0xbd ||
    op === 0xc0 ||
    op === 0xc1 ||
    op === 0xc6 ||
    op === 0xc7
  ) {
    return 3;
  }
  if (op === 0xb9 || op === 0xba || op === 0xc8 || op === 0xc9) return 5;
  if (op === 0xc5) return 4;
  return 1;
}

/** 解析 class 字节（在**副本**上操作，改写不影响入参） */
export function parseClassBytes(input: Buffer): ClassInfo {
  const b = Buffer.from(input);
  let p = 8;
  const cpCount = b.readUInt16BE(p);
  p += 2;
  const cp: CpEntry[] = new Array(cpCount);
  const cpOff = new Int32Array(cpCount);
  for (let i = 1; i < cpCount; i++) {
    cpOff[i] = p;
    const tag = b[p];
    p += 1;
    const e: CpEntry = { tag };
    cp[i] = e;
    if (tag === 1) {
      const l = b.readUInt16BE(p);
      p += 2;
      e.s = b.toString('utf8', p, p + l);
      p += l;
    } else if (tag === 3 || tag === 4) {
      p += 4;
    } else if (tag === 5 || tag === 6) {
      p += 8;
      i++;
    } else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) {
      e.a = b.readUInt16BE(p);
      p += 2;
    } else if (tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 17 || tag === 18) {
      e.a = b.readUInt16BE(p);
      e.b = b.readUInt16BE(p + 2);
      p += 4;
    } else if (tag === 15) {
      p += 3;
    } else {
      throw new Error(`未知常量池 tag ${tag}`);
    }
  }
  const utf8 = (i: number): string => (cp[i] && cp[i].tag === 1 ? (cp[i].s as string) : '');
  const className = (i: number): string => (cp[i] && cp[i].tag === 7 ? utf8(cp[i].a as number) : '');

  const thisClass = b.readUInt16BE(p + 2);
  const superClass = b.readUInt16BE(p + 4);
  p += 6;
  const ifaceCount = b.readUInt16BE(p);
  p += 2 + ifaceCount * 2;
  const fieldCount = b.readUInt16BE(p);
  p += 2 + fieldCount * 8;
  const methodCount = b.readUInt16BE(p);
  p += 2;

  const methods: MethodInfo[] = [];
  for (let mi = 0; mi < methodCount; mi++) {
    const access = b.readUInt16BE(p);
    const name = utf8(b.readUInt16BE(p + 2));
    const desc = utf8(b.readUInt16BE(p + 4));
    p += 6;
    const attrCount = b.readUInt16BE(p);
    p += 2;
    let code: { off: number; len: number } | null = null;
    for (let ai = 0; ai < attrCount; ai++) {
      const attrName = utf8(b.readUInt16BE(p));
      const attrLen = b.readUInt32BE(p + 2);
      const dataOff = p + 6;
      if (attrName === 'Code') {
        const codeLen = b.readUInt32BE(dataOff + 4);
        code = { off: dataOff + 8, len: codeLen };
      }
      p = dataOff + attrLen;
    }
    const m: MethodInfo = { access, name, desc, invokes: [] };
    if (code) {
      const codeBuf = b.subarray(code.off, code.off + code.len);
      for (let i = 0; i < codeBuf.length; ) {
        const op = codeBuf[i];
        const len = instrLen(codeBuf, i);
        if (op === 0xb6 || op === 0xb7 || op === 0xb8 || op === 0xb9) {
          m.invokes.push({ op, ref: codeBuf.readUInt16BE(i + 1) });
        }
        // ★ 2026-10-08：长度一律 ≥1（见 instrLen 头注释）—— 这里再钳一道，任何未来分支都不许原地打转
        i += len > 0 ? len : 1;
      }
    }
    methods.push(m);
  }
  const usage = new Map<number, Array<{ op: number; method: number }>>();
  methods.forEach((m, mi) => {
    for (const ins of m.invokes) {
      const list = usage.get(ins.ref) || [];
      list.push({ op: ins.op, method: mi });
      usage.set(ins.ref, list);
    }
  });

  return {
    buf: b,
    cp,
    cpOff,
    thisClass,
    superClass,
    name: className(thisClass),
    superName: className(superClass),
    methods,
    usage,
  };
}

// ---- 扫描与改写 ----

export interface SelfSuperCall {
  method: string;
  desc: string;
  /** 涉及改写的 Methodref 常量池下标 */
  refs: number[];
  /** 这些 Methodref 是否**只被本法体内**的 invokespecial 使用（被复用的无法就地改写） */
  clean: boolean;
  isPrivate: boolean;
}

export interface ClassFixNote {
  className: string;
  method: string;
  desc: string;
  superName: string;
  refs: number;
  /** 命中但因护栏跳过时的原因（改写成功则无此字段） */
  skippedReason?: string;
}

/** 找出「方法体里 invokespecial 指向本类同名同签名方法」的候选（只识别，不改写） */
export function scanSelfSuperCalls(info: ClassInfo): SelfSuperCall[] {
  const out: SelfSuperCall[] = [];
  for (let mi = 0; mi < info.methods.length; mi++) {
    const m = info.methods[mi];
    if (m.invokes.length === 0) continue;
    const refs = new Set<number>();
    for (const ins of m.invokes) {
      if (ins.op !== 0xb7) continue; // invokespecial
      const e = info.cp[ins.ref];
      if (!e || e.tag !== 10) continue; // Methodref
      if (e.a !== info.thisClass) continue; // owner 必须是本类
      const nat = info.cp[e.b as number];
      if (!nat || nat.tag !== 12) continue;
      const nName = (info.cp[nat.a as number] as CpEntry | undefined)?.s;
      const nDesc = (info.cp[nat.b as number] as CpEntry | undefined)?.s;
      if (nName !== m.name || nDesc !== m.desc) continue;
      refs.add(ins.ref);
    }
    if (refs.size === 0) continue;
    let clean = true;
    for (const r of refs) {
      const us = info.usage.get(r) || [];
      if (us.length === 0 || us.some((u) => u.op !== 0xb7 || u.method !== mi)) clean = false;
    }
    out.push({ method: m.name, desc: m.desc, refs: [...refs], clean, isPrivate: (m.access & 0x0002) !== 0 });
  }
  return out;
}

export interface PatchClassResult {
  /** 改写后的字节（无改写时 null） */
  bytes: Buffer | null;
  patched: number;
  notes: ClassFixNote[];
}

/**
 * 修补单个类的「自递归 invokespecial」（护栏与语义见文件头）。
 * @param declaredInSuper 祖先类链是否声明了该方法：true / false / null（解析不到 → 保守跳过）
 */
export function patchSelfSuperCallsInClass(
  input: Buffer,
  declaredInSuper: (superName: string, name: string, desc: string) => boolean | null,
): PatchClassResult {
  const info = parseClassBytes(input);
  const notes: ClassFixNote[] = [];
  let patched = 0;
  for (const hit of scanSelfSuperCalls(info)) {
    const base: ClassFixNote = {
      className: info.name,
      method: hit.method,
      desc: hit.desc,
      superName: info.superName,
      refs: hit.refs.length,
    };
    if (hit.method === '<init>' || hit.method === '<clinit>') {
      notes.push({ ...base, skippedReason: '构造器/类初始化器的自调用是合法委托（this(...)）' });
      continue;
    }
    if (hit.isPrivate) {
      notes.push({ ...base, skippedReason: 'private 方法的自调用是真递归，不是 invoke-super 残迹' });
      continue;
    }
    if (!hit.clean) {
      notes.push({ ...base, skippedReason: '该 Methodref 还被别的指令使用（无法就地改写）' });
      continue;
    }
    const declared = declaredInSuper(info.superName, hit.method, hit.desc);
    if (declared !== true) {
      notes.push({
        ...base,
        skippedReason: declared === null ? '祖先类解析不到（保守跳过）' : '超类链未声明该方法（不是 invoke-super）',
      });
      continue;
    }
    for (const ref of hit.refs) {
      // Methodref 布局：[tag(1B)][class_index(2B)][name_and_type_index(2B)] —— class 文件一律**大端**
      info.buf.writeUInt16BE(info.superClass, info.cpOff[ref] + 1);
    }
    patched += 1;
    notes.push(base);
  }
  return { bytes: patched > 0 ? info.buf : null, patched, notes };
}

// ---- 祖先类链解析（索引只读 zip 中央目录；class 字节按需解压并缓存）----

class HierarchyResolver {
  /** 类名 → jar 路径（本 jar 用 SELF 标记） */
  private readonly index = new Map<string, string>();
  private readonly infoCache = new Map<string, ClassInfo | null>();
  private readonly jarEntries = new Map<string, ZipEntryData[]>();

  constructor(private readonly selfEntries: ZipEntryData[], private readonly classpathJars: string[]) {
    for (const e of selfEntries) {
      if (!e.name.endsWith('.class')) continue;
      const cls = e.name.slice(0, -6);
      if (!this.index.has(cls)) this.index.set(cls, SELF);
    }
    this.jarEntries.set(SELF, selfEntries);
  }

  private entriesOf(jar: string): ZipEntryData[] {
    const cached = this.jarEntries.get(jar);
    if (cached) return cached;
    let out: ZipEntryData[] = [];
    try {
      out = readZipEntries(readFileSync(jar));
    } catch {
      /* 单个 jar 读不了不影响其它 */
    }
    for (const e of out) {
      if (!e.name.endsWith('.class')) continue;
      const cls = e.name.slice(0, -6);
      if (!this.index.has(cls)) this.index.set(cls, jar);
    }
    this.jarEntries.set(jar, out);
    return out;
  }

  private infoOf(clsName: string): ClassInfo | null {
    if (this.infoCache.has(clsName)) return this.infoCache.get(clsName) as ClassInfo | null;
    let info: ClassInfo | null = null;
    const from = this.index.get(clsName);
    if (from) {
      const bytes = this.entriesOf(from).find((x) => x.name === `${clsName}.class`)?.bytes;
      if (bytes) {
        try {
          info = parseClassBytes(bytes);
        } catch {
          info = null;
        }
      }
    }
    this.infoCache.set(clsName, info);
    return info;
  }

  /** 超类链上是否声明了 (name, desc)：true / false / null（解析不到 → 未知，保守跳过） */
  declares(superName: string, name: string, desc: string): boolean | null {
    for (const jar of this.classpathJars) this.entriesOf(jar); // 建立索引（只读中央目录 + 懒解压）
    let cls = superName;
    for (let depth = 0; depth < 12 && cls && cls !== 'java/lang/Object'; depth++) {
      const info = this.infoOf(cls);
      if (!info) return null;
      if (info.methods.some((m) => m.name === name && m.desc === desc)) return true;
      cls = info.superName;
    }
    return false;
  }
}

const SELF = '<self>';

export interface JarFixReport {
  patched: number;
  skipped: number;
  notes: ClassFixNote[];
}

/**
 * 修补整个转换产物的「自递归 invokespecial」。
 * @param jarBytes 转换产物 jar 的字节
 * @param classpathJars 额外 classpath（stubs.jar / libs/*.jar —— 蜘蛛基类多半在这些里）
 * @returns bytes=null 表示没有命中（无需重写 jar），否则为 deflate 重写后的 jar 字节
 */
export function fixSelfSuperCallsInJar(
  jarBytes: Buffer,
  classpathJars: string[],
): { bytes: Buffer | null; report: JarFixReport } {
  const entries = readZipEntries(jarBytes);
  const resolver = new HierarchyResolver(entries, classpathJars);
  const report: JarFixReport = { patched: 0, skipped: 0, notes: [] };
  const outEntries: ZipEntryData[] = [];
  let changed = false;
  for (const e of entries) {
    if (!e.name.endsWith('.class')) {
      outEntries.push(e);
      continue;
    }
    let res: PatchClassResult | null = null;
    try {
      res = patchSelfSuperCallsInClass(e.bytes, (s, n, d) => resolver.declares(s, n, d));
    } catch {
      res = null; // 单类解析失败：原样保留
    }
    if (res && res.bytes) {
      outEntries.push({ name: e.name, bytes: res.bytes });
      report.patched += res.patched;
      changed = true;
    } else {
      outEntries.push(e);
    }
    for (const n of res?.notes || []) {
      if (n.skippedReason) report.skipped += 1;
      report.notes.push(n);
    }
  }
  if (!changed) return { bytes: null, report };
  // 类文件用 deflate 压：dex2jar 产物按 store 写会让缓存膨胀到数倍
  return { bytes: buildZip(outEntries, { deflate: true }), report };
}

/** 文件级：就地修补转换产物（属于增强步骤 —— 失败只记日志，绝不让「能用的产物」变成失败） */
export function fixSelfSuperCallsInJarFile(
  jarPath: string,
  classpathJars: string[],
  log?: { i: (m: string) => void; w: (m: string) => void },
): void {
  try {
    const { bytes, report } = fixSelfSuperCallsInJar(readFileSync(jarPath), classpathJars);
    if (!bytes) return;
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(jarPath, bytes);
    const detail = report.notes
      .filter((n) => !n.skippedReason)
      .map((n) => `${n.className}.${n.method} → ${n.superName}`)
      .slice(0, 6)
      .join('；');
    log?.i(`jvm-bridge 已修补 ${report.patched} 处「super 调用被转成自递归」的字节码（否则调用即栈溢出）：${detail}`);
  } catch (e) {
    log?.w(`jvm-bridge 字节码修补失败（不影响普通 jar）: ${(e as Error).message}`);
  }
}