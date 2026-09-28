param([string]$Root = 'E:\WorkBuddy\tvbox2\tvbox-win')
# pack-0.100.0.ps1 -- Win-Box 0.100.0 / release100 one-shot packaging helper
#   pre-flight -> quality gate -> build-main -> vite build -> electron-builder -> incremental -> copy to Desktop -> self-check
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File "E:\WorkBuddy\tvbox2\tvbox-win\scripts\pack-0.100.0.ps1"
#
# Scope (project rules):
#   * nsis Setup only -- portable is on-demand and was NOT requested, so it is not built
#   * no git push, no GitHub Release (both need an explicit instruction)
#   * win7-legacy line is frozen, not built
#   * incremental baseline this round = the PREVIOUS release100 build, preserved at
#     .tmp\r100-prev\win-unpacked (that is what the user has installed); do NOT diff against release99
#
# NOTE: this file is ASCII-only ON PURPOSE -- PowerShell 5.1 reads .ps1 as ANSI and would
#       mangle CJK literals (same reason build.ps1 keeps its comments ASCII). The CJK part
#       of the incremental package name is built from code points below instead.
# This is a one-shot helper; safe to delete after the release. The manual command
# sequence documented in docs/ still applies.

if (-not (Test-Path $Root)) { Write-Host "project dir not found: $Root (pass -Root)" -ForegroundColor Red; exit 1 }
Set-Location $Root

# "zeng liang geng xin" = U+589E U+91CF U+66F4 U+65B0, kept out of the file as a literal
# ★ name carries the TARGET version (the version the package upgrades TO), same as all
#   historical artifacts (e.g. "Win-Box Setup 0.99.0 incremental" upgraded 0.98.0 -> 0.99.0)
$incrName = 'Win-Box Setup 0.100.0 ' + [char]0x589E + [char]0x91CF + [char]0x66F4 + [char]0x65B0

$setup     = 'release100\Win-Box Setup 0.100.0.exe'
$incrExe   = "release\$incrName.exe"
$incrZip   = "release\$incrName.zip"
$nbJar     = 'resources\jvm\native-bridge\native-bridge.jar'
$bridgeJar = 'release100\win-unpacked\resources\app.asar.unpacked\resources\jvm\native-bridge\native-bridge.jar'
$asar      = 'release100\win-unpacked\resources\app.asar'
$appExe    = 'release100\win-unpacked\Win-Box.exe'

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

Step 0 'pre-flight: native-bridge.jar must be the FIXED build'
if (-not (Test-Path $nbJar)) { Fail "missing $nbJar" }
$nbLen = (Get-Item $nbJar).Length
if ($nbLen -eq 24249) {
  Fail "native-bridge.jar is the OLD broken build (24249 B): the rewritten native methods failed JVM verification. Overwrite it with the fixed jar (25251 B) before packaging."
}
Write-Host ("  native-bridge.jar = {0} B (not the broken 24249 B build, ok)" -f $nbLen)

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

Step 7 'incremental update package (baseline = previous release100 build, saved at .tmp\r100-prev)'
if (-not (Test-Path '.tmp\r100-prev\win-unpacked')) { Fail 'baseline .tmp\r100-prev\win-unpacked missing: preserve the previous release100 build there BEFORE rebuilding (this round diffs against the previous release100 output, not release99)' }
node scripts\make-incremental.mjs --old .tmp\r100-prev\win-unpacked --new release100\win-unpacked --out $incrName
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
$wdColor = 'Green'
if ($hasWd) { $wdColor = 'Red' }
Write-Host ("  asar contains watchdog.cjs (must be False, win7-only file): {0}" -f $hasWd) -ForegroundColor $wdColor
Write-Host ("  asar header mentions native-bridge.jar: {0}" -f $txt.Contains('native-bridge.jar'))
if (Test-Path $bridgeJar) {
  Write-Host ("  bridge jar unpacked with app: {0} B (fixed build; NOT the broken 24249 B)" -f (Get-Item $bridgeJar).Length)
} else {
  Write-Host "  bridge jar NOT found under app.asar.unpacked -- confirm manually" -ForegroundColor Yellow
}
if (Test-Path $appExe) {
  Write-Host ("  Win-Box.exe ProductVersion (expect 0.100.0): {0}" -f (Get-Item $appExe).VersionInfo.ProductVersion)
}

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
