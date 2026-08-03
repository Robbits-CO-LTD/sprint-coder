$ErrorActionPreference = 'Stop'

$compiler = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
  if (Get-Command choco.exe -ErrorAction SilentlyContinue) {
    choco install innosetup --version=6.7.1 --yes --no-progress
  }
}

if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
  throw 'Inno Setup 6 compiler was not found after provisioning.'
}

$version = (Get-Item -LiteralPath $compiler).VersionInfo.ProductVersion
Write-Host "Using Inno Setup $version at $compiler"
if ($env:GITHUB_ENV) {
  "SPRINT_CODER_ISCC_PATH=$compiler" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
}
