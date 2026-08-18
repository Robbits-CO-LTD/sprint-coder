[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[^/]+/[^/]+$')][string]$Repository,
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$BodyPath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$Fingerprint,
    [Parameter(Mandatory = $true)][string]$IndexPath,
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40,64}$')][string]$SourceSha,
    [Parameter(Mandatory = $true)][bool]$PromotionPassed,
    [Parameter(Mandatory = $true)]
    [ValidateSet('unique', 'duplicate_open', 'fix_in_progress', 'regression_hold', 'collision', 'dedup_incomplete')]
    [string]$DedupResult,
    [ValidateRange(1, 5)][int]$MaxIssues = 5,
    [string[]]$LabelCandidates = @('bug', 'e2e', 'e2e-finding'),
    [switch]$DryRun,
    [string]$GhCommand = 'gh'
)

$ErrorActionPreference = 'Stop'
$marker = "<!-- e2e-patrol:fingerprint=$Fingerprint -->"
$haltPath = "$IndexPath.halt-$RunId"

if (-not $PromotionPassed) {
    throw 'Finding promotion gate did not pass.'
}
if ($DedupResult -ne 'unique') {
    throw "Finding is not unique: $DedupResult"
}
if (-not $DryRun -and (Test-Path -LiteralPath $haltPath -PathType Leaf)) {
    throw 'This run is halted after an earlier GitHub creation or verification failure.'
}

if (-not (Test-Path -LiteralPath $BodyPath -PathType Leaf)) {
    throw "BodyPath does not exist: $BodyPath"
}
$body = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $BodyPath).Path)
if ([regex]::Matches($body, [regex]::Escape($marker)).Count -ne 1) {
    throw 'Body must contain exactly one expected fingerprint marker.'
}
$redactor = Join-Path $PSScriptRoot 'Protect-E2ePatrolText.ps1'
$titleCheck = & $redactor -Text $Title
$bodyCheck = & $redactor -Text $body
if (-not $titleCheck.passed -or -not $bodyCheck.passed -or $titleCheck.text -ne $Title -or $bodyCheck.text -ne $body) {
    throw 'Title or body failed the final redaction gate.'
}

if ($DryRun) {
    return [pscustomobject]@{
        mode = 'dry_run'
        created = $false
        title = $Title
        body_path = $BodyPath
        labels = @()
    }
}

function Invoke-Gh {
    param([string[]]$Arguments)
    $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) ("e2e-patrol-gh-" + [Guid]::NewGuid().ToString('N') + '.stderr')
    $previousErrorActionPreference = $ErrorActionPreference
    $output = @()
    $exitCode = 1
    $invokeFailed = $false
    try {
        $ErrorActionPreference = 'Continue'
        try {
            $output = @(& $GhCommand @Arguments 2> $stderrPath)
            $exitCode = $LASTEXITCODE
        } catch {
            $invokeFailed = $true
        }
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if (Test-Path -LiteralPath $stderrPath) {
            Remove-Item -LiteralPath $stderrPath -Force
        }
    }
    if ($invokeFailed -or $exitCode -ne 0) {
        throw "GitHub command failed with exit code $exitCode."
    }
    return ($output -join "`n")
}

$index = $null
if (Test-Path -LiteralPath $IndexPath -PathType Leaf) {
    try {
        $index = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $IndexPath).Path) | ConvertFrom-Json
    } catch {
        throw "Index is invalid: $($_.Exception.Message)"
    }
}
if ($null -eq $index) {
    $index = [pscustomobject]@{
        schema_version = 1
        repository = $Repository
        created_issues = @()
    }
}
if ($index.repository -ne $Repository) {
    throw 'Index repository does not match the target repository.'
}
$runCount = @($index.created_issues | Where-Object { $_.run_id -eq $RunId }).Count
if ($runCount -ge $MaxIssues) {
    throw 'Verified Issue limit reached for this run.'
}
if (@($index.created_issues | Where-Object { $_.fingerprint -eq $Fingerprint }).Count -gt 0) {
    throw 'Fingerprint already exists in the local creation index.'
}

