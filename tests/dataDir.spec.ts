// tests/dataDir.spec.ts
// ★ 2026-09-30：数据目录迁移（安装目录/data）单测 —— planDataDir / ensureWritableDir /
//   shouldSkipRel / migrateLegacy（moved / copied 跳过缓存 / 断点续传 / 失败保留旧目录 / 已有标记只清残留）。
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureWritableDir,
  markerPath,
  migrateLegacy,
  planDataDir,
  samePath,
  shouldSkipRel,
} from '../src/main/util/dataDir';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'datadir-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  dirs.length = 0;
});

describe('dataDir — planDataDir（目标目录决策）', () => {
  it('开发态：不切换（沿用系统默认位置）', () => {
    const p = planDataDir({ isPackaged: false, exePath: 'C:/dev/node_modules/electron/dist/electron.exe', defaultUserData: 'C:/Users/u/AppData/Roaming/win-box' });
    expect(p.activate).toBe(false);
    expect(p.target).toBe(p.legacy);
  });

  it('安装版：目标 = exe 所在目录/data', () => {
    const p = planDataDir({ isPackaged: true, exePath: 'D:/Games/Win-Box/Win-Box.exe', defaultUserData: 'C:/Users/u/AppData/Roaming/win-box' });
    expect(p.activate).toBe(true);
    expect(samePath(p.target, 'D:/Games/Win-Box/data')).toBe(true);
    expect(samePath(p.legacy, 'C:/Users/u/AppData/Roaming/win-box')).toBe(true);
  });

  it('便携版：优先 PORTABLE_EXECUTABLE_DIR（portable exe 真实所在目录，而非临时解压目录）', () => {
    const p = planDataDir({
      isPackaged: true,
      exePath: 'C:/Users/u/AppData/Local/Temp/abc123/Win-Box.exe',
      portableExecutableDir: 'E:/Tools/Win-Box',
      defaultUserData: 'C:/Users/u/AppData/Roaming/win-box',
    });
    expect(samePath(p.target, 'E:/Tools/Win-Box/data')).toBe(true);
  });
});

describe('dataDir — ensureWritableDir / shouldSkipRel', () => {
  it('可写目录：true（并清掉探针文件）', () => {
    const d = tmpDir();
    const target = join(d, 'data');
    expect(ensureWritableDir(target)).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(target, '.winbox-write-probe'))).toBe(false);
  });

  it('目标路径被同名文件占据：false（不抛异常）', () => {
    const d = tmpDir();
    const f = join(d, 'blocked');
    writeFileSync(f, 'x');
    expect(ensureWritableDir(f)).toBe(false);
  });

  it('跳过清单：Chromium 纯缓存 + winbox-cache/update 跳过；配置/状态/转换产物不跳过', () => {
    expect(shouldSkipRel('Cache')).toBe(true);
    expect(shouldSkipRel('Code Cache/x')).toBe(true);
    expect(shouldSkipRel('cache/data_0')).toBe(true); // 大小写不敏感
    expect(shouldSkipRel('blob_storage\\x')).toBe(true);
    expect(shouldSkipRel('winbox-cache/update/setup.exe')).toBe(true);
    expect(shouldSkipRel('winbox-cache/update')).toBe(true);
    expect(shouldSkipRel('winbox-cache/spider/converted/a.jar')).toBe(false);
    expect(shouldSkipRel('user-config.json')).toBe(false);
    expect(shouldSkipRel('Local Storage/leveldb/x')).toBe(false);
    expect(shouldSkipRel('Network/Cookies')).toBe(false);
  });
});

