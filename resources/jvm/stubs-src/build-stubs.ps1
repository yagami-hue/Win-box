# Rebuild stubs.jar (Windows native; equivalent of build-stubs.sh).
# Usage: powershell -ExecutionPolicy Bypass -File build-stubs.ps1 -Javac <javac.exe> -Jar <jar.exe>
#   -Base and -Out are auto-derived from script location when omitted.
param(
  [Parameter(Mandatory=$true)][string]$Javac,
  [Parameter(Mandatory=$true)][string]$Jar,
  [string]$Base = ".",
  [string]$Out = "stubs.jar"
)
$ErrorActionPreference = "Stop"

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Here

# Auto-derive Base/Out (stubs-src and stubs both live under resources/jvm)
if ([string]::IsNullOrEmpty($Base) -or $Base -eq ".") { $Base = Join-Path $Root "stubs" }
if ($Out -eq "stubs.jar") { $Out = Join-Path $Base "stubs.jar" }

$Work = Join-Path $env:TEMP ("tvbox_stubwork_" + [guid]::NewGuid().ToString("N").Substring(0,8))

Write-Host "work dir: $Work"
New-Item -ItemType Directory -Force -Path $Work | Out-Null

try {
  # 1) extract baseline jar (keeps historical classes like SharedPreferences whose source is not in stubs-src)
  $baseJar = Join-Path $Work "base.jar"
  Copy-Item (Join-Path $Base "stubs.jar") $baseJar
  if (-not (Test-Path $baseJar)) { throw "base.jar copy failed" }
  Push-Location $Work
  & $Jar xf $baseJar
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "jar xf failed: $LASTEXITCODE" }
  Pop-Location
  Remove-Item $baseJar -ErrorAction SilentlyContinue

  # 2) collect sources (exclude shell-shim shadow class; it builds into shell-shim.jar separately)
  $java = Get-ChildItem -Path $Here -Recurse -Filter *.java |
      Where-Object { $_.FullName -notmatch '[\\/]shell-shim[\\/]' }
  $files = @($java | ForEach-Object { $_.FullName })
  $runner = Join-Path $Root "SpiderRunner.java"
  if (Test-Path $runner) { $files += $runner }
  $filesTxt = Join-Path $Work "files.txt"
  [System.IO.File]::WriteAllLines($filesTxt, [string[]]$files)

  # 3) compile (-cp baseline dir + libs; -sourcepath for same-package cross refs)
  $libs = @(Get-ChildItem (Join-Path $Root "libs") -Filter *.jar | ForEach-Object { $_.FullName }) -join ';'
  & $Javac -encoding UTF-8 -nowarn -cp "$Work;$libs" -sourcepath $Here -d $Work "@$filesTxt"
  if ($LASTEXITCODE -ne 0) { throw "javac failed: $LASTEXITCODE" }

  # 4) package (only .class + META-INF, so files.txt/tmp jars are excluded)
  Remove-Item $filesTxt -ErrorAction SilentlyContinue
  $outTmp = Join-Path $env:TEMP ("tvbox_out_" + [guid]::NewGuid().ToString("N").Substring(0,8) + ".jar")
  $pack = Get-ChildItem -Path $Work -Recurse -File |
      Where-Object { $_.Extension -eq '.class' -or $_.FullName -match '[\\/]META-INF[\\/]' } |
      ForEach-Object { ($_.FullName.Substring($Work.Length + 1)) -replace '\\','/' }
  $packTxt = Join-Path $Work "pack.txt"
  [System.IO.File]::WriteAllLines($packTxt, [string[]]$pack)
  Push-Location $Work
  & $Jar cf $outTmp "@$packTxt"
  Pop-Location
  if ($LASTEXITCODE -ne 0) { throw "jar failed: $LASTEXITCODE" }

  Copy-Item $outTmp $Out -Force
  $classCount = (Get-ChildItem -Path $Work -Recurse -Filter *.class).Count
  Write-Host "built $Out ($classCount classes)"
}
finally {
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
  Remove-Item $outTmp -ErrorAction SilentlyContinue
}