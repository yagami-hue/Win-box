// tests/userConfigManager.spec.ts
// UserConfigManager 单测（任务 B5）：真实 JsonStore 落在临时目录文件上。
// 覆盖：add/delete/move/update/setActive/persist-reload 往返、非法 patch、损坏 JSON 重建、
//      重复 key 拒绝、move 边界、replaceFromImport 全量替换。
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/main/store/JsonStore';
import { UserConfigManager, USER_CONFIG_KEY } from '../src/main/store/UserConfigManager';
import { NullLogger } from '../src/engine/util/logger';
import type { SiteConfig, SourceBean, SourceUpdatePatch } from '../src/shared/types';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ucm-'));
  dirs.push(d);
  return d;
}

function bean(key: string, type = 0, api = 'https://x/api.php/provide/vod'): SourceBean {
  return { key, name: key, type, api } as SourceBean;
}

function newManager(dir: string): UserConfigManager {
  const store = new JsonStore(join(dir, 'user-config.json'));
  return new UserConfigManager(store, NullLogger);
}

function fullConfig(sources: SourceBean[]): SiteConfig {
  return {
    sites: sources,
    parses: [],
    lives: [],
    flags: [],
    spider: 'https://x/global.jar',
    jarCache: 'true',
    danmaku: '',
    wallpaper: '',
    hosts: {},
    rules: [],
    doh: [],
    ads: [],
    proxy: [],
  };
}

afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  dirs.length = 0;
});

describe('UserConfigManager — 增删改排序与选中', () => {
  it('addSource 后 snapshot 有序返回；重复 key 拒绝并抛中文错', () => {
    const m = newManager(tmpDir());
    m.addSource(bean('a'));
    m.addSource(bean('b'));
    expect(m.sources().map((s) => s.key)).toEqual(['a', 'b']);
    expect(() => m.addSource(bean('a'))).toThrow(/已存在/);
  });

  it('addSource 会经 parseSite 归一化：缺 api → 拒绝', () => {
    const m = newManager(tmpDir());
    expect(() => m.addSource({ key: 'x', type: 0 } as SourceBean)).toThrow(/校验失败|缺少必填/);
  });

  it('deleteSource 删除；删到当前选中源时清空 activeSourceKey', () => {
    const m = newManager(tmpDir());
    m.addSource(bean('a'));
    m.addSource(bean('b'));
    m.setActiveSource('b');
    expect(m.activeSourceKey()).toBe('b');
    m.deleteSource('b');
    expect(m.activeSourceKey()).toBe('');
    expect(m.sources().map((s) => s.key)).toEqual(['a']);
  });

  it('moveSource：up/down/top/bottom 排序正确；边界 no-op 不抛', () => {
    const m = newManager(tmpDir());
    m.addSource(bean('a'));
    m.addSource(bean('b'));
    m.addSource(bean('c'));
    m.moveSource('c', 'top');
    expect(m.sources().map((s) => s.key)).toEqual(['c', 'a', 'b']);
    m.moveSource('c', 'down');
    expect(m.sources().map((s) => s.key)).toEqual(['a', 'c', 'b']);
    m.moveSource('b', 'bottom');
    expect(m.sources().map((s) => s.key)).toEqual(['a', 'c', 'b']);
    m.moveSource('a', 'up'); // 已在顶部 → no-op
    expect(m.sources().map((s) => s.key)).toEqual(['a', 'c', 'b']);
    m.moveSource('missing', 'up'); // 不存在 → no-op
    m.moveSource('a', 'down');
    expect(m.sources().map((s) => s.key)).toEqual(['c', 'a', 'b']);
  });

  it('updateSource：只改白名单字段；key/type/api 不可改（抛）', () => {
    const m = newManager(tmpDir());
    m.addSource(bean('a', 0));
    m.updateSource('a', { name: '改名', timeout: 30, searchable: 0 } as SourceUpdatePatch);
    const s = m.sources()[0];
    expect(s.name).toBe('改名');
    expect(s.timeout).toBe(30);
    expect(s.searchable).toBe(0);
    expect(() => m.updateSource('a', { key: 'b' } as SourceUpdatePatch)).toThrow(/不可修改/);
    expect(() => m.updateSource('a', { type: 1 } as SourceUpdatePatch)).toThrow(/不可修改/);
    expect(() => m.updateSource('a', { api: 'https://x/other' } as SourceUpdatePatch)).toThrow(/不可修改/);
  });

  it('setActiveSource：存在才生效；不存在忽略', () => {
    const m = newManager(tmpDir());
    m.addSource(bean('a'));
    m.setActiveSource('a');
    expect(m.activeSourceKey()).toBe('a');
    m.setActiveSource('nope');
    expect(m.activeSourceKey()).toBe('a');
  });

  it('setActiveLiveIndex 越界 clamp；lives 为空 → 0', () => {
    const m = newManager(tmpDir());
    m.setActiveLiveIndex(99);
    expect(m.activeLiveIndex()).toBe(0);
    m.replaceFromImport(fullConfig([]), '');
  });
});

