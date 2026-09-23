// scripts/make-incremental.mjs — 离线增量更新包生成器（NSIS 安装器形式，不联网、只改已安装文件）
//
// 用法：node scripts/make-incremental.mjs --old <旧版win-unpacked> --new <新版win-unpacked> --out <输出名(不含后缀)>
// 例：node scripts/make-incremental.mjs \
//       --old release80/win-unpacked --new release81/win-unpacked --out "Win-Box Setup 0.80.0 增量更新"
// 产物（release/）：
//   <out名>.exe       ★ NSIS 增量安装器（向导式）：定位已安装目录 → 结束运行中的 Win-Box →
//                     覆盖差异文件 → 用内置 rcedit 更新 Win-Box.exe 的版本资源 → 写注册表
//                     DisplayVersion。内置图标 build/icon.ico。支持 /S 静默 + /D=<目录>。
//   <out名>.zip       备选手动模式（diff/ 按相对路径存放，直接解压覆盖即可；含说明.txt）
// 原理：对比 old/new 两棵解包目录，取「新增/变更」文件（长度或 SHA256 不同），
//       打包进安装器；升级时仅覆盖这些文件 —— 已安装目录里未变的部分完全不动。
// ★ 2026-09-20 改动：
//   · 主程序 Win-Box.exe **不放进 diff** —— 由安装器内 rcedit 直接改写已安装 exe 的版本资源
//     （FileVersion/ProductVersion → 新版本），增量包保持小体积；
//   · 修复「>4MB 文件跳过 hash」漏检：.exe/.dll 等长文件强制 hash（版本资源变化时字节等长）；
//   · 新版本号自动从新版 app.asar 内 package.json 读取。
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = Object.fromEntries(args.map((a, i) => (a.startsWith('--') ? [a.slice(2), args[i + 1]] : null)).filter(Boolean));
const oldDir = opt.old;
const newDir = opt.new;
const outName = opt.out;
if (!oldDir || !newDir || !outName) {
  console.error('用法: node scripts/make-incremental.mjs --old <旧unpacked> --new <新unpacked> --out <输出名>');
  process.exit(1);
}
if (!existsSync(oldDir) || !existsSync(newDir)) {
  console.error(`目录不存在: old=${oldDir} new=${newDir}`);
  process.exit(1);
}

/** 新版本号：从新版 app.asar 内 package.json 读取（如 0.81.0） */
async function readNewVersion(unpackedDir) {
  const asar = join(unpackedDir, 'resources', 'app.asar');
  if (!existsSync(asar)) throw new Error(`找不到 ${asar}`);
  const asarLib = join(process.cwd(), 'node_modules', '.pnpm', '@electron+asar@3.4.1', 'node_modules', '@electron', 'asar', 'lib', 'asar.js');
  const m = await import(pathToFileURL(asarLib).href);
  const api = m.default ?? m;
  const pkg = JSON.parse(api.extractFile(asar, 'package.json').toString());
  const v = String(pkg.version || '').trim();
  if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error(`app.asar 内版本号异常: ${v}`);
  return v;
}

/** 递归收集文件：rel → { abs, size, hash } */
function walk(dir, base) {
  const out = new Map();
  const rec = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      if (e.isDirectory()) rec(abs);
      else if (e.isFile()) {
        const size = statSync(abs).size;
        // ★ 大文件：长度不同必然差异；长度相同则 .exe/.dll 强制 hash 兜底（版本资源变化时字节等长），
        //   其余 >4MB 文件仍按长度判（避免对大资源做重复 IO）。
        const ext = extname(e.name).toLowerCase();
        const needHash = size <= 4 * 1024 * 1024 || ext === '.exe' || ext === '.dll';
        const hash = needHash ? sha1(abs) : '';
        out.set(relative(base, abs).split(sep).join('/'), { abs, size, hash });
      }
    }
  };
  rec(dir);
  return out;
}
function sha1(p) {
  try {
    return createHash('sha1').update(readFileSync(p)).digest('hex');
  } catch {
    return '';
  }
}

