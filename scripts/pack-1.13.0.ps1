param([string]$Root = 'E:\WorkBuddy\tvbox2\tvbox-win')
# pack-1.13.0.ps1 -- Win-Box 1.13.0 / release1.13.0 packaging helper.
#   pre-flight -> quality gate -> build-main -> vite build -> electron-builder (portable + nsis)
#   -> incremental -> copy to Desktop -> self-check
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File "E:\WorkBuddy\tvbox2\tvbox-win\scripts\pack-1.13.0.ps1"
#
# Scope (project rules):
#   * portable + nsis (previous releases shipped both assets).
#   * no git push / no GitHub Release from this script (explicit instruction only)
#   * win7-legacy line is frozen, not built
#   * incremental baseline = release1.12.0\win-unpacked (the released 1.12.0 build)
#
# This round's content (1.12.0 -> 1.13.0):
#   * startup FORCED update: compare app version with the latest GitHub Release; if the local
#     version is lower, block the whole UI until updated -- auto-download the Setup installer
#     through a proxy-accelerated GitHub prefix (gh-proxy.org / ghproxy.net / ... , direct
#     fallback) and auto-launch it. Checks that fail (offline) must NOT lock the app.
#     See src/shared/update.ts + src/main/update/UpdateService.ts + src/renderer/components/UpdateGate.tsx
#
# NOTE: ASCII-only ON PURPOSE -- PowerShell 5.1 reads .ps1 as ANSI and mangles CJK literals
#       (the CJK part of the incremental package name is built from code points below).

if (-not (Test-Path $Root)) { Write-Host "project dir not found: $Root (pass -Root)" -ForegroundColor Red; exit 1 }
Set-Location $Root

# U+589E U+91CF U+66F4 U+65B0 = "incremental update"
$incrName = 'Win-Box Setup 1.13.0 ' + [char]0x589E + [char]0x91CF + [char]0x66F4 + [char]0x65B0

$outDir    = 'release1.13.0'
$setup     = "$outDir\Win-Box Setup 1.13.0.exe"
$portable  = "$outDir\Win-Box 1.13.0.exe"
$incrExe   = "release\$incrName.exe"
$incrZip   = "release\$incrName.zip"
$oldDir    = 'release1.12.0\win-unpacked'
$newDir    = "$outDir\win-unpacked"
$asar      = "$newDir\resources\app.asar"
$appExe    = "$newDir\Win-Box.exe"

