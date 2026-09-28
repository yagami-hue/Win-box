param([string]$Root = 'E:\WorkBuddy\tvbox2\tvbox-win')
# pack-1.1.0.ps1 -- Win-Box 1.1.0 / release1.1.0 packaging helper.
#   1st run: MINOR bump 1.0.0 -> 1.1.0 (payload-layer round).
#   2nd run (2026-09-28, version unchanged / same-name overwrite): re-pack AFTER the 09-28 fixes
#     (wexproxy payload skip / pool envelope ok / lenient subscribe JSON / jar okhttp-UA fallback)
#     and the FishGuard performance fix (unidbg dynarmic backend by default).
#   pre-flight -> quality gate -> build-main -> vite build -> electron-builder -> incremental -> copy to Desktop -> self-check
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File "E:\WorkBuddy\tvbox2\tvbox-win\scripts\pack-1.1.0.ps1"
#
# Scope (project rules):
#   * nsis Setup only -- portable is on-demand and was NOT requested, so it is not built
#   * no git push, no GitHub Release (both need an explicit instruction)
#   * win7-legacy line is frozen, not built
#   * incremental baseline = release1.0.0\win-unpacked (the 1.0.0 build the user has installed)
#
# NOTE: this file is ASCII-only ON PURPOSE -- PowerShell 5.1 reads .ps1 as ANSI and would
#       mangle CJK literals (same reason build.ps1 keeps its comments ASCII). The CJK part
#       of the incremental package name is built from code points below instead.
# This is a one-shot helper; safe to delete after the release.

if (-not (Test-Path $Root)) { Write-Host "project dir not found: $Root (pass -Root)" -ForegroundColor Red; exit 1 }
Set-Location $Root

# "zeng liang geng xin" = U+589E U+91CF U+66F4 U+65B0, kept out of the file as a literal
# name carries the TARGET version (the version the package upgrades TO)
$incrName = 'Win-Box Setup 1.1.0 ' + [char]0x589E + [char]0x91CF + [char]0x66F4 + [char]0x65B0

$outDir    = 'release1.1.0'
$setup     = "$outDir\Win-Box Setup 1.1.0.exe"
$incrExe   = "release\$incrName.exe"
$incrZip   = "release\$incrName.zip"
$oldDir    = 'release1.0.0\win-unpacked'
$newDir    = "$outDir\win-unpacked"
$asar      = "$newDir\resources\app.asar"
$appExe    = "$newDir\Win-Box.exe"

function Fail($msg) {
  Write-Host ""
  Write-Host "*** FAILED: $msg -- stopped, nothing copied to Desktop" -ForegroundColor Red
  exit 1
}
function Step($n, $t) {
  Write-Host ""
  Write-Host "=== [$n] $t ===" -ForegroundColor Cyan
}

$verLine = (Select-String -Path package.json -Pattern '"version"' | Select-Object -First 1).Line.Trim()
$outLine = (Select-String -Path package.json -Pattern '"output"' | Select-Object -First 1).Line.Trim()
Write-Host "root : $Root"
Write-Host "pkg  : $verLine  /  $outLine"
if ($verLine -notmatch '1\.1\.0') { Fail "package.json version is not 1.1.0 (bump version AND build.directories.output before packing)" }
if ($outLine -notmatch 'release1\.1\.0') { Fail "build.directories.output is not release1.1.0" }

Step 0 'pre-flight: incremental baseline (installed 1.0.0 build) must exist'
if (-not (Test-Path "$oldDir\Win-Box.exe")) { Fail "baseline $oldDir\Win-Box.exe missing (needed for the 1.0.0 -> 1.1.0 incremental package)" }
Write-Host ("  baseline ok: {0} (ProductVersion {1})" -f $oldDir, (Get-Item "$oldDir\Win-Box.exe").VersionInfo.ProductVersion)

Step 1 'quality gate: vitest run (must be all green)'
node node_modules\vitest\vitest.mjs run
if ($LASTEXITCODE -ne 0) { Fail "vitest not green (exit $LASTEXITCODE)" }

Step 2 'quality gate: tsc --noEmit (main + web)'
node node_modules\typescript\bin\tsc --noEmit
if ($LASTEXITCODE -ne 0) { Fail "tsc(main) failed (exit $LASTEXITCODE)" }
node node_modules\typescript\bin\tsc --noEmit -p tsconfig.web.json
if ($LASTEXITCODE -ne 0) { Fail "tsc(web) failed (exit $LASTEXITCODE)" }

Step 3 'clear dist\renderer (local safe-delete shim blocks vite self-clean)'
if (Test-Path 'dist\renderer') {
  try { Remove-Item -Recurse -Force 'dist\renderer'; Write-Host '  cleared' }
  catch { Write-Host '  clear failed, continuing (vite will try)' -ForegroundColor Yellow }
} else { Write-Host '  not present, skipped' }

Step 4 'build-main (esbuild -> dist\main.cjs + dist\preload.cjs)'
node scripts\build-main.mjs
if ($LASTEXITCODE -ne 0) { Fail "build-main failed (exit $LASTEXITCODE)" }

