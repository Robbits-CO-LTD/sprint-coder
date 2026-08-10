[CmdletBinding()]
param(
  [switch]$RenamePortableZip
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$version = [string](Get-Content -Raw -LiteralPath (Join-Path $desktopRoot 'package.json') | ConvertFrom-Json).version
$makeRoot = Join-Path $desktopRoot 'out\make'
$installer = Join-Path $makeRoot 'squirrel.windows\x64\Sprint-Coder-Installer.exe'
$rawSetup = Join-Path $makeRoot 'squirrel.windows\x64\Sprint-Coder-Setup.exe'
$releasesFile = Join-Path $makeRoot 'squirrel.windows\x64\RELEASES'
$nupkg = Join-Path $makeRoot "squirrel.windows\x64\SprintCoder-$version-full.nupkg"
$portableSource = Join-Path $makeRoot "zip\win32\x64\Sprint Coder-win32-x64-$version.zip"
$portableAsset = Join-Path $makeRoot "zip\win32\x64\Sprint-Coder-win32-x64-$version.zip"
$appExecutable = Join-Path $desktopRoot 'out\Sprint Coder-win32-x64\Sprint Coder.exe'

foreach ($path in @($installer, $releasesFile, $nupkg, $appExecutable)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Required Windows artifact was not found: $path"
  }
}
if (Test-Path -LiteralPath $rawSetup) {
  throw "Raw Squirrel setup must not remain user-facing: $rawSetup"
}
$portableSourceExists = Test-Path -LiteralPath $portableSource -PathType Leaf
$portableAssetExists = Test-Path -LiteralPath $portableAsset -PathType Leaf
if (-not $portableSourceExists -and -not $portableAssetExists) {
  throw "Required Windows portable ZIP was not found: $portableSource"
}

$installerSignature = Get-AuthenticodeSignature -LiteralPath $installer
if ($installerSignature.Status -ne 'NotSigned') {
  throw "Expected an explicitly unsigned Windows installer, got $($installerSignature.Status)."
}
$appSignature = Get-AuthenticodeSignature -LiteralPath $appExecutable
if ($appSignature.Status -ne 'NotSigned') {
  throw "Expected an explicitly unsigned packaged app, got $($appSignature.Status)."
}
if ((Get-Content -Raw -LiteralPath $releasesFile) -notmatch [regex]::Escape("SprintCoder-$version-full.nupkg")) {
  throw 'RELEASES does not reference the expected full nupkg.'
}

if ($RenamePortableZip -and (Test-Path -LiteralPath $portableSource -PathType Leaf)) {
  if (Test-Path -LiteralPath $portableAsset) {
    throw "Portable ZIP destination already exists: $portableAsset"
  }
  Move-Item -LiteralPath $portableSource -Destination $portableAsset
}

Write-Output "Verified intentionally unsigned Windows $version release artifacts."
