// tests/classFix.spec.ts
// ★ 2026-09-30：dex2jar 的「super 调用被转成自递归 invokespecial」修补（见 src/engine/spider/classFix.ts）。
//
// 事故背景：DEX 的 `invoke-super {p0}, L<当前类>;->m(...)`（源码 `super.m(...)`）被转成
//   `invokespecial <当前类>.m` ⇒ JVM 解析到方法自身 ⇒ 无限递归 ⇒ StackOverflowError。
//   实测潇洒订阅（sun.json）全局 jar 的 `com.github.catvod.spider.Pan.init` 一处命中，
//   导致 MiPan/PanSou/Baiku/KuLe/… 整族盘搜蜘蛛「进源即崩、搜都搜不出来」。
//
// 本测试用**手工构造的最小 class 文件**（不依赖任何真实 jar）覆盖：
//   命中改写 + 四类护栏（private / 构造器 / 超类未声明 / 引用被复用）+ jar 级重写。
import { describe, it, expect } from 'vitest';
import {
  parseClassBytes,
  scanSelfSuperCalls,
  patchSelfSuperCallsInClass,
  fixSelfSuperCallsInJar,
  instrLen,
} from '../src/engine/spider/classFix';
import { buildZip, readZipEntries } from '../src/engine/util/syncZip';

// ---- 极简 class 写入器（只为构造测试桩类）----

interface MethodSpec {
  name: string;
  desc: string;
  access?: number;
  /** 返回指令字节；入参 selfRef(name, desc) = 取「本类 → name/desc」的 Methodref 常量池下标 */
  code?: (selfRef: (n: string, d: string) => number, cp: CpWriter) => number[];
}

/** 常量池写入器（Interned：同键复用同一下标） */
class CpWriter {
  private readonly entries: Buffer[] = [];
  private readonly idx = new Map<string, number>();

  private push(key: string, buf: Buffer): number {
    const hit = this.idx.get(key);
    if (hit !== undefined) return hit;
    this.entries.push(buf);
    const i = this.entries.length; // 常量池下标从 1 起
    this.idx.set(key, i);
    return i;
  }

  utf8(s: string): number {
    const b = Buffer.from(s, 'utf8');
    const buf = Buffer.alloc(3 + b.length);
    buf.writeUInt8(1, 0);
    buf.writeUInt16BE(b.length, 1);
    b.copy(buf, 3);
    return this.push(`u:${s}`, buf);
  }

  clazz(name: string): number {
    const n = this.utf8(name);
    const buf = Buffer.alloc(3);
    buf.writeUInt8(7, 0);
    buf.writeUInt16BE(n, 1);
    return this.push(`c:${name}`, buf);
  }

  nameAndType(name: string, desc: string): number {
    const n = this.utf8(name);
    const d = this.utf8(desc);
    const buf = Buffer.alloc(5);
    buf.writeUInt8(12, 0);
    buf.writeUInt16BE(n, 1);
    buf.writeUInt16BE(d, 3);
    return this.push(`n:${name}${desc}`, buf);
  }

  methodRef(owner: string, name: string, desc: string): number {
    const c = this.clazz(owner);
    const nt = this.nameAndType(name, desc);
    const buf = Buffer.alloc(5);
    buf.writeUInt8(10, 0);
    buf.writeUInt16BE(c, 1);
    buf.writeUInt16BE(nt, 3);
    return this.push(`m:${owner}.${name}${desc}`, buf);
  }

  /** 序列化：cp_count = entries + 1（下标 0 保留） */
  build(): { count: number; bytes: Buffer } {
    return { count: this.entries.length + 1, bytes: Buffer.concat(this.entries) };
  }
}

