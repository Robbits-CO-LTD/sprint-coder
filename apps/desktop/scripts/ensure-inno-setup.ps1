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

$signature = Get-AuthenticodeSignature -LiteralPath $compiler
$publisher = if ($signature.SignerCertificate) {
  $signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
  )
} else {
  ''
}
if (
  $signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
  $publisher -ne 'Pyrsys B.V.'
) {
  throw "Inno Setup compiler signature is not valid for the expected publisher Pyrsys B.V. (status: $($signature.Status), publisher: $publisher)."
}

$version = (Get-Item -LiteralPath $compiler).VersionInfo.ProductVersion
Write-Host "Using Inno Setup $version signed by $publisher at $compiler"
if ($env:GITHUB_ENV) {
  "SPRINT_CODER_ISCC_PATH=$compiler" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
}
