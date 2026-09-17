// src/main/util/resolveResources.ts
// ★ 纯逻辑：资源根目录候选路径计算（不 import electron，便于单测）。
//
// 背景（2026-09-10 第五轮 bug）：
//   portable 单文件的 NSIS 解压脚本（app-builder-lib / templates/nsis/include/
//   extractAppPackage.nsh → extractUsing7za）执行的是：
//       CreateDirectory "$PLUGINSDIR\7z-out"
//       SetOutPath     "$PLUGINSDIR\7z-out"
//       Nsis7z::Extract "$PLUGINSDIR\app-64.7z"
//       CopyFiles /SILENT "$PLUGINSDIR\7z-out\*" $OUTDIR
//   实测应用最终从 `...\<name>.tmp\7z-out\` 启动，资源位于
//       `...\<name>.tmp\7z-out\resources\app.asar.unpacked\resources`
//   但 Electron 的 process.resourcesPath 只给到
//       `...\<name>.tmp\resources`（少一层 7z-out），
//   于是原本写死的 join(resourcesPath,'app.asar.unpacked','resources') 必然落空
//   → existsSync(java.exe)=false → 「JRE 缺失」。
//
// 对策：不再猜单一路径，改为「候选列表 + 顺序探测」，覆盖开发/NSIS/portable 三态。
import { join, dirname, normalize } from 'node:path';

export interface ResolveCtx {
  packaged: boolean;
  /** process.resourcesPath（打包态） */
  resourcesPath?: string;
  /** app.getPath('exe') 所在目录 */
  exeDir?: string;
  /** 开发态：dist/ 目录（用于回退到 ../../resources） */
  dirname?: string;
}

/** 生成候选资源根目录（按优先级排序，去重） */
export function resourceRootCandidates(ctx: ResolveCtx): string[] {
  const out: string[] = [];
  const push = (p?: string): void => {
    if (!p) return;
    const n = normalize(p);
    if (!out.includes(n)) out.push(n);
  };

  if (!ctx.packaged) {
    if (ctx.dirname) {
      // esbuild 产物：dist/main.cjs → __dirname = <repo>/dist，resources 与之同级
      push(join(ctx.dirname, '..', 'resources'));
      // 兜底（万一 __dirname 落在更深一层）
      push(join(ctx.dirname, '..', '..', 'resources'));
    }
    return out;
  }

  const rel = join('app.asar.unpacked', 'resources');
  const rp = ctx.resourcesPath;

  if (rp) {
    // 1) NSIS 安装 / --dir 解包：<root>/resources/app.asar.unpacked/resources
    push(join(rp, rel));
    // 2) ★ portable 实测：resourcesPath 停在 <tmp>\resources（外层缺 7z-out）
    push(join(rp, '..', '7z-out', 'resources', 'app.asar.unpacked', 'resources'));
    push(join(rp, '..', '7z-out', rel));
    // 3) 若 resourcesPath 直接是 <tmp>（不同版本差异）
    push(join(rp, '7z-out', 'resources', 'app.asar.unpacked', 'resources'));
    push(join(rp, '7z-out', rel));
  }

  // 4) 由 exe 位置反推 —— 最稳，与 resourcesPath 语义无关
  if (ctx.exeDir) {
    push(join(ctx.exeDir, 'resources', 'app.asar.unpacked', 'resources'));
    push(join(ctx.exeDir, rel));
    push(join(ctx.exeDir, '..', 'resources', 'app.asar.unpacked', 'resources'));
    push(join(ctx.exeDir, '..', '7z-out', rel));
    push(join(dirname(ctx.exeDir), '7z-out', 'resources', 'app.asar.unpacked', 'resources'));
  }

  return out;
}

/** 按候选顺序返回第一个「存在」的路径；都不存在时返回首选（保留错误信息形态） */
export function pickResourceRoot(ctx: ResolveCtx, exists: (p: string) => boolean): string {
  const cands = resourceRootCandidates(ctx);
  if (cands.length === 0) return '';
  for (const c of cands) if (exists(c)) return c;
  return cands[0];
}
