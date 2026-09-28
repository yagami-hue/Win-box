// tests/importProfileName.spec.ts
// ★ 2026-09-27（用户要求）：导入订阅时可自填**订阅名** —— 填了就用它命名档案，
//   留空才退回既有自动命名「新订阅 xx」（新增订阅仍会把旧档案改名「旧订阅 xx」）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    app: {
      // 每个用例换一个 userData 目录（见 beforeEach）——档案会持久化，共用目录会互相串数据
      getPath: () =>
        ((globalThis as unknown as { __shostDir?: string }).__shostDir ??= fs.mkdtempSync(
          path.join(os.tmpdir(), 'shost-import-name-'),
        )),
      isPackaged: false,
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf8'),
      decryptString: (b: Buffer) => Buffer.from(b).toString('utf8'),
    },
  };
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpiderHost } from '../src/main/spider/SpiderHost';
import { nameFromLocalFile } from '../src/main/util/importNaming';

const g = globalThis as unknown as { __shostDir?: string };

beforeEach(() => {
  g.__shostDir = mkdtempSync(join(tmpdir(), 'shost-import-name-'));
});

afterEach(() => {
  if (g.__shostDir) rmSync(g.__shostDir, { recursive: true, force: true });
  g.__shostDir = undefined;
});

/** 最小可解析订阅（1 个源） */
function cfg(key: string): string {
  return JSON.stringify({ sites: [{ key, name: key, type: 0, api: 'https://x/api.php/provide/vod' }] });
}

function activeName(host: SpiderHost): string {
  const id = host.cfgSnapshot().activeProfileId;
  return host.cfgProfiles().find((p) => p.id === id)?.name ?? '';
}

describe('导入订阅的档案命名（★ 用户自填名优先）', () => {
  it('首次导入 + 自填名 → 档案直接用自填名（不再是「新订阅 xx」）', async () => {
    const host = new SpiderHost();
    await host.importConfig({ json: cfg('a'), name: '我的影视仓' });
    expect(activeName(host)).toBe('我的影视仓');
  });

  it('首次导入 + 留空 → 退回自动命名「新订阅 xx」', async () => {
    const host = new SpiderHost();
    await host.importConfig({ json: cfg('a') });
    expect(activeName(host)).toMatch(/^新订阅 /);
  });

  it('再次导入（不同来源）+ 自填名 → 旧档案「旧订阅 xx」+ 新档案用自填名', async () => {
    const host = new SpiderHost();
    await host.importConfig({ json: cfg('a') });
    await host.importConfig({ json: cfg('b'), name: '第二个订阅' });
    const names = host.cfgProfiles().map((p) => p.name);
    expect(names).toHaveLength(2);
    expect(names.some((n) => /^旧订阅 /.test(n))).toBe(true);
    expect(activeName(host)).toBe('第二个订阅');
  });

  it('同来源刷新（snapshot:false）+ 自填名 → 就地改名，不新建档案', async () => {
    const host = new SpiderHost();
    await host.importConfig({ json: cfg('a') });
    const before = host.cfgProfiles().length;
    await host.importConfig({ json: cfg('a2'), name: '改过名的' }, { snapshot: false });
    expect(host.cfgProfiles()).toHaveLength(before);
    expect(activeName(host)).toBe('改过名的');
  });

  it('同来源刷新留空 → 档案名保持原样（不得被「新订阅 xx」覆盖）', async () => {
    const host = new SpiderHost();
    await host.importConfig({ json: cfg('a'), name: '保留名' });
    await host.importConfig({ json: cfg('a2') }, { snapshot: false });
    expect(activeName(host)).toBe('保留名');
  });
});

describe('nameFromLocalFile — 本地文件导入的默认命名（★ 原始文件名）', () => {
  it('.json / .py 都取原始文件名（去扩展名）', () => {
    expect(nameFromLocalFile('D:\\订阅\\我的影视仓.json')).toBe('我的影视仓');
    expect(nameFromLocalFile('E:/spider/掘金.py')).toBe('掘金');
  });

  it('自填名优先于文件名', () => {
    expect(nameFromLocalFile('D:\\订阅\\旧名.json', '新名字')).toBe('新名字');
    expect(nameFromLocalFile('D:\\订阅\\旧名.json', '   ')).toBe('旧名');
  });

  it('含点号的名称只去最后一个扩展名；无扩展名/异常输入兜底', () => {
    expect(nameFromLocalFile('我的配置.v2.json')).toBe('我的配置.v2');
    expect(nameFromLocalFile('无扩展名')).toBe('无扩展名');
    expect(nameFromLocalFile('')).toBe('');
  });
});