describe('UserConfigManager — replaceFromImport 全量替换', () => {
  it('sources/lives/global 被替换；active 源消失则清空', () => {
    const m = newManager(tmpDir());
    m.addSource(bean('old'));
    m.setActiveSource('old');
    const cfg = fullConfig([bean('n1'), bean('n2', 1, 'https://x2/vod.json')]);
    cfg.lives = [{ name: '线路1', api: 'https://x/live.m3u', type: '0', url: '', jar: '', ext: '', epg: '', playerType: '', timeout: 15 }];
    m.replaceFromImport(cfg, 'https://sub.example/config.json');
    expect(m.activeSourceKey()).toBe('');
    expect(m.sources().map((s) => s.key)).toEqual(['n1', 'n2']);
    expect(m.lives().length).toBe(1);
    expect(m.snapshot().apiUrl).toBe('https://sub.example/config.json');
    expect(m.snapshot().global.spider).toBe('https://x/global.jar');
  });
});

describe('UserConfigManager — parses（解析接口）持久化', () => {
  it('replaceFromImport 保存 parses（滤掉合成超级解析）；重载后仍在；档案切换可恢复', () => {
    const dir = tmpDir();
    const cfg = fullConfig([bean('p1')]);
    cfg.parses = [
      { name: '超级解析', url: 'http://127.0.0.1:9978/jiexi?url=', ext: '', type: 4 },
      { name: 'jx1', url: 'https://jx.example/?url=', ext: '', type: 0 },
      { name: 'jx2', url: 'https://jx2.example/api', ext: '', type: 1 },
    ];
    const m = newManager(dir);
    m.replaceFromImport(cfg, 'https://sub.example/c.json');
    // 合成的 type=4 不落库（避免往返时被 parseParses 反复 unshift 出重复项）
    expect(m.snapshot().parses.map((p) => p.name)).toEqual(['jx1', 'jx2']);

    const m2 = newManager(dir);
    expect(m2.load()).toBe(true);
    expect(m2.snapshot().parses.map((p) => p.name)).toEqual(['jx1', 'jx2']);

    // 切走再切回：档案 JSON 里也带着 parses（可离线重建）
    const m3 = newManager(dir);
    m3.load();
    const first = m3.profiles()[0].id;
    m3.saveAsProfile('临时');
    m3.activateProfile(first);
    expect(m3.snapshot().parses.map((p) => p.name)).toEqual(['jx1', 'jx2']);
  });
});

