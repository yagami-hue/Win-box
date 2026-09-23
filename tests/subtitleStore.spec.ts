// tests/subtitleStore.spec.ts
// SubtitleStore 单测：assrt token 加解密落盘（S1 修复）+ 偏好合并 + 旧明文无损迁移。
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubtitleStore } from '../src/main/subtitle/SubtitleStore';
import { JsonStore } from '../src/main/store/JsonStore';
import { NullLogger } from '../src/engine/util/logger';
import type { DriveCodec } from '../src/main/store/DriveStore';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'subtitle-'));
  dirs.push(d);
  return d;
}

function fakeCodec(): DriveCodec {
  return {
    encode(s: string): string {
      return 'enc:' + Buffer.from(s).toString('base64');
    },
    decode(stored: string): string | null {
      if (!stored.startsWith('enc:')) return stored; // 旧明文透传
      const b64 = stored.slice(4);
      // 模拟真实 safeStorage：非法密文（非标准 base64）抛错 → null
      if (!/^[A-Za-z0-9+/=\r\n]+$/.test(b64)) return null;
      try {
        return Buffer.from(b64, 'base64').toString('utf8');
      } catch {
        return null;
      }
    },
  };
}

function readRaw(dir: string): Record<string, unknown> {
  const store = new JsonStore(join(dir, 'subtitle.json'));
  return (store.getObject('settings', {}) as Record<string, unknown>) || {};
}

describe('SubtitleStore', () => {
  it('写入 assrtToken 时落盘为密文（enc: 前缀），读取回明文', () => {
    const dir = tmpDir();
    const s = new SubtitleStore(join(dir, 'subtitle.json'), NullLogger, fakeCodec());
    s.update({ assrtToken: 'secret-token-123', enabled: true });
    const raw = readRaw(dir);
    expect(String(raw.assrtToken).startsWith('enc:')).toBe(true);
    expect(String(raw.assrtToken)).not.toContain('secret-token-123');
    expect(s.settings.assrtToken).toBe('secret-token-123');
    expect(s.settings.enabled).toBe(true);
  });

  it('旧明文 token 无损迁移：读到明文并透传（不丢）', () => {
    const dir = tmpDir();
    // 直接落盘旧版本明文形态（模拟旧版未加密的 subtitle.json）
    const store = new JsonStore(join(dir, 'subtitle.json'));
    store.setObject('settings', { enabled: true, assrtToken: 'legacy-plain' });
    store.flush();
    // ★ 先落盘再构造 SubtitleStore（JsonStore 为内存态，新实例需重新 load 才看得到）
    const s = new SubtitleStore(join(dir, 'subtitle.json'), NullLogger, fakeCodec());
    expect(s.settings.assrtToken).toBe('legacy-plain');
    // 迁移后再次写入应以密文落盘（不再明文）
    s.update({ fontSize: 22 });
    const raw = readRaw(dir);
    expect(String(raw.assrtToken).startsWith('enc:')).toBe(true);
    expect(String(raw.assrtToken)).not.toContain('legacy-plain');
  });

  it('解密失败 → token 置空并提示（不把乱码当 token 用）', () => {
    const dir = tmpDir();
    const store = new JsonStore(join(dir, 'subtitle.json'));
    store.setObject('settings', { enabled: false, assrtToken: 'enc:%%%invalid%%%' });
    store.flush();
    // ★ 先落盘再构造 SubtitleStore（JsonStore 为内存态，新实例需重新 load 才看得到）
    const s = new SubtitleStore(join(dir, 'subtitle.json'), NullLogger, fakeCodec());
    expect(s.settings.assrtToken).toBe('');
  });

  it('无 codec（单测/无 Electron 场景）保持明文', () => {
    const dir = tmpDir();
    const s = new SubtitleStore(join(dir, 'subtitle.json'), NullLogger);
    s.update({ assrtToken: 'plain-no-codec' });
    const raw = readRaw(dir);
    expect(raw.assrtToken).toBe('plain-no-codec');
    expect(s.settings.assrtToken).toBe('plain-no-codec');
  });

  it('更新偏好不丢 token：update({fontSize}) 后 token 仍可读', () => {
    const dir = tmpDir();
    const s = new SubtitleStore(join(dir, 'subtitle.json'), NullLogger, fakeCodec());
    s.update({ assrtToken: 'tk', fontSize: 20 });
    s.update({ fontSize: 26 });
    expect(s.settings.assrtToken).toBe('tk');
    expect(s.settings.fontSize).toBe(26);
  });
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});