try {
    $labelJson = Invoke-Gh @('label', 'list', '--repo', $Repository, '--limit', '200', '--json', 'name')
    try {
        $availableLabels = @($labelJson | ConvertFrom-Json | ForEach-Object { $_.name })
    } catch {
        throw "Label inventory returned invalid JSON: $($_.Exception.Message)"
    }

    $selectedLabels = New-Object System.Collections.Generic.List[string]
    if (($LabelCandidates -contains 'bug') -and ($availableLabels -contains 'bug')) {
        $selectedLabels.Add('bug')
    }
    foreach ($candidate in @($LabelCandidates | Where-Object { $_ -ne 'bug' })) {
        if ($availableLabels -contains $candidate) {
            $selectedLabels.Add($candidate)
            break
        }
    }

    $createArgs = @('issue', 'create', '--repo', $Repository, '--title', $Title, '--body-file', $BodyPath)
    foreach ($label in $selectedLabels) {
        $createArgs += @('--label', $label)
    }
    $issueUrl = (Invoke-Gh $createArgs).Trim()
    if ($issueUrl -notmatch '/issues/(\d+)$') {
        throw "Issue creation did not return a recognized URL: $issueUrl"
    }
    $issueNumber = [int]$Matches[1]

    $viewJson = Invoke-Gh @('issue', 'view', $issueNumber.ToString(), '--repo', $Repository, '--json', 'number,title,body,state,url,labels')
    try {
        $view = $viewJson | ConvertFrom-Json
    } catch {
        throw "Issue verification returned invalid JSON: $($_.Exception.Message)"
    }

    $verifiedLabels = @($view.labels | ForEach-Object { $_.name })
    $verificationErrors = New-Object System.Collections.Generic.List[string]
    if ($view.state -ne 'OPEN') { $verificationErrors.Add('state') }
    if ($view.title -ne $Title) { $verificationErrors.Add('title') }
    if ($view.url -ne $issueUrl) { $verificationErrors.Add('url') }
    if ([regex]::Matches([string]$view.body, [regex]::Escape($marker)).Count -ne 1) { $verificationErrors.Add('marker') }
    foreach ($label in $selectedLabels) {
        if ($verifiedLabels -notcontains $label) { $verificationErrors.Add("label:$label") }
    }
    if ($verificationErrors.Count -gt 0) {
        throw "Post-create verification failed: $($verificationErrors -join ', ')"
    }
} catch {
    $haltParent = Split-Path -Parent $haltPath
    if ($haltParent) {
        [void](New-Item -ItemType Directory -Path $haltParent -Force)
    }
    $haltText = "halted_at=$([DateTime]::UtcNow.ToString('o'))`r`nreason=github_creation_or_verification_failed`r`n"
    [System.IO.File]::WriteAllText($haltPath, $haltText, (New-Object System.Text.UTF8Encoding($false)))
    throw
}

$newEntry = [pscustomobject]@{
    fingerprint = $Fingerprint
    number = $issueNumber
    url = $issueUrl
    source_sha = $SourceSha.ToLowerInvariant()
    run_id = $RunId
    verified_at = [DateTime]::UtcNow.ToString('o')
}
$index.created_issues = @($index.created_issues) + @($newEntry)
$parent = Split-Path -Parent $IndexPath
if ($parent) {
    [void](New-Item -ItemType Directory -Path $parent -Force)
}
$tempPath = "$IndexPath.tmp-$([Guid]::NewGuid().ToString('N'))"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
try {
    [System.IO.File]::WriteAllText($tempPath, ($index | ConvertTo-Json -Depth 20), $utf8NoBom)
    Move-Item -LiteralPath $tempPath -Destination $IndexPath -Force
} finally {
    if (Test-Path -LiteralPath $tempPath) {
        Remove-Item -LiteralPath $tempPath -Force
    }
}

[pscustomobject]@{
    mode = 'live'
    created = $true
    number = $issueNumber
    url = $issueUrl
    labels = @($selectedLabels)
}
