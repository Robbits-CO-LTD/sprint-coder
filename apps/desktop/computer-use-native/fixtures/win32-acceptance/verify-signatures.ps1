# Read-only preparation for #387. Dot-source, then invoke Test-ComputerUseSignedArtifacts.
# This emits signature metadata only, never Core/Safety acceptance evidence.
Set-StrictMode -Version Latest

function Assert-ComputerUseSignature {
  param(
    [Parameter(Mandatory)][object]$Signature,
    [Parameter(Mandatory)][string]$ExpectedThumbprint,
    [Parameter(Mandatory)][string]$ExpectedSubject
  )
  if ($Signature.Status -ne 'Valid' -or $null -eq $Signature.SignerCertificate) {
    throw 'SIGNATURE_INVALID'
  }
  if (
    $Signature.SignerCertificate.Thumbprint -ine $ExpectedThumbprint -or
    $Signature.SignerCertificate.Subject -cne $ExpectedSubject
  ) { throw 'SIGNER_MISMATCH' }
  if ($null -eq $Signature.TimeStamperCertificate) { throw 'TIMESTAMP_MISSING' }
}

function Test-ComputerUseSignedArtifacts {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$AppPath,
    [Parameter(Mandatory)][string]$HelperPath,
    [Parameter(Mandatory)][string]$InstallerPath,
    [Parameter(Mandatory)][string]$FixturePath,
    [Parameter(Mandatory)][string]$SignToolPath,
    [Parameter(Mandatory)][string]$ExpectedThumbprint,
    [Parameter(Mandatory)][string]$ExpectedSubject
  )
  $ErrorActionPreference = 'Stop'
  $thumbprint = $ExpectedThumbprint.Replace(' ', '').ToUpperInvariant()
  if ($thumbprint -notmatch '^[0-9A-F]{40}$' -or [string]::IsNullOrWhiteSpace($ExpectedSubject)) {
    throw 'EXPECTED_SIGNER_REQUIRED'
  }
  if (-not (Test-Path -LiteralPath $SignToolPath -PathType Leaf)) { throw 'SIGNTOOL_MISSING' }

  $artifacts = @(
    @{ Role = 'app'; Path = $AppPath },
    @{ Role = 'helper'; Path = $HelperPath },
    @{ Role = 'installer'; Path = $InstallerPath },
    @{ Role = 'fixture'; Path = $FixturePath }
  )
  $appRoot = Split-Path -Parent ([IO.Path]::GetFullPath($AppPath))
  # Validate packaged native libraries too; an app/helper signature does not cover DLL bytes.
  $entries = @(Get-ChildItem -LiteralPath $appRoot -Recurse -Force)
  if (@($entries | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) {
    throw 'PACKAGE_REPARSE_POINT'
  }
  foreach ($entry in $entries) {
    if (-not $entry.PSIsContainer -and $entry.Extension -in @('.dll', '.node')) {
      $artifacts += @{ Role = 'native-library'; Path = $entry.FullName }
    }
  }
  $paths = @($artifacts | ForEach-Object { [IO.Path]::GetFullPath($_.Path).ToUpperInvariant() })
  if (@($paths | Select-Object -Unique).Count -ne $paths.Count) { throw 'ARTIFACT_PATHS_NOT_DISTINCT' }

  $results = @()
  foreach ($artifact in $artifacts) {
    if (-not (Test-Path -LiteralPath $artifact.Path -PathType Leaf)) { throw 'ARTIFACT_MISSING' }
    $item = Get-Item -LiteralPath $artifact.Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ARTIFACT_REPARSE_POINT' }
    $before = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact.Path).Hash
    $signature = Get-AuthenticodeSignature -LiteralPath $artifact.Path
    Assert-ComputerUseSignature -Signature $signature -ExpectedThumbprint $thumbprint -ExpectedSubject $ExpectedSubject
    # /all validates every embedded signature; /tw makes a missing timestamp a warning.
    # Exit 2 (warnings), as well as exit 1 (failure), must keep this preparation gate blocked.
    & $SignToolPath verify /pa /all /tw $artifact.Path *> $null
    if ($LASTEXITCODE -ne 0) { throw 'SIGNTOOL_VERIFICATION_FAILED' }
    $after = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact.Path).Hash
    if ($before -cne $after) { throw 'ARTIFACT_CHANGED_DURING_VERIFICATION' }
    $results += [pscustomobject]@{
      role = $artifact.Role
      sha256 = $after.ToLowerInvariant()
      signerThumbprint = $thumbprint
      timestampPresent = $true
    }
  }
  [pscustomobject]@{
    schemaVersion = 1
    scope = 'signature-preflight-only'
    interactiveAcceptance = 'NOT_RUN'
    artifacts = $results
  }
}