/** 构造一个最小 class：`name extends superName`，附带若干方法（可选 Code） */
function makeClass(name: string, superName: string, methods: MethodSpec[]): Buffer {
  const cp = new CpWriter();
  const thisIdx = cp.clazz(name);
  const superIdx = cp.clazz(superName);
  const codeAttrName = cp.utf8('Code');

  // 先解析各方法的引用（常量池下标随写随定），再写方法体
  const prepared = methods.map((m) => {
    const codeBytes = m.code
      ? m.code((n, d) => cp.methodRef(name, n, d), cp)
      : null;
    const nameIdx = cp.utf8(m.name);
    const descIdx = cp.utf8(m.desc);
    return { m, codeBytes, nameIdx, descIdx };
  });

  const { count, bytes: cpBytes } = cp.build();
  const parts: Buffer[] = [];
  const head = Buffer.alloc(8);
  head.writeUInt32BE(0xcafebabe, 0);
  head.writeUInt16BE(0, 4); // minor
  head.writeUInt16BE(52, 6); // major（Java 8）
  parts.push(head);
  const cnt = Buffer.alloc(2);
  cnt.writeUInt16BE(count, 0);
  parts.push(cnt, cpBytes);

  const fixed = Buffer.alloc(8);
  fixed.writeUInt16BE(0x0021, 0); // public super
  fixed.writeUInt16BE(thisIdx, 2);
  fixed.writeUInt16BE(superIdx, 4);
  fixed.writeUInt16BE(0, 6); // interfaces_count
  parts.push(fixed);
  const fields = Buffer.alloc(2);
  fields.writeUInt16BE(0, 0); // fields_count
  parts.push(fields);

  const methodCount = Buffer.alloc(2);
  methodCount.writeUInt16BE(prepared.length, 0);
  parts.push(methodCount);
  for (const { m, codeBytes, nameIdx, descIdx } of prepared) {
    const h = Buffer.alloc(8);
    h.writeUInt16BE(m.access ?? 0x0001, 0); // 默认 public
    h.writeUInt16BE(nameIdx, 2);
    h.writeUInt16BE(descIdx, 4);
    h.writeUInt16BE(codeBytes ? 1 : 0, 6); // attributes_count
    parts.push(h);
    if (codeBytes) {
      const payloadLen = 2 + 2 + 4 + codeBytes.length + 2 + 2; // max_stack/max_locals/code_len/code/exc/attrs
      const attr = Buffer.alloc(2 + 4 + payloadLen);
      let p = 0;
      attr.writeUInt16BE(codeAttrName, p);
      p += 2;
      attr.writeUInt32BE(payloadLen, p);
      p += 4;
      attr.writeUInt16BE(4, p); // max_stack
      p += 2;
      attr.writeUInt16BE(2, p); // max_locals
      p += 2;
      attr.writeUInt32BE(codeBytes.length, p);
      p += 4;
      Buffer.from(codeBytes).copy(attr, p);
      p += codeBytes.length;
      attr.writeUInt16BE(0, p); // exception_table_length
      p += 2;
      attr.writeUInt16BE(0, p); // attribute_count
      parts.push(attr);
    }
  }
  const classAttrs = Buffer.alloc(2);
  classAttrs.writeUInt16BE(0, 0);
  parts.push(classAttrs);
  return Buffer.concat(parts);
}

/** 取 Methodref 的 owner 类名（校验改写结果用：Methodref → Class → Utf8） */
function refOwnerOf(classBytes: Buffer, methodRefAt: number): string {
  const info = parseClassBytes(classBytes);
  const mref = info.cp[methodRefAt];
  const cls = info.cp[mref.a as number];
  const name = cls && typeof cls.a === 'number' ? info.cp[cls.a] : undefined;
  return name && typeof name.s === 'string' ? name.s : '';
}

describe('scanSelfSuperCalls — 识别「自递归 invokespecial」', () => {
  it('invokespecial 指向本类同名同签名方法 → 命中且 clean', () => {
    const bytes = makeClass('A', 'S', [
      { name: 'init', desc: '(Landroid/content/Context;Ljava/lang/String;)V', code: (selfRef) => [0x2a, 0xb7, 0, 0, 0xb1].map((v, i) => (i === 2 ? selfRef('init', '(Landroid/content/Context;Ljava/lang/String;)V') >> 8 : i === 3 ? selfRef('init', '(Landroid/content/Context;Ljava/lang/String;)V') & 0xff : v)) },
    ]);
    const info = parseClassBytes(bytes);
    const hits = scanSelfSuperCalls(info);
    expect(hits).toHaveLength(1);
    expect(hits[0].method).toBe('init');
    expect(hits[0].clean).toBe(true);
    expect(hits[0].isPrivate).toBe(false);
  });

  it('invokevirtual / 指向别的类 / 不同签名 → 不命中', () => {
    const bytes = makeClass('A', 'S', [
      {
        name: 'm',
        desc: '()V',
        code: (selfRef, cp) => {
          const other = cp.methodRef('B', 'm', '()V'); // 别的类
          const diff = selfRef('m', '(I)V'); // 不同签名
          return [0x2a, 0xb7, other >> 8, other & 0xff, 0x2a, 0xb7, diff >> 8, diff & 0xff, 0x2a, 0xb6, 0, 1, 0xb1];
        },
      },
    ]);
    const info = parseClassBytes(bytes);
    expect(scanSelfSuperCalls(info)).toHaveLength(0);
  });
});

