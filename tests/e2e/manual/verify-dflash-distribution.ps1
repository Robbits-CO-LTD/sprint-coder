param([Parameter(Mandatory=$true)][string]$Lane)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipPath = Join-Path $Lane 'beta3.zip'
$expectedZip = '663a29379f9908f1f9d0beea1e7d4eb89df526748d8326e198f19fe97cf3daeb'
if ((Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedZip) { throw 'Release archive mismatch' }
$archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
$count = 0
$differences = @()
try {
    foreach ($entry in $archive.Entries) {
        if ($entry.FullName.EndsWith('/')) { continue }
        $stream = $entry.Open()
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $expected = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
        finally { $sha.Dispose(); $stream.Dispose() }
        $file = Join-Path (Join-Path $Lane 'app') $entry.FullName
        $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { $differences += [pscustomobject]@{ path=$entry.FullName; original=$expected; inspected=$actual } }
        $count++
    }
} finally { $archive.Dispose() }
if ($differences.Count -ne 1 -or $differences[0].path -ne 'Sprint Coder.exe') { throw 'Changes beyond the disposable inspector executable' }
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
}
$result | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $Lane 'distribution-equivalence.json') -Encoding UTF8
$result | ConvertTo-Json -Depth 6