Step 5 'vite build (renderer)'
node node_modules\vite\bin\vite.js build
if ($LASTEXITCODE -ne 0) { Fail "vite build failed (exit $LASTEXITCODE)" }

Step 6 'electron-builder (--win nsis --publish never; no portable)'
node node_modules\electron-builder\out\cli\cli.js --win nsis --publish never
if (-not (Test-Path $setup)) { Fail "$setup was not produced (a bare exit 1 is only the missing GH_TOKEN publish notice, artifacts should still exist)" }
Write-Host ("  produced: {0} ({1} B)" -f $setup, (Get-Item $setup).Length)

Step 7 'incremental update package (baseline = release1.0.0\win-unpacked, i.e. installed 1.0.0)'
node scripts\make-incremental.mjs --old $oldDir --new $newDir --out $incrName
if ($LASTEXITCODE -ne 0) { Fail "make-incremental failed (exit $LASTEXITCODE)" }

Step 8 'copy artifacts to Desktop (docs 2.2 rule)'
$desk = 'C:\Users\WXJ2\Desktop'
if (-not (Test-Path $desk)) {
  $desk = Join-Path $env:USERPROFILE 'Desktop'
  Write-Host "  C:\Users\WXJ2\Desktop not found, using $desk" -ForegroundColor Yellow
}
foreach ($f in @($setup, $incrExe, $incrZip)) {
  if (Test-Path $f) {
    Copy-Item $f $desk -Force
    Write-Host ("  copied: {0}" -f (Split-Path -Leaf $f))
  } elseif ($f -eq $incrZip) {
    Write-Host ("  not generated (optional): {0}" -f (Split-Path -Leaf $f)) -ForegroundColor Yellow
  } else {
    Fail "artifact missing: $f"
  }
}

Step 9 'artifact self-check (docs 2.4)'
if (-not (Test-Path $asar)) { Fail "missing $asar" }
$txt = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($asar))
$hasWd = $txt.Contains('watchdog.cjs')
Write-Host ("  asar contains watchdog.cjs (must be False, win7-only file): {0}" -f $hasWd) -ForegroundColor $(if ($hasWd) { 'Red' } else { 'Green' })
if ($hasWd) { Fail 'win7-only dist/watchdog.cjs leaked into the main asar' }
# this round's changes must all be present in the shipped bundle:
#   09-28 fixes 3-4 (lenient JSON / jar UA fallback) + fix 2 (pool serve-log reason)
#   + FishGuard perf fix (dynarmic runtime jar name in the native jar list)
#   (fix 1 = wexproxy payload skip lives in native-bridge.jar, checked by hash below)
$m1 = $txt.Contains('stripTrailingCommas')
$m2 = $txt.Contains('isJarOrDex')
$m3 = $txt.Contains('serveLogTotal')
$m4 = $txt.Contains('unidbg-dynarmic-0.9.9.jar')
$ok = $m1 -and $m2 -and $m3 -and $m4
Write-Host ("  asar markers: lenient-json={0} jar-ua={1} pool-reason={2} dynarmic={3}" -f $m1, $m2, $m3, $m4) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
if (-not $ok) { Fail 'this round''s changes are NOT in the asar' }
# java-side fixes (wexproxy payload skip + dynarmic backend default) live in the bridge jar,
# which ships under app.asar.unpacked -- compare it with the repo build byte-for-byte
$bridgeRepo = 'resources\jvm\native-bridge\native-bridge.jar'
$bridgePack = Join-Path $newDir 'resources\app.asar.unpacked\resources\jvm\native-bridge\native-bridge.jar'
if (-not (Test-Path $bridgePack)) { Fail "packaged native-bridge.jar missing: $bridgePack" }
$hRepo = (Get-FileHash $bridgeRepo -Algorithm SHA256).Hash
$hPack = (Get-FileHash $bridgePack -Algorithm SHA256).Hash
$bOk = $hRepo -eq $hPack
Write-Host ("  packaged native-bridge.jar == repo build: {0}" -f $bOk) -ForegroundColor $(if ($bOk) { 'Green' } else { 'Red' })
if (-not $bOk) { Fail 'packaged native-bridge.jar differs from the repo build (Java-side fixes NOT in the package)' }
if (Test-Path $appExe) {
  $pv = (Get-Item $appExe).VersionInfo.ProductVersion
  Write-Host ("  Win-Box.exe ProductVersion (expect 1.1.0): {0}" -f $pv)
  if ($pv -notmatch '^1\.1\.0') { Fail "Win-Box.exe ProductVersion is $pv, expected 1.1.0" }
} else { Fail "missing $appExe" }

Write-Host ""
Write-Host "=== sizes / SHA256 (paste this block back into the chat) ===" -ForegroundColor Green
foreach ($f in @($setup, $incrExe, $incrZip)) {
  if (Test-Path $f) {
    $len = (Get-Item $f).Length
    $h = (Get-FileHash $f -Algorithm SHA256).Hash
    Write-Host ("  {0}`n    {1} B`n    {2}" -f (Split-Path -Leaf $f), $len, $h)
  }
}
Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host "Desktop should hold 3 files. No push, no GitHub Release (both need an explicit go-ahead)."