const version = await readNewVersion(newDir);
// ★ win7 等带后缀版本（0.81.2-win7）：NSIS VIProductVersion 只认纯 x.y.z.w，剥掉 -后缀
const baseVer = version.split('-')[0];
const vParts = baseVer.split('.').map((s) => /^\d+$/.test(s) ? s : '0'); // 非数字段兜底 0
while (vParts.length < 4) vParts.push('0');
const version4 = vParts.slice(0, 4).join('.'); // NSIS VIProductVersion 需要 x.y.z.w

const oldMap = walk(oldDir, oldDir);
const newMap = walk(newDir, newDir);
const diff = [];
for (const [rel, f] of newMap) {
  // ★ 主程序 exe 不进 diff：由安装器 rcedit 改写版本资源（避免 189MB 进包）
  if (rel === 'Win-Box.exe') continue;
  const o = oldMap.get(rel);
  const changed = !o || o.size !== f.size || (f.hash && o.hash !== f.hash);
  if (changed) diff.push({ rel, abs: f.abs, size: f.size });
}
const totalNew = [...newMap.values()].reduce((s, f) => s + f.size, 0);
let diffBytes = 0;
for (const d of diff) diffBytes += d.size;
console.log(`新版本 ${version}：旧版文件 ${oldMap.size}，新版文件 ${newMap.size}；差异文件 ${diff.length} 个，共 ${(diffBytes / 1024 / 1024).toFixed(1)} MB（全量 ${(totalNew / 1024 / 1024).toFixed(1)} MB）`);

// ── 组 staging ──
const staging = join(process.cwd(), '.tmp', `incr-${Date.now()}`);
const incrDir = join(staging, 'incr');
mkdirSync(incrDir, { recursive: true });
for (const d of diff) {
  const dst = join(incrDir, d.rel);
  mkdirSync(join(dst, '..'), { recursive: true });
  copyFileSync(d.abs, dst);
}

// ── 工具路径（electron-builder 缓存，无 glob）──
function findInCache(relDir, name) {
  const home = process.env.LOCALAPPDATA || process.env.USERPROFILE;
  const root = join(home, 'electron-builder', 'Cache', relDir);
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    const p = join(root, d, name);
    if (existsSync(p)) return p;
  }
  return null;
}
const makensis = findInCache('nsis', join('Bin', 'makensis.exe')) || findInCache('nsis', 'makensis.exe');
const rcedit = findInCache('winCodeSign', 'rcedit-x64.exe');
if (!makensis) throw new Error('未找到 makensis（electron-builder Cache\\nsis），先执行过一次 electron-builder 打包');
if (!rcedit) throw new Error('未找到 rcedit-x64（electron-builder Cache\\winCodeSign）');
const icon = join(process.cwd(), 'build', 'icon.ico');
if (!existsSync(icon)) throw new Error(`缺少图标 ${icon}`);
const exeOut = join(process.cwd(), 'release', `${outName}.exe`);
mkdirSync(join(process.cwd(), 'release'), { recursive: true });
rmSync(exeOut, { force: true });

