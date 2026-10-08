// src/engine/util/jailDrive.ts
// ★ 2026-09-30：「蜘蛛越界写盘」的容器化重定向 —— 把 `<盘符>:\data\…` 收进**数据目录**。
//
// 背景（真机取证，勿删）：
//   第三方 jar（打壳源、以及硬编码安卓路径的源）会往**安卓绝对路径**写文件。实测两类：
//     · `/data/data/com.winbox/cache[/code_cache]/sharedb/config.db`
//       —— 来宾路径来自我们桥接层的 EnvJni 常量（`config.db` 打开是 `PK\x03\x04`，即壳解密出的 zip 载荷）；
//     · `/data/user/0/com.fongmi.android.oktv/cache/hg_cenc_cache`
//       —— jar 里硬编码的 TVBox 安卓应用目录。
//
// ★★ 机制的关键（`.tmp/PathProbe.java` + `.tmp/DriveProbe.java` A/B 实测，勿凭直觉改回 ★★
//   Java 的 `new File("/data/x")`（**不带盘符**的根绝对路径）在 Windows 上是 drive-relative：
//     · `getAbsolutePath()` 只是在串前面拼 `user.dir`（**纯字符串**，不代表真实落点）；
//     · 真正落盘走的是 native 侧 `GetFullPathNameW(原始串)` —— 它按**进程当前目录所在的盘**解析
//       → `<当前盘>:\data\x`。
//   所以**只传 `-Duser.dir=<V>:\` 没用**（实测：cwd 在 E 盘时照样落到 `E:\data\…`）；
//   **必须把子进程的 cwd 设到那个盘上**：
//     · cwd = `E:\…`（工程目录） + `-Duser.dir=V:\` → 真实写入 `E:\data\…`   ✗
//     · cwd = `V:\`（subst 盘根）                        → 真实写入 `V:\data\…` = 映射目标内 ✓
//
// 机制（唯一不改 unidbg 桥路径层、又能搬进数据目录的做法）：
//   `subst` 建一个虚拟盘（根 = `<数据目录>\spider-jail`），spawn 蜘蛛 JVM 时同时：
//     · `cwd = <V>:\`      ← 决定「无盘符根路径」真实落在哪个盘（**必须**）
//     · `-Duser.dir=<V>:\` ← 让 Java 侧打印/存储的路径串与真实落点一致（**保持**）
//   于是 `/data/…` ⇒ `<数据目录>\spider-jail\data\…`。
//
// 失败语义：无空闲盘符 / subst 不可用 / 目标不可写 …一律**静默回退**（保持原行为，只留一行告警），
//   绝不能让蜘蛛因这个"清理动作"变得不可用。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import type { Logger } from '../../shared/types';

/** 候选盘符：只用靠后的字母，避开 C/D（系统盘/常见数据盘）等常用盘符 */
export const JAIL_DRIVE_CANDIDATES = ['V', 'W', 'X', 'Y', 'Z', 'U', 'T', 'S'];

/** 容器目录名（置于数据目录下；一眼看出是「蜘蛛越界写入」，可整体删除） */
export const JAIL_DIR_NAME = 'spider-jail';

export interface SubstEntry {
  letter: string;
  target: string;
}

/** 解析 `subst` 无参输出（每行 `V:\: => E:\path`） */
export function parseSubstList(out: string): SubstEntry[] {
  const list: SubstEntry[] = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]):\\:\s*=>\s*(.+?)\s*$/.exec(line);
    if (m) list.push({ letter: m[1].toUpperCase(), target: m[2] });
  }
  return list;
}

/** 选一个空闲盘符（候选全被占用 → 空串） */
export function pickJailDrive(used: string[]): string {
  const set = new Set((used || []).map((l) => String(l).toUpperCase()));
  for (const c of JAIL_DRIVE_CANDIDATES) if (!set.has(c)) return c;
  return '';
}

export interface JailPlan {
  letter: string;
  /** reuse = 已有指向同一目标的映射；create = 需要新建；none = 没戏（无空闲盘符） */
  action: 'reuse' | 'create' | 'none';
}

/**
 * 决策：已存在指向**同一目标**的 subst 映射 → 复用；
 * 否则挑一个既不是 subst 映射、也不是真实/网络盘符的空闲字母 → 新建；
 * 都没有 → none（调用方静默回退）。
 * @param entries `subst` 现有映射
 * @param used   其它已占用盘符（真实盘 / 网络盘；由调用方用 existsSync 探测后传入）
 */
