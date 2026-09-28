param([string]$Root = 'E:\WorkBuddy\tvbox2\tvbox-win')
# pack-1.0.0.ps1 -- Win-Box 1.0.0 / release1.0.0 one-shot packaging helper (MAJOR bump: 0.100.0 -> 1.0.0)
#   pre-flight -> quality gate -> build-main -> vite build -> electron-builder -> incremental -> copy to Desktop -> self-check
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File "E:\WorkBuddy\tvbox2\tvbox-win\scripts\pack-1.0.0.ps1"
#
# Scope (project rules):
#   * nsis Setup only -- portable is on-demand and was NOT requested, so it is not built
#   * no git push, no GitHub Release (both need an explicit instruction)
#   * win7-legacy line is frozen, not built
#   * incremental baseline this round = release100\win-unpacked (the 0.100.0 build the user has installed)
#
# NOTE: this file is ASCII-only ON PURPOSE -- PowerShell 5.1 reads .ps1 as ANSI and would
#       mangle CJK literals (same reason build.ps1 keeps its comments ASCII). The CJK part
#       of the incremental package name is built from code points below instead.
# This is a one-shot helper; safe to delete after the release.

if (-not (Test-Path $Root)) { Write-Host "project dir not found: $Root (pass -Root)" -ForegroundColor Red; exit 1 }
Set-Location $Root

# "zeng liang geng xin" = U+589E U+91CF U+66F4 U+65B0, kept out of the file as a literal
# name carries the TARGET version (the version the package upgrades TO)
$incrName = 'Win-Box Setup 1.0.0 ' + [char]0x589E + [char]0x91CF + [char]0x66F4 + [char]0x65B0

$outDir    = 'release1.0.0'
$setup     = "$outDir\Win-Box Setup 1.0.0.exe"
$incrExe   = "release\$incrName.exe"
$incrZip   = "release\$incrName.zip"
$oldDir    = 'release100\win-unpacked'
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
if ($verLine -notmatch '1\.0\.0') { Fail "package.json version is not 1.0.0 (bump version AND build.directories.output before packing)" }
if ($outLine -notmatch 'release1\.0\.0') { Fail "build.directories.output is not release1.0.0" }

Step 0 'pre-flight: incremental baseline (installed 0.100.0 build) must exist'
if (-not (Test-Path "$oldDir\Win-Box.exe")) { Fail "baseline $oldDir\Win-Box.exe missing (needed for the 0.100.0 -> 1.0.0 incremental package)" }
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

Step 7 'incremental update package (baseline = release100\win-unpacked, i.e. installed 0.100.0)'
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
$m1 = $txt.Contains('cfg:importJsonLocal')   # this round: local .json subscription import channel
$m2 = $txt.Contains('live-player')           # this round: live page player host CSS
Write-Host ("  asar has this round's markers (cfg:importJsonLocal={0}, live-player={1})" -f $m1, $m2) -ForegroundColor $(if ($m1 -and $m2) { 'Green' } else { 'Red' })
if (-not ($m1 -and $m2)) { Fail 'this round''s changes are NOT in the asar' }
if (Test-Path $appExe) {
  $pv = (Get-Item $appExe).VersionInfo.ProductVersion
  Write-Host ("  Win-Box.exe ProductVersion (expect 1.0.0): {0}" -f $pv)
  if ($pv -notmatch '^1\.0\.0') { Fail "Win-Box.exe ProductVersion is $pv, expected 1.0.0" }
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