function Fail($msg) {
  Write-Host ""
  Write-Host "*** FAILED: $msg -- stopped" -ForegroundColor Red
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
if ($verLine -notmatch '1\.13\.0') { Fail "package.json version is not 1.13.0 (bump version AND build.directories.output before packing)" }
if ($outLine -notmatch 'release1\.13\.0') { Fail "build.directories.output is not release1.13.0" }

Step 0 'pre-flight: incremental baseline (previous 1.12.0 build) must exist'
if (-not (Test-Path "$oldDir\Win-Box.exe")) { Fail "baseline $oldDir\Win-Box.exe missing (needed for the 1.12.0 -> 1.13.0 incremental package)" }
Write-Host ("  baseline ok: {0} (ProductVersion {1})" -f $oldDir, (Get-Item "$oldDir\Win-Box.exe").VersionInfo.ProductVersion)

Step 1 'quality gate: vitest run (must be all green)'
node node_modules\vitest\vitest.mjs run --no-file-parallelism
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

Step 6 'electron-builder (--win portable nsis --publish never)'
node node_modules\electron-builder\out\cli\cli.js --win portable nsis --publish never
if (-not (Test-Path $setup)) { Fail "$setup was not produced (a bare exit 1 is only the missing GH_TOKEN publish notice, artifacts should still exist)" }
Write-Host ("  produced setup: {0} ({1} B)" -f $setup, (Get-Item $setup).Length)
if (-not (Test-Path $portable)) { Fail "$portable was not produced (portable target)" }
Write-Host ("  produced portable: {0} ({1} B)" -f $portable, (Get-Item $portable).Length)
if (-not (Test-Path "$newDir\Win-Box.exe")) { Fail "unpacked build missing: $newDir\Win-Box.exe (needed for incremental)" }

Step 7 'incremental update package (baseline = release1.12.0\win-unpacked)'
node scripts\make-incremental.mjs --old $oldDir --new $newDir --out $incrName
if ($LASTEXITCODE -ne 0) { Fail "make-incremental failed (exit $LASTEXITCODE)" }

Step 8 'copy artifacts to Desktop (docs 2.2 rule)'
$desk = 'C:\Users\WXJ2\Desktop'
if (-not (Test-Path $desk)) {
  $desk = Join-Path $env:USERPROFILE 'Desktop'
  Write-Host "  C:\Users\WXJ2\Desktop not found, using $desk" -ForegroundColor Yellow
}
foreach ($f in @($setup, $portable, $incrExe, $incrZip)) {
  if (Test-Path $f) {
    Copy-Item $f $desk -Force
    Write-Host ("  copied: {0}" -f (Split-Path -Leaf $f))
  } elseif ($f -eq $incrZip -or $f -eq $portable) {
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
# this round's markers (1.12.0 -> 1.13.0). ASCII only (the asar is read as ASCII bytes).
# channel names (shared/ipc-channels.ts) live in main.cjs + preload.cjs; the accel prefix and
# the updater UA live in main.cjs; the renderer gate's CSS class names survive minification.
$m1 = $txt.Contains('update:check')       # IPC channel constant (main + preload)
$m2 = $txt.Contains('update:download')    # IPC channel constant
$m3 = $txt.Contains('update:progress')    # progress push channel
$m4 = $txt.Contains('gh-proxy.org')       # proxy-accelerated GitHub prefix (main process)
$m5 = $txt.Contains('Win-Box-Updater')    # updater User-Agent
$m6 = $txt.Contains('upd-overlay')        # renderer gate overlay CSS class
$m7 = $txt.Contains('upd-fill')           # renderer gate progress bar CSS class
$ok = $m1 -and $m2 -and $m3 -and $m4 -and $m5 -and $m6 -and $m7
Write-Host ("  asar markers: update:check={0} update:download={1} update:progress={2} gh-proxy={3} ua={4} upd-overlay={5} upd-fill={6}" -f $m1, $m2, $m3, $m4, $m5, $m6, $m7) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
if (-not $ok) { Fail 'this round''s changes are NOT in the asar' }
$verInAsar = $txt.Contains('"version": "1.13.0"') -or $txt.Contains('"version":"1.13.0"')
Write-Host ("  asar package.json version 1.13.0: {0}" -f $verInAsar) -ForegroundColor $(if ($verInAsar) { 'Green' } else { 'Yellow' })
$bridgeRepo = 'resources\jvm\native-bridge\native-bridge.jar'
$bridgePack = Join-Path $newDir 'resources\app.asar.unpacked\resources\jvm\native-bridge\native-bridge.jar'
if (Test-Path $bridgePack) {
  $hRepo = (Get-FileHash $bridgeRepo -Algorithm SHA256).Hash
  $hPack = (Get-FileHash $bridgePack -Algorithm SHA256).Hash
  $bOk = $hRepo -eq $hPack
  Write-Host ("  packaged native-bridge.jar == repo build: {0}" -f $bOk) -ForegroundColor $(if ($bOk) { 'Green' } else { 'Red' })
  if (-not $bOk) { Fail 'packaged native-bridge.jar differs from the repo build (Java-side fixes NOT in the package)' }
} else { Fail "packaged native-bridge.jar missing: $bridgePack" }
if (Test-Path $appExe) {
  $pv = (Get-Item $appExe).VersionInfo.ProductVersion
  Write-Host ("  Win-Box.exe ProductVersion (expect 1.13.0): {0}" -f $pv)
  if ($pv -notmatch '^1\.13\.0') { Fail "Win-Box.exe ProductVersion is $pv, expected 1.13.0" }
} else { Fail "missing $appExe" }

Write-Host ""
Write-Host "=== sizes / SHA256 (paste this block back into the chat) ===" -ForegroundColor Green
foreach ($f in @($setup, $portable, $incrExe, $incrZip)) {
  if (Test-Path $f) {
    $len = (Get-Item $f).Length
    $h = (Get-FileHash $f -Algorithm SHA256).Hash
    Write-Host ("  {0}`n    {1} B`n    {2}" -f (Split-Path -Leaf $f), $len, $h)
  }
}
Write-Host ""
Write-Host "=== DONE ===" -ForegroundColor Green
Write-Host "No push, no GitHub Release from this script."