// ── NSIS 安装器脚本 ──
// 说明：rcedit 改版本资源后 exe 数字签名会失效（本产品未签名，无影响）；Electron 内核升级需走完整安装包。
// File /r 递归目录会保留目录名（实测解到 $INSTDIR\incr\…），故逐文件显式 SetOutPath+File。
let fileCmds = '';
for (const d of diff) {
  const slash = d.rel.lastIndexOf('/');
  const dir = slash > 0 ? d.rel.slice(0, slash) : '';
  const nsDir = dir.replaceAll('/', '\\');
  const src = join(incrDir, d.rel);
  fileCmds += `  SetOutPath "$INSTDIR${nsDir ? '\\' + nsDir : ''}"\n`;
  fileCmds += `  File "${src}"\n`;
}
const nsi = `Unicode True
!include "MUI2.nsh"

Name "Win-Box 增量更新"
OutFile "${exeOut}"
InstallDir "$LOCALAPPDATA\\Programs\\Win-Box"
Icon "${icon}"
VIProductVersion "${version4}"
VIAddVersionKey "ProductName" "Win-Box"
VIAddVersionKey "ProductVersion" "${version}"
VIAddVersionKey "FileVersion" "${version}"
VIAddVersionKey "FileDescription" "Win-Box 离线增量更新（${version}）"
VIAddVersionKey "LegalCopyright" "Win-Box"

; ── 宏：扫描指定 hive 的卸载键，找含 Win-Box 且 Win-Box.exe 存在的 InstallLocation → 写 $INSTDIR ──
!macro FIND_INSTALL_DIR HIVE
  StrCpy $0 0
  \${HIVE}find_loop:
    EnumRegKey $1 \${HIVE} "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" $0
    StrCmp $1 "" \${HIVE}find_no
    ReadRegStr $2 \${HIVE} "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$1" "DisplayName"
    Push $2
    Call StrContainsWinBox
    Pop $3
    StrCmp $3 "" \${HIVE}find_next
    ReadRegStr $4 \${HIVE} "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$1" "InstallLocation"
    StrCmp $4 "" \${HIVE}find_next
    IfFileExists "$4\\Win-Box.exe" 0 \${HIVE}find_next
    StrCpy $INSTDIR $4
    Goto found
  \${HIVE}find_next:
    IntOp $0 $0 + 1
    Goto \${HIVE}find_loop
  \${HIVE}find_no:
!macroend

; ★ 自动查找安装目录（无需手动选择，防止选错）：默认 per-user 位置 → Program Files → 注册表(HKCU/HKLM)
Function .onInit
  ; ★ 本安装器为 x86 编译，默认注册表被 WOW64 重定向到 WOW6432Node；
  ;   electron-builder 的 NSIS 安装器用 SetRegView 64 写卸载键 → 必须切 64 位视图才能定位/更新
  SetRegView 64
  StrCpy $INSTDIR "$LOCALAPPDATA\\Programs\\Win-Box"
  IfFileExists "$INSTDIR\\Win-Box.exe" found
  StrCpy $INSTDIR "$PROGRAMFILES64\\Win-Box"
  IfFileExists "$INSTDIR\\Win-Box.exe" found
  StrCpy $INSTDIR "$PROGRAMFILES\\Win-Box"
  IfFileExists "$INSTDIR\\Win-Box.exe" found
  StrCpy $INSTDIR ""
  !insertmacro FIND_INSTALL_DIR HKCU
  StrCmp $INSTDIR "" 0 found
  !insertmacro FIND_INSTALL_DIR HKLM
  StrCmp $INSTDIR "" 0 found
  ; 全部候选均未命中 → 提示并退出（不进入安装流程，杜绝选错目录）
  MessageBox MB_OK|MB_ICONSTOP "未检测到 Win-Box 的安装位置。$\\r$\\n请先安装 Win-Box（或确认已安装）后再运行本增量更新包。"
  Abort
  found:
FunctionEnd

; 判断栈顶字符串是否包含 "Win-Box"（不含返回空）
Function StrContainsWinBox
  Exch $R0
  Push $R1
  StrCpy $R1 0
  str_loop:
    ; ★ "Win-Box" 为 7 字符，必须取 7 位（曾取 6 位导致永不匹配 → 注册表定位/版本更新失效）
    StrCpy $R2 $R0 7 $R1
    StrCmp $R2 "" str_no
    StrCmp $R2 "Win-Box" str_yes
    IntOp $R1 $R1 + 1
    Goto str_loop
  str_yes:
    StrCpy $R0 "1"
    Goto str_end
  str_no:
    StrCpy $R0 ""
  str_end:
  Pop $R1
  Exch $R0
FunctionEnd

; 更新注册表 DisplayVersion（卸载列表里显示的版本；HKCU + HKLM 都覆盖）
!macro UPDATE_REG_VERSION HIVE
  StrCpy $0 0
  \${HIVE}reg_loop:
    EnumRegKey $1 \${HIVE} "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" $0
    StrCmp $1 "" \${HIVE}reg_done
    ReadRegStr $2 \${HIVE} "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$1" "DisplayName"
    Push $2
    Call StrContainsWinBox
    Pop $3
    StrCmp $3 "" \${HIVE}reg_next
    WriteRegStr \${HIVE} "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$1" "DisplayVersion" "${version}"
    Goto \${HIVE}reg_done
  \${HIVE}reg_next:
    IntOp $0 $0 + 1
    Goto \${HIVE}reg_loop
  \${HIVE}reg_done:
!macroend

Function UpdateRegVersion
  !insertmacro UPDATE_REG_VERSION HKCU
  !insertmacro UPDATE_REG_VERSION HKLM
FunctionEnd

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Update"
  ; 结束运行中的 Win-Box（忽略失败）
  nsExec::ExecToStack 'taskkill /f /im Win-Box.exe'
  ; 覆盖差异文件（逐文件精确落位）
${fileCmds}  ; rcedit 更新已安装 exe 的版本资源（固定临时目录，先清后建再删）
  RMDir /r "$TEMP\\winbox-incr"
  SetOutPath "$TEMP\\winbox-incr"
  File "${rcedit}"
  nsExec::ExecToStack '"$TEMP\\winbox-incr\\rcedit-x64.exe" "$INSTDIR\\Win-Box.exe" --set-version-string "FileVersion" "${version}" --set-version-string "ProductVersion" "${version}" --set-file-version "${version4}" --set-product-version "${version4}"'
  RMDir /r "$TEMP\\winbox-incr"
  ; 更新卸载列表显示版本
  Call UpdateRegVersion
SectionEnd
`;
const nsiPath = join(staging, 'update.nsi');
// ★ NSIS 3 Unicode 模式要求脚本 UTF-8 **带 BOM**，否则中文（安装器名/说明）报 Bad text encoding
writeFileSync(nsiPath, '\uFEFF' + nsi, 'utf8');