export function planJailDrive(entries: SubstEntry[], target: string, used: string[] = []): JailPlan {
  const t = String(target || '').replace(/[\\/]+$/, '').toLowerCase();
  for (const e of entries) {
    if (String(e.target || '').replace(/[\\/]+$/, '').toLowerCase() === t) {
      return { letter: e.letter, action: 'reuse' };
    }
  }
  const letter = pickJailDrive([...(entries || []).map((e) => e.letter), ...used]);
  return letter ? { letter, action: 'create' } : { letter: '', action: 'none' };
}

/** 探测哪些盘符已被占用（真实盘 / 网络盘 / 光驱）—— subst 建映射前必须先避开 */
export function probeUsedLetters(candidates: string[] = JAIL_DRIVE_CANDIDATES): string[] {
  return candidates.filter((l) => {
    try {
      return existsSync(`${l}:\\`);
    } catch {
      return false;
    }
  });
}

function runSubst(args: string[]): string {
  return execFileSync('subst', args, { windowsHide: true, encoding: 'utf8', timeout: 10_000 });
}

/** 模块级缓存：一次会话只建一次映射。`null` = 尚未尝试；`''` = 已判定失败（不再重试） */
let jailRoot: string | null = null;
let jailLetter = '';

/**
 * 确保「蜘蛛沙箱盘」就绪，返回该盘根（形如 `V:\`）；失败返回空串。
 * 返回值的两个用途（**缺一不可**，见头注释的 A/B 实测）：
 *   ① 作为 `spawn(..., { cwd })`  —— 决定「无盘符根路径」真实落在哪个盘；
 *   ② 作为 `-Duser.dir` 参数      —— 让 Java 侧路径串与真实落点一致。
 * @param targetDir 映射目标（通常是 `<数据目录>/spider-jail`）
 */
export function ensureJailDrive(targetDir: string, logger?: Logger): string {
  if (jailRoot !== null) return jailRoot;
  jailRoot = '';
  if (process.platform !== 'win32') return jailRoot;
  // ★ 单测不碰真实系统（与 SpiderProcPool.poolEnabled 同口径）：避免测试里真的建 subst 映射，
  //   也保证 argv 断言与机器上已有盘符无关（确定性）。
  if (process.env.VITEST) return jailRoot;
  try {
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    const plan = planJailDrive(parseSubstList(runSubst([])), targetDir, probeUsedLetters());
    if (plan.action === 'none') {
      logger?.w?.(`${JAIL_DIR_NAME}: 无空闲盘符可用，蜘蛛的安卓绝对路径写入仍会落在系统盘根目录`);
      return jailRoot;
    }
    if (plan.action === 'create') runSubst([`${plan.letter}:`, targetDir]);
    jailLetter = plan.letter;
    jailRoot = `${plan.letter}:\\`;
    logger?.i?.(`${JAIL_DIR_NAME}: 蜘蛛沙箱盘 ${jailRoot} → ${targetDir}（JVM 以它为 cwd，安卓绝对路径 /data/… 收进数据目录）`);
  } catch (e) {
    logger?.w?.(`${JAIL_DIR_NAME}: 建映射失败，回退原行为（${e instanceof Error ? e.message : String(e)}）`);
  }
  return jailRoot;
}

/**
 * spawn 蜘蛛 JVM 时要用的 cwd（= 沙箱盘根；未就绪时空串 → 调用方不传 `cwd`，行为与历史一致）。
 * ★ 这是把 `/data/…` 收进数据目录的**决定性**参数：只传 `-Duser.dir` 改不动真实落点。
 */
export function jailSpawnCwd(): string {
  return jailRoot ?? '';
}

/** 退出时解除映射（幂等；失败无所谓 —— subst 映射重启后本就不存在） */
export function releaseJailDrive(logger?: Logger): void {
  if (!jailLetter) return;
  try {
    runSubst([`${jailLetter}:`, '/D']);
  } catch (e) {
    logger?.w?.(`${JAIL_DIR_NAME}: 解除映射失败（可忽略）${e instanceof Error ? e.message : String(e)}`);
  }
  jailLetter = '';
  jailRoot = null;
}
