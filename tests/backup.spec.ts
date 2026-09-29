// tests/backup.spec.ts
// 设置备份纯函数单测：组装 / 解析校验 / 还原（UserConfigManager.restore 整份替换）。
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBackupFile, parseBackupFile, pickStrings } from '../src/main/settings/backup';
import { BACKUP_KIND, BACKUP_VERSION, type BackupSettingsState } from '../src/shared/backup';
import { DEFAULT_SUBTITLE_SETTINGS } from '../src/shared/subtitle';
import { DEFAULT_DANMAKU_SETTINGS } from '../src/shared/danmaku';
import { DEFAULT_PLAYER_SETTINGS } from '../src/shared/player';
import { JsonStore } from '../src/main/store/JsonStore';
import { UserConfigManager, emptyUserConfig } from '../src/main/store/UserConfigManager';
import { NullLogger } from '../src/engine/util/logger';
import type { SourceBean, UserConfig } from '../src/shared/types';

function settingsFixture(): BackupSettingsState {
  return {
    userConfig: {
      ...emptyUserConfig(),
      sources: [{ key: 'a', name: 'A', type: 0, api: 'https://x/api.php/provide/vod' } as SourceBean],
      ui: { activeSourceKey: 'a', activeLiveIndex: 3 },
    },
    driveTokens: { quark: '__pus=1;__puus=2' },
    subtitle: { ...DEFAULT_SUBTITLE_SETTINGS, assrtToken: 'assrt-token', enabled: true },
    metaSettings: { tmdbApiKey: 'key-123', tmdbApiBase: '', tmdbImageBase: '', metaSource: 'auto' },
    danmaku: { ...DEFAULT_DANMAKU_SETTINGS, enabled: false },
    player: { ...DEFAULT_PLAYER_SETTINGS, m3u8Purify: true },
    proxy: { enabled: true, url: 'http://127.0.0.1:7890' },
    bossKey: { enabled: true, accel: 'CommandOrControl+Shift+B' },
  };
}

const META = { exportedAt: '2026-09-29T12:00:00.000Z', appVersion: '1.12.0' };

describe('pickStrings', () => {
  it('只保留字符串值（数组/对象/数字丢弃）', () => {
    expect(pickStrings({ a: '1', b: 2, c: null, d: ['x'], e: { k: 'v' } })).toEqual({ a: '1' });
    expect(pickStrings(null)).toEqual({});
    expect(pickStrings(['x'])).toEqual({});
  });
});

describe('buildBackupFile', () => {
  it('组装完整备份（含 kind/version/导出时间/应用版本）', () => {
    const f = buildBackupFile(settingsFixture(), { tvboxUiMemory: '{"history":[]}' }, META);
    expect(f).toMatchObject({ app: 'win-box', kind: BACKUP_KIND, version: BACKUP_VERSION, ...META });
    expect(f.settings.driveTokens.quark).toContain('__puus');
    expect(f.renderer).toEqual({ tvboxUiMemory: '{"history":[]}' });
  });
});

describe('parseBackupFile', () => {
  it('自家导出的文件可往返解析', () => {
    const f = buildBackupFile(settingsFixture(), { k: 'v' }, META);
    const r = parseBackupFile(JSON.stringify(f));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.file.settings.userConfig.sources).toHaveLength(1);
      expect(r.file.renderer).toEqual({ k: 'v' });
      expect(r.file.appVersion).toBe('1.12.0');
    }
  });

  it('非 JSON / 非对象 / 错 kind / 版本非法 / 版本过高 / 缺 settings → 中文原因', () => {
    const bad = (text: string) => {
      const r = parseBackupFile(text);
      expect(r.ok).toBe(false);
      return r.ok ? '' : r.error;
    };
    expect(bad('not json')).toContain('JSON');
    expect(bad('[1,2]')).toContain('JSON 对象');
    expect(bad('{"kind":"other"}')).toContain('kind');
    expect(bad(`{"kind":"${BACKUP_KIND}"}`)).toContain('版本号');
    expect(bad(`{"kind":"${BACKUP_KIND}","version":${BACKUP_VERSION + 1}}`)).toContain('升级软件');
    expect(bad(`{"kind":"${BACKUP_KIND}","version":1}`)).toContain('缺少设置内容');
  });

  it('renderer 缺省/含非字符串项 → 归一为空或只留字符串', () => {
    const f = buildBackupFile(settingsFixture(), {}, META);
    const noRenderer = JSON.parse(JSON.stringify(f)) as Record<string, unknown>;
    delete noRenderer.renderer;
    const r1 = parseBackupFile(JSON.stringify(noRenderer));
    expect(r1.ok && r1.file.renderer).toEqual({});

    const mixed = JSON.parse(JSON.stringify(f)) as Record<string, unknown>;
    mixed.renderer = { a: 'x', b: 3 };
    const r2 = parseBackupFile(JSON.stringify(mixed));
    expect(r2.ok && r2.file.renderer).toEqual({ a: 'x' });
  });
});

describe('UserConfigManager.restore', () => {
  it('整份替换（源/界面选中/档案原样还原）并落盘可再读', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-'));
    try {
      const file = join(dir, 'user-config.json');
      const m = new UserConfigManager(new JsonStore(file), NullLogger);
      m.load();
      m.restore({
        ...emptyUserConfig(),
        sources: [
          { key: 'k1', name: 'K1', type: 0, api: 'https://a/api' } as SourceBean,
          { key: 'k2', name: 'K2', type: 0, api: 'https://b/api' } as SourceBean,
        ],
        ui: { activeSourceKey: 'k2', activeLiveIndex: 0 },
      } as UserConfig);
      expect(m.sources().map((s) => s.key)).toEqual(['k1', 'k2']);
      expect(m.activeSourceKey()).toBe('k2');

      // 重新读盘 → 还原内容已持久化
      const m2 = new UserConfigManager(new JsonStore(file), NullLogger);
      m2.load();
      expect(m2.sources().map((s) => s.key)).toEqual(['k1', 'k2']);
      expect(m2.activeSourceKey()).toBe('k2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('还原时剔除坏源、非法 activeSourceKey 归零', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-'));
    try {
      const m = new UserConfigManager(new JsonStore(join(dir, 'user-config.json')), NullLogger);
      m.load();
      m.restore({
        ...emptyUserConfig(),
        sources: [{ key: '', name: 'bad' } as SourceBean],
        ui: { activeSourceKey: 'nope', activeLiveIndex: 0 },
      } as UserConfig);
      expect(m.sources()).toHaveLength(0);
      expect(m.activeSourceKey()).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