describe('patchSelfSuperCallsInClass — 改写与护栏', () => {
  const declaresYes = (): boolean => true;
  const declaresNo = (): boolean => false;
  const declaresUnknown = (): null => null;

  it('命中：owner 就地改写成 super_class（语义 = super.m(...)）', () => {
    const selfDesc = '()V';
    let refIdx = 0;
    const bytes = makeClass('Pan', 'Spider', [
      {
        name: 'init',
        desc: selfDesc,
        code: (selfRef) => {
          refIdx = selfRef('init', selfDesc);
          return [0x2a, 0xb7, refIdx >> 8, refIdx & 0xff, 0xb1];
        },
      },
    ]);
    const res = patchSelfSuperCallsInClass(bytes, declaresYes);
    expect(res.patched).toBe(1);
    expect(res.bytes).not.toBeNull();
    expect(refOwnerOf(res.bytes as Buffer, refIdx)).toBe('Spider');
    // 改写后不再被识别为「自递归」
    expect(scanSelfSuperCalls(parseClassBytes(res.bytes as Buffer))).toHaveLength(0);
    // 入参不被修改（内部在副本上操作）
    expect(refOwnerOf(bytes, refIdx)).toBe('Pan');
  });

  it('护栏：private 方法不改（真递归）', () => {
    const bytes = makeClass('A', 'S', [
      { name: 'f', desc: '(I)I', access: 0x0002, code: (selfRef) => [0x1a, 0xb7, selfRef('f', '(I)I') >> 8, selfRef('f', '(I)I') & 0xff, 0x1a, 0xac] },
    ]);
    const res = patchSelfSuperCallsInClass(bytes, declaresYes);
    expect(res.patched).toBe(0);
    expect(res.notes[0].skippedReason).toContain('private');
  });

  it('护栏：构造器委托 <init> 不改', () => {
    const bytes = makeClass('A', 'S', [
      { name: '<init>', desc: '(I)V', code: (selfRef) => [0x2a, 0xb7, selfRef('<init>', '(I)V') >> 8, selfRef('<init>', '(I)V') & 0xff, 0xb1] },
    ]);
    const res = patchSelfSuperCallsInClass(bytes, declaresYes);
    expect(res.patched).toBe(0);
    expect(res.notes[0].skippedReason).toContain('this(...)');
  });

  it('护栏：超类链未声明 / 解析不到 → 不改（不是 invoke-super）', () => {
    const mk = () =>
      makeClass('A', 'S', [{ name: 'm', desc: '()V', code: (selfRef) => [0x2a, 0xb7, selfRef('m', '()V') >> 8, selfRef('m', '()V') & 0xff, 0xb1] }]);
    expect(patchSelfSuperCallsInClass(mk(), declaresNo).patched).toBe(0);
    expect(patchSelfSuperCallsInClass(mk(), declaresNo).notes[0].skippedReason).toContain('超类链未声明');
    expect(patchSelfSuperCallsInClass(mk(), declaresUnknown).patched).toBe(0);
    expect(patchSelfSuperCallsInClass(mk(), declaresUnknown).notes[0].skippedReason).toContain('解析不到');
  });

  it('护栏：同一 Methodref 被别的方法复用 → 不改（就地改写会连带改错）', () => {
    // A.m()V 自调用；A.n()V 里也 invokespecial A.m()V（同一常量池项）
    const bytes = makeClass('A', 'S', [
      { name: 'm', desc: '()V', code: (selfRef) => [0x2a, 0xb7, selfRef('m', '()V') >> 8, selfRef('m', '()V') & 0xff, 0xb1] },
      { name: 'n', desc: '()V', code: (selfRef) => [0x2a, 0xb7, selfRef('m', '()V') >> 8, selfRef('m', '()V') & 0xff, 0xb1] },
    ]);
    const res = patchSelfSuperCallsInClass(bytes, declaresYes);
    expect(res.patched).toBe(0);
    expect(res.notes.some((n) => n.skippedReason && n.skippedReason.includes('Methodref'))).toBe(true);
  });
});