describe('dataDir — migrateLegacy（迁移主流程）', () => {
  it('旧目录不存在（全新安装）：no-legacy，不建标记', () => {
    const base = tmpDir();
    const out = migrateLegacy(join(base, 'nope'), join(base, 'data'));
    expect(out.status).toBe('no-legacy');
    expect(existsSync(markerPath(join(base, 'data')))).toBe(false);
  });

  it('同盘整目录移动（rename）：moved，旧目录消失、数据到位、写标记', () => {
    const base = tmpDir();
    const legacy = join(base, 'appdata-win-box');
    mkdirSync(join(legacy, 'logs'), { recursive: true });
    writeFileSync(join(legacy, 'user-config.json'), '{"version":2}');
    writeFileSync(join(legacy, 'logs', 'a.log'), 'hi');
    const target = join(base, 'install', 'data');
    const out = migrateLegacy(legacy, target);
    expect(out.status).toBe('moved');
    expect(out.cleanedLegacy).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(target, 'user-config.json'), 'utf-8')).toBe('{"version":2}');
    expect(existsSync(markerPath(target))).toBe(true);
  });

  it('跨盘复制（目标已存在）：跳过纯缓存、保留配置与转换产物、删旧目录', () => {
    const base = tmpDir();
    const legacy = join(base, 'legacy');
    mkdirSync(join(legacy, 'Cache'), { recursive: true });
    mkdirSync(join(legacy, 'Local Storage', 'leveldb'), { recursive: true });
    mkdirSync(join(legacy, 'winbox-cache', 'update'), { recursive: true });
    mkdirSync(join(legacy, 'winbox-cache', 'spider', 'converted'), { recursive: true });
    writeFileSync(join(legacy, 'Cache', 'big.bin'), 'x'.repeat(1024));
    writeFileSync(join(legacy, 'Local Storage', 'leveldb', 'state.ldb'), 'hist');
    writeFileSync(join(legacy, 'winbox-cache', 'update', 'setup.exe'), 'setup');
    writeFileSync(join(legacy, 'winbox-cache', 'spider', 'converted', 'a.jar'), 'jar');
    writeFileSync(join(legacy, 'user-config.json'), 'cfg');
    const target = join(base, 'install', 'data');
    mkdirSync(target, { recursive: true }); // 目标已存在 → 走复制而不是 rename
    const out = migrateLegacy(legacy, target);
    expect(out.status).toBe('copied');
    expect(out.cleanedLegacy).toBe(true);
    // 配置 / Chromium 状态 / 转换产物 → 已迁移
    expect(readFileSync(join(target, 'user-config.json'), 'utf-8')).toBe('cfg');
    expect(readFileSync(join(target, 'Local Storage', 'leveldb', 'state.ldb'), 'utf-8')).toBe('hist');
    expect(readFileSync(join(target, 'winbox-cache', 'spider', 'converted', 'a.jar'), 'utf-8')).toBe('jar');
    // 纯缓存 → 不迁移（旧目录整体删除即等于清理）
    expect(existsSync(join(target, 'Cache'))).toBe(false);
    expect(existsSync(join(target, 'winbox-cache', 'update'))).toBe(false);
    expect(out.skipped).toBeGreaterThanOrEqual(2);
    expect(existsSync(legacy)).toBe(false);
  });

  it('断点续传：目标已存在同尺寸文件 → 跳过（内容不被覆盖）', () => {
    const base = tmpDir();
    const legacy = join(base, 'legacy');
    const target = join(base, 'install', 'data');
    mkdirSync(legacy, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(legacy, 'user-config.json'), 'AAAA'); // 4 字节
    writeFileSync(join(target, 'user-config.json'), 'BBBB'); // 同尺寸（预置的半成品）
    const out = migrateLegacy(legacy, target);
    expect(out.status).toBe('copied');
    expect(readFileSync(join(target, 'user-config.json'), 'utf-8')).toBe('BBBB'); // 未被覆盖
  });

  it('复制失败：failed、不写标记、旧目录保留（下次启动重试）', () => {
    const base = tmpDir();
    const legacy = join(base, 'legacy');
    const target = join(base, 'install', 'data');
    mkdirSync(legacy, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(legacy, 'user-config.json'), 'cfg');
    mkdirSync(join(target, 'user-config.json'), { recursive: true }); // 同名目录 → copyFileSync 必失败
    const out = migrateLegacy(legacy, target);
    expect(out.status).toBe('failed');
    expect(existsSync(markerPath(target))).toBe(false);
    expect(existsSync(join(legacy, 'user-config.json'))).toBe(true);
    expect(out.cleanedLegacy).toBe(false);
  });

  it('已有迁移标记：只清理旧目录残留（already）', () => {
    const base = tmpDir();
    const legacy = join(base, 'legacy');
    const target = join(base, 'install', 'data');
    mkdirSync(legacy, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(legacy, 'user-config.json'), 'old');
    writeFileSync(markerPath(target), '{"migratedFrom":"x"}');
    const out = migrateLegacy(legacy, target);
    expect(out.status).toBe('already');
    expect(out.cleanedLegacy).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(target, 'user-config.json'))).toBe(false); // 不再二次复制
  });

  it('相同路径：直接 no-legacy（不发生任何动作）', () => {
    const base = tmpDir();
    const d = join(base, 'same');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'x.txt'), 'keep');
    const out = migrateLegacy(d, d);
    expect(out.status).toBe('no-legacy');
    expect(existsSync(join(d, 'x.txt'))).toBe(true);
  });
});