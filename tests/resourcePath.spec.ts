// tests/resourcePath.spec.ts
// ★ portable(单文件) 资源路径回归护栏。
//
// 事故背景：portable 的 NSIS 解压脚本把内容放在 $PLUGINSDIR\7z-out 下
// （见 app-builder-lib extractAppPackage.nsh → extractUsing7za），
// 而 process.resourcesPath 少一层 7z-out。原先写死单一路径 →
// existsSync(java.exe)=false → 报「JRE 缺失」，JVM 源全部不可用。
//
// 这里锁住：四种真实布局都能被候选项命中。
import { describe, it, expect } from 'vitest';
import { resourceRootCandidates, pickResourceRoot } from '../src/main/util/resolveResources';

const WIN = process.platform === 'win32';
/** 路径大小写/分隔符不敏感比较（Windows） */
const eq = (a: string, b: string): boolean =>
  WIN ? a.toLowerCase().replace(/\\/g, '/') === b.toLowerCase().replace(/\\/g, '/') : a === b;

describe('resourceRootCandidates — 布局覆盖', () => {
  it('开发态 → <repo>/resources（dist 与 resources 同级）', () => {
    const c = resourceRootCandidates({
      packaged: false,
      dirname: 'E:/repo/dist',
    });
    expect(c.some((p) => eq(p, 'E:/repo/resources'))).toBe(true);
  });

  it('NSIS 安装 / --dir → <root>/resources/app.asar.unpacked/resources', () => {
    const c = resourceRootCandidates({
      packaged: true,
      resourcesPath: 'C:/app/resources',
      exeDir: 'C:/app',
    });
    expect(
      c.some((p) => eq(p, 'C:/app/resources/app.asar.unpacked/resources')),
    ).toBe(true);
  });

  it('★ portable：resourcesPath 停在 <tmp>\\resources 时，能命中 7z-out 真实根', () => {
    const tmp = 'C:/Users/u/AppData/Local/Temp/nso8227.tmp';
    const c = resourceRootCandidates({
      packaged: true,
      // 实测 resourcesPath（外层，缺 7z-out）
      resourcesPath: `${tmp}/resources`,
      exeDir: `${tmp}/7z-out`,
    });
    const want = `${tmp}/7z-out/resources/app.asar.unpacked/resources`;
    expect(c.some((p) => eq(p, want))).toBe(true);
  });

  it('portable 变体：resourcesPath 直接是 <tmp> 时同样能命中', () => {
    const tmp = 'C:/Users/u/AppData/Local/Temp/nso8227.tmp';
    const c = resourceRootCandidates({
      packaged: true,
      resourcesPath: tmp,
      exeDir: `${tmp}/7z-out`,
    });
    const want = `${tmp}/7z-out/resources/app.asar.unpacked/resources`;
    expect(c.some((p) => eq(p, want))).toBe(true);
  });
});

describe('pickResourceRoot — 选择行为', () => {
  it('返回第一个存在的候选（模拟 portable 真实布局）', () => {
    const tmp = 'C:/tmp/nso8227.tmp';
    const want = `${tmp}/7z-out/resources/app.asar.unpacked/resources`;
    const picked = pickResourceRoot(
      {
        packaged: true,
        resourcesPath: `${tmp}/resources`,
        exeDir: `${tmp}/7z-out`,
      },
      (p) => eq(p, want), // 只有真实根"存在"
    );
    expect(eq(picked, want)).toBe(true);
  });

  it('全部不存在时回退首选路径（不抛错，保留原错误形态）', () => {
    const ctx = { packaged: true, resourcesPath: 'C:/app/resources', exeDir: 'C:/app' };
    const cands = resourceRootCandidates(ctx);
    const picked = pickResourceRoot(ctx, () => false);
    expect(picked).toBe(cands[0]);
  });

  it('候选列表无重复项', () => {
    const c = resourceRootCandidates({
      packaged: true,
      resourcesPath: 'C:/tmp/x.tmp/resources',
      exeDir: 'C:/tmp/x.tmp/7z-out',
    });
    expect(new Set(c).size).toBe(c.length);
  });
});
