[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][ValidatePattern('^[^/]+/[^/]+$')][string]$Repository,
    [Parameter(Mandatory = $true)][string]$AppTargetId,
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][ValidateSet('local', 'preview', 'staging', 'production')][string]$Environment,
    [ValidateSet('smoke', 'focused', 'regression')][string]$Mode = 'smoke',
    [Parameter(Mandatory = $true)][ValidateSet('pre_merge', 'post_merge', 'deployed')][string]$RequiredPhase,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40,64}$')][string]$SourceSha,
    [ValidatePattern('^$|^[0-9a-fA-F]{64}$')][string]$ArtifactSha256 = '',
    [ValidateRange(1, 5)][int]$MaxIssues = 5,
    [ValidateRange(1, 480)][int]$MaxMinutes = 45,
    [switch]$DryRun,
    [string]$StateRoot
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $RepositoryRoot -PathType Container)) {
    throw "RepositoryRoot does not exist: $RepositoryRoot"
}

if ([string]::IsNullOrWhiteSpace($StateRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw 'LOCALAPPDATA is not available.'
    }
    $StateRoot = Join-Path $env:LOCALAPPDATA 'Codex\e2e-patrol'
}

$repositoryKey = ($Repository -replace '[^A-Za-z0-9._-]', '-')
$repositoryState = Join-Path $StateRoot $repositoryKey
$runId = '{0}-{1}' -f ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')), ([Guid]::NewGuid().ToString('N').Substring(0, 8))
$runPath = Join-Path $repositoryState $runId
$evidencePath = Join-Path $runPath 'evidence'
$issuesPath = Join-Path $runPath 'issues'

[void](New-Item -ItemType Directory -Path $evidencePath -Force)
[void](New-Item -ItemType Directory -Path $issuesPath -Force)

$manifest = [ordered]@{
    schema_version = 1
    run_id = $runId
    repository = $Repository
    repository_root = (Resolve-Path -LiteralPath $RepositoryRoot).Path
    app_target_id = $AppTargetId
    target = $Target
    environment = $Environment
    mode = $Mode
    filing_mode = $(if ($DryRun) { 'dry_run' } else { 'live' })
    required_phase = $RequiredPhase
    source_sha = $SourceSha.ToLowerInvariant()
    artifact_sha256 = $(if ($ArtifactSha256) { $ArtifactSha256.ToLowerInvariant() } else { $null })
    matrix_hash = $null
    state = 'init'
    limits = [ordered]@{
        max_issues = $MaxIssues
        max_minutes = $MaxMinutes
    }
    created_issues = @()
    discarded = @()
    started_at = [DateTime]::UtcNow.ToString('o')
    finished_at = $null
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$manifestPath = Join-Path $runPath 'manifest.json'
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10), $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $runPath 'matrix.md'), "# E2E matrix`r`n", $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $runPath 'findings.json'), "[]`r`n", $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $runPath 'report.md'), "# E2E Patrol report`r`n", $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $runPath 'events.jsonl'), '', $utf8NoBom)

[pscustomobject]@{
    run_id = $runId
    run_path = $runPath
    manifest_path = $manifestPath
    index_path = (Join-Path $repositoryState 'index.json')
    filing_mode = $manifest.filing_mode
}
