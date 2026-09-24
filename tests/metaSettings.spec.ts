// tests/metaSettings.spec.ts
// 元数据来源配置单测：默认值 / DPAPI 加解密落盘 / 「仅 TMDB 需用户 Key」口径（normalizeMetaSettings）。
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetaSettingsStore } from '../src/main/meta/MetaSettings';
import { JsonStore } from '../src/main/store/JsonStore';
import { NullLogger } from '../src/engine/util/logger';
import { DEFAULT_META_SETTINGS, normalizeMetaSettings, metaUsesTmdb } from '../src/shared/meta';
import type { DriveCodec } from '../src/main/store/DriveStore';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'metacfg-'));
  dirs.push(d);
  return d;
}
function fakeCodec(): DriveCodec {
  return {
    encode: (s: string) => 'enc:' + Buffer.from(s).toString('base64'),
    decode: (stored: string) => (stored.startsWith('enc:') ? Buffer.from(stored.slice(4), 'base64').toString('utf8') : stored),
  };
}

describe('normalizeMetaSettings（「仅 TMDB」必须自填 API）', () => {
  it('未填用户 Key + 仅 TMDB → 自动回落「全走」', () => {
    expect(normalizeMetaSettings({ ...DEFAULT_META_SETTINGS, metaSource: 'tmdb' }).metaSource).toBe('auto');
  });
  it('已填用户 Key + 仅 TMDB → 原样保留（去掉首尾空白后判断）', () => {
    expect(normalizeMetaSettings({ ...DEFAULT_META_SETTINGS, metaSource: 'tmdb', tmdbApiKey: '  abc123  ' }).metaSource).toBe('tmdb');
  });
  it('其它策略不受影响', () => {
    for (const s of ['auto', 'douban', 'search'] as const) {
      expect(normalizeMetaSettings({ ...DEFAULT_META_SETTINGS, metaSource: s }).metaSource).toBe(s);
    }
  });
  it('metaUsesTmdb：auto/tmdb 走 TMDB，douban/search 不走', () => {
    expect(metaUsesTmdb('auto')).toBe(true);
    expect(metaUsesTmdb('tmdb')).toBe(true);
    expect(metaUsesTmdb('douban')).toBe(false);
    expect(metaUsesTmdb('search')).toBe(false);
  });
});

describe('MetaSettingsStore', () => {
  it('默认值：空 Key/代理/镜像 + strategy=auto', () => {
    const dir = tmpDir();
    const s = new MetaSettingsStore(join(dir, 'meta-settings.json'), NullLogger);
    expect(s.settings).toEqual(DEFAULT_META_SETTINGS);
  });
  it('用户 Key 落盘为密文、读取回明文（与 assrt token 同机制）', () => {
    const dir = tmpDir();
    const s = new MetaSettingsStore(join(dir, 'meta-settings.json'), NullLogger, fakeCodec());
    s.update({ tmdbApiKey: 'my-secret-key', tmdbApiBase: 'https://mirror.example.com/3', metaSource: 'tmdb' });
    const raw = new JsonStore(join(dir, 'meta-settings.json')).getObject<Record<string, unknown>>('settings', {});
    expect(String(raw.tmdbApiKey).startsWith('enc:')).toBe(true);
    expect(String(raw.tmdbApiKey)).not.toContain('my-secret-key');
    expect(raw.tmdbApiBase).toBe('https://mirror.example.com/3');
    expect(s.settings.tmdbApiKey).toBe('my-secret-key');
    expect(s.settings.metaSource).toBe('tmdb');
  });
  it('解密失败 → Key 置空（不把乱码当 Key 用）', () => {
    const dir = tmpDir();
    const store = new JsonStore(join(dir, 'meta-settings.json'));
    store.setObject('settings', { tmdbApiKey: 'enc:%%%bad%%%' });
    store.flush();
    const s = new MetaSettingsStore(join(dir, 'meta-settings.json'), NullLogger, {
      encode: (x: string) => x,
      decode: () => null,
    });
    expect(s.settings.tmdbApiKey).toBe('');
  });
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});