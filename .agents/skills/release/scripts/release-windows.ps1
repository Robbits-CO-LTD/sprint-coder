[CmdletBinding()]
# Keep this file UTF-8 with BOM so Windows PowerShell 5.1 can parse the Japanese release-note text.
param(
  [string]$Tag,
  [string]$CertificateSha1,
  [string]$Repository = 'Robbits-CO-LTD/sprint-coder',
  [string]$CertificateSubjectPattern = 'CN=ROBBITS INC.',
  [switch]$CreateDraftIfMissing,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-NativeSuccess([string]$Operation) {
  if ($LASTEXITCODE -ne 0) { throw "$Operation failed with exit code $LASTEXITCODE." }
}

function Assert-ReleaseState([object]$Release, [string]$ExpectedCommit) {
  if (-not $Release.isDraft) { throw "Release $Tag is not a draft; refusing to modify published assets." }
  $targetCommitish = [string]$Release.targetCommitish
  if ([string]::IsNullOrWhiteSpace($targetCommitish)) { throw "Release $Tag has no target commit." }
  $resolvedTarget = gh api "repos/$Repository/commits/$targetCommitish" --jq .sha 2>$null
  Assert-NativeSuccess "Resolve release target $targetCommitish"
  if (([string]$resolvedTarget).Trim() -ne $ExpectedCommit) {
    throw "Release $Tag targets $(([string]$resolvedTarget).Trim()), but HEAD is $ExpectedCommit."
  }
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$manifestPath = Join-Path $repositoryRoot 'apps\desktop\package.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$version = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($Tag)) { $Tag = "v$version" }
if ($Tag -ne "v$version") { throw "Tag $Tag does not match desktop version v$version." }

Push-Location $repositoryRoot
try {
  $status = @(git status --porcelain)
  Assert-NativeSuccess 'git status'
  if ($status.Count -ne 0 -and -not $SkipBuild) {
    throw 'The working tree must be clean before a release build.'
  }

  gh auth status 2>$null | Out-Null
  Assert-NativeSuccess 'GitHub authentication check'
  $headCommit = (git rev-parse HEAD).Trim()
  Assert-NativeSuccess 'git rev-parse HEAD'
  $tagCommit = $null
  $tagOutput = git rev-list -n 1 $Tag 2>$null
  if ($LASTEXITCODE -eq 0) { $tagCommit = ([string]$tagOutput).Trim() }
  if (-not [string]::IsNullOrWhiteSpace($tagCommit) -and $tagCommit -ne $headCommit) {
    throw "Tag $Tag points to $tagCommit, but HEAD is $headCommit."
  }

  $release = $null
  $releaseJson = gh release view $Tag --repo $Repository --json tagName,isDraft,targetCommitish,body,assets 2>$null
  if ($LASTEXITCODE -eq 0) {
    $release = $releaseJson | ConvertFrom-Json
  } else {
    if (-not $CreateDraftIfMissing) {
      throw "Draft release $Tag was not found. Create it after the release PR is merged, or pass -CreateDraftIfMissing."
    }
    gh release create $Tag --repo $Repository --target $headCommit --title "Sprint Coder $version" --generate-notes --draft
    Assert-NativeSuccess "Create draft release $Tag"
    $releaseJson = gh release view $Tag --repo $Repository --json tagName,isDraft,targetCommitish,body,assets
    Assert-NativeSuccess "Read draft release $Tag"
    $release = $releaseJson | ConvertFrom-Json
  }
  Assert-ReleaseState $release $headCommit

  if ([string]::IsNullOrWhiteSpace($CertificateSha1)) {
    throw 'CertificateSha1 is required. Use the ROBBITS INC. code-signing certificate thumbprint.'
  }
  $normalizedThumbprint = $CertificateSha1.Replace(' ', '').ToUpperInvariant()
  if ($normalizedThumbprint -notmatch '^[0-9A-F]{40}$') {
    throw 'CertificateSha1 must be a 40-character SHA-1 thumbprint.'
  }
  $certificate = Get-ChildItem Cert:\CurrentUser\My | Where-Object {
    $_.Thumbprint -eq $normalizedThumbprint -and $_.HasPrivateKey
  } | Select-Object -First 1
  if ($null -eq $certificate) { throw "Certificate $normalizedThumbprint was not found with a private key in CurrentUser\My." }
  if ($certificate.Subject -notlike "*$CertificateSubjectPattern*") {
    throw "Certificate subject '$($certificate.Subject)' does not match '$CertificateSubjectPattern'."
  }
  if ($certificate.NotAfter -le (Get-Date)) { throw 'The Windows code-signing certificate is expired.' }
  if ($certificate.EnhancedKeyUsageList.ObjectId -notcontains '1.3.6.1.5.5.7.3.3') {
    throw 'The selected certificate is not valid for code signing.'
  }

  if (-not $SkipBuild) {
    $actualNodeVersion = (node -p 'process.versions.node').Trim()
    if ($actualNodeVersion -ne '22.23.2') { throw "Node 22.23.2 is required, got $actualNodeVersion." }

    $previousRelease = $env:SPRINT_CODER_RELEASE
    $previousThumbprint = $env:SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1
    try {
      $env:SPRINT_CODER_RELEASE = '1'
      $env:SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1 = $normalizedThumbprint
      npm ci
      Assert-NativeSuccess 'npm ci'
      node node_modules/electron/install.js
      Assert-NativeSuccess 'Electron installation'
      powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/ensure-inno-setup.ps1
      Assert-NativeSuccess 'Inno Setup verification'
      npm run make:windows
      Assert-NativeSuccess 'Windows release build'
    } finally {
      $env:SPRINT_CODER_RELEASE = $previousRelease
      $env:SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1 = $previousThumbprint
    }
  }

  $nugetVersion = [string](& node -e "process.stdout.write(require('electron-winstaller').convertVersion(process.argv[1]))" $version)
  Assert-NativeSuccess 'Resolve Squirrel package version'
  if ([string]::IsNullOrWhiteSpace($nugetVersion)) {
    throw "Could not resolve the Squirrel package version for $version."
  }
  $nupkgName = "SprintCoder-$($nugetVersion.Trim())-full.nupkg"
  $makeRoot = Join-Path $repositoryRoot 'apps\desktop\out\make'
  $installer = Join-Path $makeRoot 'squirrel.windows\x64\Sprint-Coder-Installer.exe'
  $releasesFile = Join-Path $makeRoot 'squirrel.windows\x64\RELEASES'
  $nupkg = Join-Path $makeRoot "squirrel.windows\x64\$nupkgName"
  $portableZip = Join-Path $makeRoot "zip\win32\x64\Sprint Coder-win32-x64-$version.zip"
  foreach ($path in @($installer, $releasesFile, $nupkg, $portableZip)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required artifact was not found: $path" }
  }

  $installerSignature = Get-AuthenticodeSignature -LiteralPath $installer
  if ($installerSignature.Status -ne 'Valid') { throw "Installer signature is $($installerSignature.Status), not Valid." }
  if ($installerSignature.SignerCertificate.Thumbprint -ne $normalizedThumbprint) {
    throw 'Installer signer does not match the selected certificate.'
  }
  if ($installerSignature.SignerCertificate.Subject -notlike "*$CertificateSubjectPattern*") {
    throw 'Installer signer subject is not the expected publisher.'
  }

  $releasesContent = Get-Content -Raw -LiteralPath $releasesFile
  if ($releasesContent -notmatch [regex]::Escape($nupkgName)) {
    throw 'RELEASES does not reference the expected full nupkg.'
  }

  $stagingDirectory = Join-Path ([IO.Path]::GetTempPath()) "sprint-coder-release-$version-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $stagingDirectory | Out-Null
  try {
    $stagedInstaller = Join-Path $stagingDirectory 'Sprint-Coder-Installer.exe'
    $stagedReleases = Join-Path $stagingDirectory 'RELEASES'
    $stagedNupkg = Join-Path $stagingDirectory $nupkgName
    $stagedPortableZip = Join-Path $stagingDirectory "Sprint-Coder-win32-x64-$version.zip"
    Copy-Item -LiteralPath $installer -Destination $stagedInstaller
    Copy-Item -LiteralPath $releasesFile -Destination $stagedReleases
    Copy-Item -LiteralPath $nupkg -Destination $stagedNupkg
    Copy-Item -LiteralPath $portableZip -Destination $stagedPortableZip

    # Re-check after the potentially long build. Never use --clobber: replacing an asset that was
    # published concurrently is more dangerous than requiring a deliberate cleanup and rerun.
    $releaseJson = gh release view $Tag --repo $Repository --json body,assets,isDraft,targetCommitish
    Assert-NativeSuccess "Re-check draft release $Tag before upload"
    $release = $releaseJson | ConvertFrom-Json
    Assert-ReleaseState $release $headCommit
    $assetNames = @($release.assets | ForEach-Object { [string]$_.name })
    foreach ($expected in @('Sprint-Coder-Installer.exe', "Sprint-Coder-win32-x64-$version.zip", $nupkgName, 'RELEASES')) {
      if ($assetNames -contains $expected) {
        throw "Release asset already exists and will not be overwritten: $expected"
      }
    }

    gh release upload $Tag --repo $Repository `
      "$stagedInstaller#Windows x64 signed installer" `
      "$stagedPortableZip#Windows x64 portable ZIP" `
      "$stagedNupkg#Windows automatic update package" `
      "$stagedReleases#Windows automatic update feed"
    Assert-NativeSuccess "Upload Windows assets to $Tag"

    $releaseJson = gh release view $Tag --repo $Repository --json body,assets,isDraft,targetCommitish
    Assert-NativeSuccess "Verify uploaded assets on $Tag"
    $release = $releaseJson | ConvertFrom-Json
    Assert-ReleaseState $release $headCommit
    $assetNames = @($release.assets | ForEach-Object { [string]$_.name })
    foreach ($expected in @('Sprint-Coder-Installer.exe', "Sprint-Coder-win32-x64-$version.zip", $nupkgName, 'RELEASES')) {
      if ($assetNames -notcontains $expected) { throw "Uploaded asset was not found on GitHub: $expected" }
    }

    $baseUrl = "https://github.com/$Repository/releases/download/$Tag"
    $dmgAssets = @($assetNames | Where-Object { $_ -match '(?i)arm64.*\.dmg$|\.dmg$' })
    $macLine = if ($dmgAssets.Count -eq 1) {
      "[macOS（Apple Silicon / arm64版）]($baseUrl/$([uri]::EscapeDataString($dmgAssets[0])))"
    } else {
      'macOS版は準備中です。'
    }
    $packageGuide = @"
<!-- release-skill:packages:start -->
## パッケージ案内

Windows

[Windows（x64版・コード署名済みインストーラー）]($baseUrl/Sprint-Coder-Installer.exe)

macOS

$macLine
<!-- release-skill:packages:end -->
"@
    $body = [string]$release.body
    $pattern = '(?s)<!-- release-skill:packages:start -->.*?<!-- release-skill:packages:end -->\s*'
    if ($body -match $pattern) { $body = [regex]::Replace($body, $pattern, '') }
    $notesPath = Join-Path $stagingDirectory 'release-notes.md'
    Set-Content -LiteralPath $notesPath -Value "$packageGuide`r`n`r`n$body" -Encoding utf8
    gh release edit $Tag --repo $Repository --notes-file $notesPath
    Assert-NativeSuccess "Update release notes for $Tag"
  } finally {
    Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
  }

  Write-Output "Prepared draft release $Tag with verified Windows artifacts."
} finally {
  Pop-Location
}
