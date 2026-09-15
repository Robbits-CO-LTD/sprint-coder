param([Parameter(Mandatory=$true)][string]$Lane)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$node = 'C:\Users\yusei\sc-windows-validation-20260914\node-v22.23.2-win-x64\node.exe'
$dependencies = 'C:\Users\yusei\sc-windows-validation-20260914\repo'
# The shared guard verifies ownership before reading the ZIP, then compares equal
# chunks natively and enumerates byte offsets only inside unequal chunks.
$proofJson = & $node (Join-Path $PSScriptRoot 'dflash-windows-guard.cjs') $Lane $dependencies --require-inspector
if ($LASTEXITCODE -ne 0) { throw 'Owned lane or byte-level distribution preflight rejected' }
$proof = $proofJson | ConvertFrom-Json
$expectedZip = $proof.archiveSha256
$count = $proof.archiveFiles
$differences = @([pscustomobject]@{ path='Sprint Coder.exe'; original=$proof.originalExecutableSha256; inspected=$proof.inspectedExecutableSha256 })
$root = Join-Path $Lane 'app\resources\managed-local'
$manifestPath = Get-ChildItem $root -Filter managed-local-manifest.json -Recurse | Select-Object -First 1
if (-not $manifestPath) { throw 'Bundled runtime manifest missing' }
$manifest = Get-Content $manifestPath.FullName -Raw | ConvertFrom-Json
if ($manifest.runtimeVersion -ne 'b10809' -or $manifest.platform -ne 'win32' -or $manifest.architecture -ne 'x64' -or $manifest.speculativeDflash -ne $true) { throw 'Wrong runtime capability' }
foreach ($artifact in $manifest.artifacts) {
    $file = Join-Path $manifestPath.DirectoryName $artifact.path
    if ((Get-Item $file).Length -ne $artifact.byteLength -or (Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact.sha256) { throw 'Runtime artifact integrity mismatch' }
}
$result = [pscustomobject]@{
    archiveSha256=$expectedZip; archiveFiles=$count; differences=$differences;
    unchangedAppRuntimeNativeFiles=$true; runtimeVersion=$manifest.runtimeVersion;
    upstreamRevision=$manifest.upstreamRevision; runtimeArtifactCount=$manifest.artifacts.Count;
    speculativeDflash=$manifest.speculativeDflash; signedAcceptance='not required by original AC7';
    exactDistributionExecutable=$false
    byteComparison=$proof.byteComparison; version=$proof.version; source=$proof.source
}
$result | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $Lane 'distribution-equivalence.json') -Encoding UTF8
$result | ConvertTo-Json -Depth 6
