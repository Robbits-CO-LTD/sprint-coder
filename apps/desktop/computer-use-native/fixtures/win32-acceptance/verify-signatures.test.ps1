# Dependency-free headless unit tests; no certificates, files, or GUI are changed.
. "$PSScriptRoot/verify-signatures.ps1"
$ErrorActionPreference = 'Stop'
$testThumbprint = 'A' * 40
$testSubject = 'CN=Fixture Test Publisher'
$testCount = 0

function New-TestSignature {
  [pscustomobject]@{
    Status = 'Valid'
    SignerCertificate = [pscustomobject]@{ Thumbprint = $testThumbprint; Subject = $testSubject }
    TimeStamperCertificate = [pscustomobject]@{ Subject = 'CN=Test timestamp authority' }
  }
}

function Assert-TestRejected([object]$Signature, [string]$ExpectedCode) {
  $actualCode = ''
  try {
    Assert-ComputerUseSignature $Signature $testThumbprint $testSubject
  } catch { $actualCode = $_.Exception.Message }
  if ($actualCode -cne $ExpectedCode) { throw "Expected $ExpectedCode, received $actualCode" }
}

Assert-ComputerUseSignature (New-TestSignature) $testThumbprint $testSubject
$testCount++
foreach ($status in @('NotSigned', 'HashMismatch', 'NotTrusted', 'UnknownError')) {
  $signature = New-TestSignature
  $signature.Status = $status
  Assert-TestRejected $signature 'SIGNATURE_INVALID'
  $testCount++
}
$signature = New-TestSignature
$signature.SignerCertificate = $null
Assert-TestRejected $signature 'SIGNATURE_INVALID'
$testCount++
$signature = New-TestSignature
$signature.SignerCertificate.Thumbprint = 'B' * 40
Assert-TestRejected $signature 'SIGNER_MISMATCH'
$testCount++
$signature = New-TestSignature
$signature.SignerCertificate.Subject = "$testSubject Impersonator"
Assert-TestRejected $signature 'SIGNER_MISMATCH'
$testCount++
$signature = New-TestSignature
$signature.TimeStamperCertificate = $null
Assert-TestRejected $signature 'TIMESTAMP_MISSING'
$testCount++

# Exercise the traversal/hash/signature/verification orchestration with in-memory OS doubles.
# These are unit proofs, not Windows signed-package or runtime acceptance.
$testEntryAttributes = 0
$testItemAttributes = 0
$testMissingArtifact = $false
$testChangedDigest = $false
$script:testHashCalls = 0
$testUnsignedLibrary = $false
function Test-Path { param($LiteralPath, $PathType)
  return -not ($testMissingArtifact -and $LiteralPath -eq 'C:\unit\fixture.exe')
}
function Get-ChildItem { param($LiteralPath, [switch]$Recurse, [switch]$Force)
  [pscustomobject]@{ Attributes = $testEntryAttributes; PSIsContainer = $false; Extension = '.dll'; FullName = 'C:\unit\native.dll' }
  [pscustomobject]@{ Attributes = 0; PSIsContainer = $false; Extension = '.node'; FullName = 'C:\unit\native.node' }
}
function Get-Item { param($LiteralPath, [switch]$Force) [pscustomobject]@{ Attributes = $testItemAttributes } }
function Get-AuthenticodeSignature { param($LiteralPath)
  $signature = New-TestSignature
  if ($testUnsignedLibrary -and $LiteralPath -eq 'C:\unit\native.dll') { $signature.Status = 'NotSigned' }
  return $signature
}
function Get-FileHash { param($Algorithm, $LiteralPath)
  $script:testHashCalls++
  $hash = if ($testChangedDigest -and $script:testHashCalls % 2 -eq 0) { 'E' * 64 } else { 'D' * 64 }
  [pscustomobject]@{ Hash = $hash }
}
function Invoke-TestSignTool {
  if (($args[0..3] -join ' ') -cne 'verify /pa /all /tw') { throw 'Unexpected signing tool arguments' }
  $global:LASTEXITCODE = $testSignToolExit
}
$testSignToolExit = 0
$testParams = @{
  AppPath = 'C:\unit\app.exe'; HelperPath = 'C:\unit\helper.exe'
  InstallerPath = 'C:\unit\installer.exe'; FixturePath = 'C:\unit\fixture.exe'
  SignToolPath = 'Invoke-TestSignTool'; ExpectedThumbprint = $testThumbprint; ExpectedSubject = $testSubject
}
$result = Test-ComputerUseSignedArtifacts @testParams
if ($result.artifacts.Count -ne 6 -or $result.interactiveAcceptance -cne 'NOT_RUN') { throw 'Preflight scope mismatch' }
if (@($result.artifacts | Where-Object { $_.role -eq 'native-library' }).Count -ne 2) { throw 'Native library omitted' }
$testCount++
function Assert-PreflightRejected([string]$ExpectedCode) {
  $actualCode = ''
  try { Test-ComputerUseSignedArtifacts @testParams | Out-Null } catch { $actualCode = $_.Exception.Message }
  if ($actualCode -cne $ExpectedCode) { throw "Expected $ExpectedCode, received $actualCode" }
}
foreach ($exitCode in @(1, 2)) {
  $testSignToolExit = $exitCode
  Assert-PreflightRejected 'SIGNTOOL_VERIFICATION_FAILED'
  $testCount++
}
$testSignToolExit = 0
$testParams.FixturePath = $testParams.AppPath
Assert-PreflightRejected 'ARTIFACT_PATHS_NOT_DISTINCT'
$testCount++
$testParams.FixturePath = 'C:\unit\fixture.exe'
$testEntryAttributes = [IO.FileAttributes]::ReparsePoint
Assert-PreflightRejected 'PACKAGE_REPARSE_POINT'
$testCount++
$testEntryAttributes = 0
$testItemAttributes = [IO.FileAttributes]::ReparsePoint
Assert-PreflightRejected 'ARTIFACT_REPARSE_POINT'
$testCount++
$testItemAttributes = 0
$testMissingArtifact = $true
Assert-PreflightRejected 'ARTIFACT_MISSING'
$testCount++
$testMissingArtifact = $false
$testUnsignedLibrary = $true
Assert-PreflightRejected 'SIGNATURE_INVALID'
$testCount++
$testUnsignedLibrary = $false
$testChangedDigest = $true
$script:testHashCalls = 0
Assert-PreflightRejected 'ARTIFACT_CHANGED_DURING_VERIFICATION'
$testCount++
$testChangedDigest = $false
$testParams.ExpectedThumbprint = 'not-a-thumbprint'
Assert-PreflightRejected 'EXPECTED_SIGNER_REQUIRED'
$testCount++
"Signature preflight unit tests: $testCount passed; interactive acceptance NOT_RUN"
