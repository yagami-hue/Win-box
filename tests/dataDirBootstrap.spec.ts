// tests/dataDirBootstrap.spec.ts
// ★ 2026-09-30：dataDirBootstrap 接线单测（mock electron）——
//   dev 不动 / 打包态切到安装目录/data 并迁移 / 目标不可写回退 / 迁移失败回滚 setPath 并保留旧目录。
//   模块是「import 即执行」，每个用例先 vi.resetModules() 再动态 import 拿全新实例。
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  isPackaged: false,
  userData: '',
  exe: '',
  setPathCalls: [] as Array<[string, string]>,
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged;
    },
    getPath: (name: string) => (name === 'userData' ? state.userData : state.exe),
    setPath: (name: string, p: string) => {
      state.setPathCalls.push([name, p]);
    },
  },
}));

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'datadir-boot-'));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  state.isPackaged = false;
  state.userData = '';
  state.exe = '';
  state.setPathCalls = [];
  delete process.env.PORTABLE_EXECUTABLE_DIR;
});

afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  dirs.length = 0;
});

async function importBootstrap() {
  vi.resetModules();
  return await import('../src/main/util/dataDirBootstrap');
}

describe('dataDirBootstrap — 启动接线', () => {
  it('开发态：不切换、不迁移（沿用系统默认位置）', async () => {
    const base = tmpDir();
    state.isPackaged = false;
    state.userData = join(base, 'appdata', 'win-box');
    state.exe = join(base, 'node_modules', 'electron.exe');
    const { dataDirReport } = await importBootstrap();
    expect(dataDirReport.mode).toBe('dev');
    expect(state.setPathCalls.length).toBe(0);
  });

  it('打包态：切到安装目录/data，老数据自动迁移（含旧目录清理）', async () => {
    const base = tmpDir();
    const legacy = join(base, 'appdata', 'win-box');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'user-config.json'), '{"version":2}');
    state.isPackaged = true;
    state.userData = legacy;
    state.exe = join(base, 'install', 'Win-Box.exe');
    const { dataDirReport } = await importBootstrap();
    expect(dataDirReport.mode).toBe('activated');
    expect(dataDirReport.target).toBe(join(base, 'install', 'data'));
    expect(state.setPathCalls).toEqual([['userData', join(base, 'install', 'data')]]);
    expect(existsSync(join(base, 'install', 'data', 'user-config.json'))).toBe(true);
    expect(existsSync(legacy)).toBe(false); // 旧 C 盘目录已清理
  });

  it('安装目录不可写：回退系统默认位置、不迁移、不动旧目录', async () => {
    const base = tmpDir();
    const legacy = join(base, 'appdata', 'win-box');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'user-config.json'), 'cfg');
    mkdirSync(join(base, 'install'), { recursive: true });
    writeFileSync(join(base, 'install', 'data'), 'occupied'); // 目标路径被同名文件占据 → 探测失败
    state.isPackaged = true;
    state.userData = legacy;
    state.exe = join(base, 'install', 'Win-Box.exe');
    const { dataDirReport } = await importBootstrap();
    expect(dataDirReport.mode).toBe('fallback');
    expect(state.setPathCalls.length).toBe(0); // 未切换
    expect(existsSync(join(legacy, 'user-config.json'))).toBe(true); // 旧数据原样
  });

  it('迁移失败：回滚 setPath 到旧目录、旧数据保留、下次启动重试', async () => {
    const base = tmpDir();
    const legacy = join(base, 'appdata', 'win-box');
    const target = join(base, 'install', 'data');
    mkdirSync(legacy, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(legacy, 'user-config.json'), 'cfg');
    mkdirSync(join(target, 'user-config.json'), { recursive: true }); // 同名目录 → 复制必失败
    state.isPackaged = true;
    state.userData = legacy;
    state.exe = join(base, 'install', 'Win-Box.exe');
    const { dataDirReport } = await importBootstrap();
    expect(dataDirReport.mode).toBe('fallback');
    // 先切到目标、失败后回滚到旧目录
    expect(state.setPathCalls).toEqual([
      ['userData', target],
      ['userData', legacy],
    ]);
    expect(existsSync(join(legacy, 'user-config.json'))).toBe(true);
    expect(dataDirReport.migration?.status).toBe('failed');
  });

  it('便携版：PORTABLE_EXECUTABLE_DIR 优先作为数据目录根', async () => {
    const base = tmpDir();
    const portableDir = join(base, 'usb', 'Win-Box');
    mkdirSync(portableDir, { recursive: true });
    state.isPackaged = true;
    state.userData = join(base, 'appdata', 'win-box');
    state.exe = join(base, 'temp-extract', 'Win-Box.exe'); // portable 运行时的临时解压目录
    process.env.PORTABLE_EXECUTABLE_DIR = portableDir;
    const { dataDirReport } = await importBootstrap();
    expect(dataDirReport.mode).toBe('activated');
    expect(dataDirReport.target).toBe(join(portableDir, 'data'));
  });
});