// ── makensis 编译安装器 ──
const build = spawnSync(makensis, ['-V2', nsiPath], { cwd: staging, encoding: 'utf8', timeout: 300000 });
if (!existsSync(exeOut)) {
  console.error('makensis 失败:\n' + (build.stderr || build.stdout));
  process.exit(1);
}
const exeSize = statSync(exeOut).size;
console.log(`增量安装器已生成：${exeOut}（${(exeSize / 1024 / 1024).toFixed(1)} MB）`);

// ── 备选 zip（手动覆盖模式）──
const seven = join(process.cwd(), 'node_modules', '.pnpm', '7zip-bin@5.2.0', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const readme = `Win-Box 离线增量更新包（${outName}）
=====================================
推荐方式：双击 ${outName}.exe 运行增量安装器 —— 自动定位已安装目录、覆盖差异文件、
并更新 Win-Box.exe 版本号（${version}）与卸载列表显示版本。支持 /S 静默安装（可加 /D=目录）。
手动方式：把本 zip 内 diff/ 解压覆盖到安装目录（先退出 Win-Box）；但 exe 版本号不会更新，
请改用安装器以获得版本同步。
注意：已安装的个人数据（配置/历史/网盘凭据）位于 %APPDATA%\\win-box，不受本更新影响。
制作：node scripts/make-incremental.mjs --old <旧unpacked> --new <新unpacked> --out <名>
`;
writeFileSync(join(staging, '说明.txt'), readme, 'utf8');
mkdirSync(join(staging, 'diff'), { recursive: true });
for (const d of diff) {
  const dst = join(staging, 'diff', d.rel);
  mkdirSync(join(dst, '..'), { recursive: true });
  copyFileSync(d.abs, dst);
}
const zipOut = join(process.cwd(), 'release', `${outName}.zip`);
rmSync(zipOut, { force: true });
const z = spawnSync(seven, ['a', '-tzip', '-mx=9', '-y', zipOut, 'diff', '说明.txt'], { cwd: staging, encoding: 'utf8' });
if (z.status !== 0) {
  console.error('7za 打包失败:\n' + (z.stderr || z.stdout));
  process.exit(1);
}
rmSync(staging, { recursive: true, force: true });
const zipSize = statSync(zipOut).size;
console.log(`备选 zip 已生成：${zipOut}（${(zipSize / 1024 / 1024).toFixed(1)} MB）`);
console.log(`完成：版本 ${version} 增量包 = ${outName}.exe（安装器）+ .zip（手动）`);
