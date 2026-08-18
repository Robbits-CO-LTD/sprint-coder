[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[^/]+/[^/]+$')][string]$Repository,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$Fingerprint,
    [Parameter(Mandatory = $true)][string]$Screen,
    [Parameter(Mandatory = $true)][string]$Symptom,
    [Parameter(Mandatory = $true)][string]$Impact,
    [string]$IndexPath,
    [string]$GhCommand = 'gh'
)

$ErrorActionPreference = 'Stop'
$marker = "<!-- e2e-patrol:fingerprint=$Fingerprint -->"

function Normalize-SemanticText {
    param([string]$Value)
    if ($null -eq $Value) { return '' }
    return ([regex]::Replace($Value.Trim().ToLowerInvariant(), '\s+', ' '))
}

function Test-SemanticMatch {
    param([string]$Haystack)
    $normalized = Normalize-SemanticText $Haystack
    return (
        $normalized.Contains((Normalize-SemanticText $Screen)) -and
        $normalized.Contains((Normalize-SemanticText $Symptom)) -and
        $normalized.Contains((Normalize-SemanticText $Impact))
    )
}

function Invoke-GhJson {
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
        throw "GitHub inventory failed with exit code $exitCode."
    }
    try {
        return (($output -join "`n") | ConvertFrom-Json)
    } catch {
        throw "GitHub inventory returned invalid JSON: $($_.Exception.Message)"
    }
}

$pages = @(Invoke-GhJson @('api', '--method', 'GET', '--paginate', '--slurp', "repos/$Repository/issues", '-f', 'state=all', '-f', 'per_page=100'))
$inventory = New-Object System.Collections.Generic.List[object]
foreach ($page in $pages) {
    foreach ($item in @($page)) {
        $inventory.Add($item)
    }
}
$issues = @($inventory | Where-Object { $null -eq $_.pull_request })
$pulls = @($inventory | Where-Object { $null -ne $_.pull_request -and $_.state -eq 'open' })

$collision = $null
foreach ($issue in $issues) {
    $haystack = "$($issue.title)`n$($issue.body)"
    $markerMatch = $haystack.Contains($marker)
    $semanticMatch = Test-SemanticMatch $haystack
    if ($markerMatch -and $semanticMatch) {
        $result = if ($issue.state -eq 'OPEN') { 'duplicate_open' } else { 'regression_hold' }
        return [pscustomobject]@{ result = $result; url = $issue.html_url; number = $issue.number; source = 'issue' }
    }
    if (-not $markerMatch -and $semanticMatch) {
        $result = if ($issue.state -eq 'OPEN') { 'duplicate_open' } else { 'regression_hold' }
        return [pscustomobject]@{ result = $result; url = $issue.html_url; number = $issue.number; source = 'issue-semantic' }
    }
    if ($markerMatch -and -not $semanticMatch) {
        $collision = [pscustomobject]@{ result = 'collision'; url = $issue.html_url; number = $issue.number; source = 'issue-marker' }
    }
}

foreach ($pull in $pulls) {
    $haystack = "$($pull.title)`n$($pull.body)"
    if (Test-SemanticMatch $haystack) {
        return [pscustomobject]@{ result = 'fix_in_progress'; url = $pull.html_url; number = $pull.number; source = 'pull-request' }
    }
}

if ($collision) {
    return $collision
}

if ($IndexPath -and (Test-Path -LiteralPath $IndexPath -PathType Leaf)) {
    try {
        $index = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $IndexPath).Path) | ConvertFrom-Json
        $localMatch = @($index.created_issues | Where-Object { $_.fingerprint -eq $Fingerprint } | Select-Object -First 1)
        if ($localMatch.Count -gt 0) {
            return [pscustomobject]@{
                result = 'collision'
                url = $localMatch[0].url
                number = $localMatch[0].number
                source = 'local-index-unverified'
            }
        }
    } catch {
        throw "Local index could not be read: $($_.Exception.Message)"
    }
}

[pscustomobject]@{ result = 'unique'; url = $null; number = $null; source = 'inventory' }