describe('UserConfigManager — 持久化往返与损坏恢复', () => {
  it('变更即写盘：新 manager 实例 load 后恢复同源列表与选中源', () => {
    const dir = tmpDir();
    const m1 = newManager(dir);
    m1.addSource(bean('a'));
    m1.addSource(bean('b'));
    m1.updateSource('a', { name: 'A源' });
    m1.moveSource('b', 'top');
    m1.setActiveSource('b');

    const m2 = newManager(dir);
    expect(m2.load()).toBe(true);
    expect(m2.sources().map((s) => [s.key, s.name])).toEqual([['b', 'b'], ['a', 'A源']]);
    expect(m2.activeSourceKey()).toBe('b');
  });

  it('整文件 JSON 损坏：备份 .corrupt-* 后用默认空档重建（不静默丢数据）', () => {
    const dir = tmpDir();
    const file = join(dir, 'user-config.json');
    writeFileSync(file, '{ 这不是合法 JSON !!', 'utf-8');

    const store = new JsonStore(file);
    expect(store.corrupted).toBe(true);
    const backups = readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    expect(backups.length).toBe(1);

    const m = newManager(dir);
    expect(m.load()).toBe(false); // 损坏后重建为空档
    expect(m.sources()).toEqual([]);

    // 重建路径可用：addSource 后写回新文件，再 reload 能读到
    m.addSource(bean('reborn'));
    const m2 = newManager(dir);
    expect(m2.load()).toBe(true);
    expect(m2.sources()[0].key).toBe('reborn');
  });

  it('未持久化过：load() 返回 false，sources 为空', () => {
    const dir = tmpDir();
    const m = newManager(dir);
    expect(m.load()).toBe(false);
    expect(m.sources()).toEqual([]);
  });

  it('坏 source 条目在 load 时被剔除并可用 parseSite 校验日志说明', () => {
    const dir = tmpDir();
    const m = newManager(dir);
    m.addSource(bean('good'));
    // 手动在 store 里塞一条缺 api 的坏源
    const store = new JsonStore(join(dir, 'user-config.json'));
    const snap = store.getObject<{ sources: unknown[] }>(USER_CONFIG_KEY, { sources: [] });
    snap.sources.push({ key: 'bad', type: 0 });
    store.setObject(USER_CONFIG_KEY, snap as never);
    store.flush();

    const m2 = newManager(dir);
    expect(m2.load()).toBe(true);
    expect(m2.sources().map((s) => s.key)).toEqual(['good']);
  });
});

describe('UserConfigManager v2 — 多配置档案（profiles）', () => {
  it('导入（URL）自动建档；存为新档案可离线切换；激活后恢复源列表', () => {
    const dir = tmpDir();
    const m = newManager(dir);
    const cfgA = fullConfig([bean('a1'), bean('a2')]);
    m.replaceFromImport(cfgA, 'https://host/a.json');
    expect(m.activeProfileId()).not.toBe('');
    expect(m.profiles().length).toBe(1);
    expect(m.sources().length).toBe(2);

    // 存 B 档案（当前仍是 A 的内容；saveAsProfile 会把当前状态快照成新档案）
    const pb = m.saveAsProfile('配置B');
    expect(m.activeProfileId()).toBe(pb.id);
    expect(m.profiles().length).toBe(2);

    // 切换回 A：A 的 json 是导入时存下的 a1/a2
    const aId = m.profiles()[0].id;
    m.activateProfile(aId);
    expect(m.activeProfileId()).toBe(aId);
    expect(m.sources().map((s) => s.key)).toEqual(['a1', 'a2']);
  });

  it('重载后档案与选中源恢复（重启等价）', () => {
    const dir = tmpDir();
    const m = newManager(dir);
    m.replaceFromImport(fullConfig([bean('x1'), bean('x2')]), 'https://h/x.json');
    const x1 = m.sources()[0];
    m.setActiveSource(x1.key);
    m.saveAsProfile('二次配置'); // active 移到新档案
    m.activateProfile(m.profiles()[0].id);
    m.setActiveSource('x1');

    const m2 = newManager(dir);
    expect(m2.load()).toBe(true);
    expect(m2.profiles().length).toBe(2);
    expect(m2.activeSourceKey()).toBe('x1');
    m2.activateProfile(m2.profiles()[1].id);
    expect(m2.sources().map((s) => s.key)).toEqual(['x1', 'x2']);
  });

  it('删除当前生效档案被拒绝；切走后可删', () => {
    const dir = tmpDir();
    const m = newManager(dir);
    m.replaceFromImport(fullConfig([bean('p1')]), 'https://h/p.json');
    const pa = m.activeProfileId();
    expect(() => m.deleteProfile(pa)).toThrow(/当前生效/);
    m.saveAsProfile('另一个');
    const other = m.profiles().find((p) => p.id !== pa)!;
    m.deleteProfile(pa); // 现在 active=另一个，可删 A
    expect(m.profiles().some((p) => p.id === pa)).toBe(false);
    expect(m.profiles().length).toBe(1);
  });
});
