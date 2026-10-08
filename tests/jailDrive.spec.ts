// tests/jailDrive.spec.ts — 蜘蛛沙箱盘的纯函数（★ 2026-09-30 新增）
// 覆盖：subst 输出解析 / 空闲盘符挑选 / 复用-新建-放弃 三态决策 / 单测下不碰真实系统。
// （真机机制验证另见 .tmp/DriveProbe.java A/B：落点由**子进程 cwd** 决定，
//   `-Duser.dir` 只改路径串 —— cwd=V:\ 时 new File("/data/x") 才真正落进映射目标）
import { describe, it, expect } from 'vitest';
import {
  parseSubstList,
  pickJailDrive,
  planJailDrive,
  ensureJailDrive,
  jailSpawnCwd,
  JAIL_DRIVE_CANDIDATES,
} from '../src/engine/util/jailDrive';

describe('parseSubstList', () => {
  it('解析 subst 无参输出（多条 + 空行 + 噪声行）', () => {
    const out = [
      '',
      'V:\\: => E:\\WorkBuddy\\tvbox2\\tvbox-win\\.tmp\\jail-test',
      'X:\\: => D:\\winbox\\Win-Box\\data\\winbox-cache\\spider\\jail',
      '',
      '   ',
      'Invalid parameter - Y:',
    ].join('\r\n');
    expect(parseSubstList(out)).toEqual([
      { letter: 'V', target: 'E:\\WorkBuddy\\tvbox2\\tvbox-win\\.tmp\\jail-test' },
      { letter: 'X', target: 'D:\\winbox\\Win-Box\\data\\winbox-cache\\spider\\jail' },
    ]);
  });

  it('盘符统一大写；空输出得空数组', () => {
    expect(parseSubstList('v:\\: => E:\\a')).toEqual([{ letter: 'V', target: 'E:\\a' }]);
    expect(parseSubstList('')).toEqual([]);
    expect(parseSubstList(undefined as unknown as string)).toEqual([]);
  });
});

describe('pickJailDrive', () => {
  it('跳过已占用盘符，取最靠前的候选', () => {
    expect(pickJailDrive(['V'])).toBe('W');
    expect(pickJailDrive(['W', 'V'])).toBe('X');
    expect(pickJailDrive([])).toBe(JAIL_DRIVE_CANDIDATES[0]);
  });
  it('大小写不敏感', () => {
    expect(pickJailDrive(['v', 'w'])).toBe('X');
  });
  it('候选全占用 → 空串（调用方据此静默回退）', () => {
    expect(pickJailDrive([...JAIL_DRIVE_CANDIDATES])).toBe('');
  });
});

describe('planJailDrive', () => {
  const target = 'E:\\WorkBuddy\\tvbox2\\tvbox-win\\.tmp\\jail';

  it('已有指向同一目标的映射 → reuse（不重复建）', () => {
    const entries = [{ letter: 'V', target }];
    expect(planJailDrive(entries, target)).toEqual({ letter: 'V', action: 'reuse' });
  });

  it('目标比较忽略大小写与尾部反斜杠', () => {
    const entries = [{ letter: 'X', target: 'E:\\workbuddy\\TVBOX2\\tvbox-win\\.tmp\\jail\\' }];
    expect(planJailDrive(entries, target)).toEqual({ letter: 'X', action: 'reuse' });
  });

  it('没有匹配的映射 → create（避开 subst 已占字母与真实盘）', () => {
    const entries = [{ letter: 'V', target: 'E:\\other' }];
    expect(planJailDrive(entries, target, ['W'])).toEqual({ letter: 'X', action: 'create' });
  });

  it('全部候选被占（含真实盘探测结果）→ none', () => {
    const entries = [{ letter: 'V', target: 'E:\\other' }];
    const used = JAIL_DRIVE_CANDIDATES.filter((l) => l !== 'V');
    expect(planJailDrive(entries, target, used)).toEqual({ letter: '', action: 'none' });
  });
});

describe('ensureJailDrive / jailSpawnCwd', () => {
  it('单测（VITEST）下绝不碰真实系统：返回空串，调用方不传 cwd / 不加 -Duser.dir', () => {
    expect(ensureJailDrive('E:\\no-such-jail-dir')).toBe('');
    expect(jailSpawnCwd()).toBe('');
  });
});
