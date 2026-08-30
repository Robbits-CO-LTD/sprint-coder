[CmdletBinding()]
param(
  [Parameter()]
  [string]$OutputDirectory = (Join-Path $env:TEMP 'sprint-coder-computer-use-win32-fixture')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$fixtureRoot = Split-Path -Parent $PSCommandPath
$source = Join-Path $fixtureRoot 'win32_acceptance_fixture.cc'
$manifest = Join-Path $fixtureRoot 'win32_acceptance_fixture.manifest'
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$executable = Join-Path $outputRoot 'sprint-coder-computer-use-fixture.exe'
$object = Join-Path $outputRoot 'win32_acceptance_fixture.obj'

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

& cl.exe `
  /nologo `
  /std:c++20 `
  /EHsc `
  /O2 `
  /MT `
  /W4 `
  /WX `
  /GS `
  /guard:cf `
  /sdl `
  /permissive- `
  /utf-8 `
  /DUNICODE `
  /D_UNICODE `
  /DWIN32_LEAN_AND_MEAN `
  /D_WIN32_WINNT=0x0A00 `
  "/I$fixtureRoot" `
  $source `
  "/Fo$object" `
  "/Fe$executable" `
  /link `
  /SUBSYSTEM:WINDOWS,10.00 `
  /guard:cf `
  /NXCOMPAT `
  /DYNAMICBASE `
  /HIGHENTROPYVA `
  "/MANIFESTINPUT:$manifest" `
  user32.lib `
  gdi32.lib `
  comctl32.lib `
  comdlg32.lib `
  shell32.lib
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$bytes = [System.IO.File]::ReadAllBytes($executable)
if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
  throw 'Acceptance fixture is not a PE executable'
}
$peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
if ($peOffset -lt 0 -or ($peOffset + 6) -gt $bytes.Length) {
  throw 'Acceptance fixture has an invalid PE header offset'
}
$machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
if ($machine -ne 0x8664) {
  throw ('Acceptance fixture is not x64 (machine=0x{0:X4})' -f $machine)
}

$process = Start-Process -FilePath $executable -ArgumentList '--contract-check' -Wait -PassThru
if ($process.ExitCode -ne 0) {
  throw "Acceptance fixture contract check failed with exit code $($process.ExitCode)"
}

Write-Output "Win32 acceptance fixture: PASS ($executable)"