describe('fixSelfSuperCallsInJar — jar 级（含超类链解析）', () => {
  it('同 jar 内的超类声明了该方法 → 改写；未命中时返回 null（无需重写）', () => {
    // S.m()V 存在 → A.init 的 super 调用可解析
    const s = makeClass('S', 'java/lang/Object', [{ name: 'init', desc: '()V', code: () => [0xb1] }]);
    const badA = makeClass('A', 'S', [{ name: 'init', desc: '()V', code: (selfRef) => [0x2a, 0xb7, selfRef('init', '()V') >> 8, selfRef('init', '()V') & 0xff, 0xb1] }]);
    const goodB = makeClass('B', 'S', [{ name: 'go', desc: '()V', code: () => [0xb1] }]);
    const jar = buildZip([
      { name: 'S.class', bytes: s },
      { name: 'A.class', bytes: badA },
      { name: 'B.class', bytes: goodB },
    ]);
    const { bytes, report } = fixSelfSuperCallsInJar(jar, []);
    expect(report.patched).toBe(1);
    expect(report.notes[0].className).toBe('A');
    expect(bytes).not.toBeNull();
    // 所有条目都在（含未改的 B / 超类 S），且 A 已改写
    const out = readZipEntries(bytes as Buffer);
    expect(out.map((e) => e.name).sort()).toEqual(['A.class', 'B.class', 'S.class']);
    const aOut = out.find((e) => e.name === 'A.class')!.bytes;
    expect(scanSelfSuperCalls(parseClassBytes(aOut))).toHaveLength(0);

    // 没有命中的 jar → 返回 null（不重写、不膨胀）
    const clean = buildZip([{ name: 'B.class', bytes: goodB }]);
    expect(fixSelfSuperCallsInJar(clean, []).bytes).toBeNull();
  });

  it('超类不在本 jar 且 classpath 未提供 → 保守不改（解析不到）', () => {
    const badA = makeClass('A', 'S', [{ name: 'm', desc: '()V', code: (selfRef) => [0x2a, 0xb7, selfRef('m', '()V') >> 8, selfRef('m', '()V') & 0xff, 0xb1] }]);
    const jar = buildZip([{ name: 'A.class', bytes: badA }]);
    const { bytes, report } = fixSelfSuperCallsInJar(jar, []);
    expect(bytes).toBeNull();
    expect(report.patched).toBe(0);
    expect(report.skipped).toBe(1);
  });
});

describe('instrLen — 指令长度表（tableswitch / wide 特判）', () => {
  it('tableswitch 按 pad + 12 + 4*n 计算', () => {
    // opcode 在偏移 0：1(op) + 3(pad) + 12(默认值/lo/hi) + 2 项(8) = 24
    const code = Buffer.alloc(64);
    code[0] = 0xaa;
    code.writeInt32BE(0, 4); // default
    code.writeInt32BE(1, 8); // low
    code.writeInt32BE(2, 12); // high
    expect(instrLen(code, 0)).toBe(24);
  });

  it('lookupswitch 与 wide iinc', () => {
    const code = Buffer.alloc(64);
    code[0] = 0xab;
    code.writeInt32BE(0, 4);
    code.writeInt32BE(3, 8); // npairs=3 → 1 + 3(pad) + 8 + 24 = 36
    expect(instrLen(code, 0)).toBe(36);
    const wide = Buffer.from([0xc4, 0x84, 0, 0, 0, 0]); // wide iinc = 6
    expect(instrLen(wide, 0)).toBe(6);
  });

  // ★★ 2026-10-08（用户报「打开就卡死/闪退」的真根因）：畸形/错位字节码里
  //   `tableswitch` 的 hi < lo、`lookupswitch` 的 npairs < 0 会算出**负数长度** ——
  //   调用方 `i += len` 原地打转（负跳后又被逐字节推回原处）⇒ **死循环**。
  //   实测：某 227KB 混淆类（merge/A/f1.class）在 auto-dex2jar 产物里必现；
  //   而这条链跑在主进程（jar 收编 → classFix）⇒ 整个应用冻结，且收编永远完不成
  //   ⇒ 每次启动都在同一处卡死（用户侧看到的就是「崩溃/闪退」）。
  //   口径：长度**恒 ≥ 1**（宁可漏修，绝不卡死）。
  it('畸形 tableswitch（hi < lo）→ 长度钳到 ≥1（旧实现返回负数 ⇒ 扫描死循环）', () => {
    const code = Buffer.alloc(64);
    code[0] = 0xaa;
    code.writeInt32BE(0, 4); // default
    code.writeInt32BE(100, 8); // low
    code.writeInt32BE(3, 12); // high < low
    expect(instrLen(code, 0)).toBeGreaterThanOrEqual(1);
  });

  it('畸形 lookupswitch（npairs < 0）→ 长度钳到 ≥1', () => {
    const code = Buffer.alloc(64);
    code[0] = 0xab;
    code.writeInt32BE(0, 4); // default
    code.writeInt32BE(-5, 8); // npairs 负值
    expect(instrLen(code, 0)).toBeGreaterThanOrEqual(1);
  });

  it('含畸形 switch 的方法体：parseClassBytes 必须终止（回归：旧实现在此死循环）', () => {
    // 方法体 = [畸形 tableswitch(hi<lo), return]。若长度钳制失效，本用例会一直转圈到超时失败。
    const badSwitch = Buffer.alloc(16);
    badSwitch[0] = 0xaa;
    badSwitch.writeInt32BE(0, 4);
    badSwitch.writeInt32BE(100, 8);
    badSwitch.writeInt32BE(3, 12);
    const bytes = makeClass('A', 'S', [{ name: 'm', desc: '()V', code: () => [...badSwitch, 0xb1] }]);
    const info = parseClassBytes(bytes);
    expect(info.methods).toHaveLength(1);
  }, 5000);
});