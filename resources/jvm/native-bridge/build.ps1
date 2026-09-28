# build.ps1 -- build native-bridge.jar (JVM side of the ARM native bridge).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File build.ps1 -Jdk "C:\path\to\jdk17" -Lib "C:\path\to\unidbg-jars" [-Asm "C:\path\to\asm-dir"]
#
# -Lib  : directory holding the native runtime jars (unidbg-android / unidbg-api / unidbg-unicorn2 ...).
#         Those jars are NOT in the repo (see native runtime download in the app); either point at
#         <userData>\cache\native\unidbg-0.9.9 after running the app once, or fetch them from Maven Central.
# -Asm  : defaults to ..\tools (asm-9.7.jar lives there in the dev tree).
# NOTES: comments are ASCII-only on purpose (PowerShell 5.1 misreads CJK in .ps1).
param(
  [Parameter(Mandatory = $true)][string]$Jdk,
  [Parameter(Mandatory = $true)][string]$Lib,
  [string]$Asm = ""
)
$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrEmpty($Asm)) { $Asm = Join-Path $here "..\tools" }

$javac = Join-Path $Jdk "bin\javac.exe"
$jarExe = Join-Path $Jdk "bin\jar.exe"
if (-not (Test-Path $javac)) { throw "javac not found: $javac" }

$asmCore = Join-Path $Asm "asm-9.7.jar"
if (-not (Test-Path $asmCore)) { throw "asm-9.7.jar not found: $asmCore" }

$libJars = @()
if (Test-Path $Lib) { $libJars = Get-ChildItem -Path $Lib -Filter *.jar | ForEach-Object { $_.FullName } }
if ($libJars.Count -eq 0) { throw "no jars under -Lib $Lib" }
$unidbg = $libJars | Where-Object { $_ -like "*unidbg-android*" }
if (-not $unidbg) { throw "unidbg-android jar not found under -Lib $Lib" }

$cp = (@($asmCore) + $libJars) -join ";"

$out = Join-Path $here "classes"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force -Path $out | Out-Null

$srcDir = Join-Path $here "com"
$srcs = Get-ChildItem -Path $srcDir -Recurse -Filter *.java | ForEach-Object { $_.FullName }
if ($srcs.Count -eq 0) { throw "no java sources under $srcDir" }

& $javac -encoding UTF-8 -cp $cp -d $out $srcs
if ($LASTEXITCODE -ne 0) { throw "javac failed: $LASTEXITCODE" }

$outJar = Join-Path $here "native-bridge.jar"
if (Test-Path $outJar) { Remove-Item -Force $outJar }
& $jarExe cf $outJar -C $out .
if ($LASTEXITCODE -ne 0) { throw "jar failed: $LASTEXITCODE" }

Remove-Item -Recurse -Force $out
Write-Host "native-bridge.jar built: $outJar"