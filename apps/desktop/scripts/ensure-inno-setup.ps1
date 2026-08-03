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
$expectedCertificateSha256 = '4EFD84E6F1091B19321231743B9AA86482EFFD6D0BEA9F7A44DB6211154616F3'
$certificateSha256 = if ($signature.SignerCertificate) {
  [System.BitConverter]::ToString(
    $signature.SignerCertificate.GetCertHash(
      [System.Security.Cryptography.HashAlgorithmName]::SHA256
    )
  ).Replace('-', '')
} else {
  ''
}
if (
  $signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
  $publisher -ne 'Pyrsys B.V.' -or
  $certificateSha256 -ne $expectedCertificateSha256
) {
  throw "Inno Setup compiler signature does not match the trusted Pyrsys B.V. certificate (status: $($signature.Status), publisher: $publisher, certificate SHA-256: $certificateSha256)."
}

$version = (Get-Item -LiteralPath $compiler).VersionInfo.ProductVersion
Write-Host "Using Inno Setup $version signed by trusted publisher $publisher at $compiler"
if ($env:GITHUB_ENV) {
  "SPRINT_CODER_ISCC_PATH=$compiler" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
}
