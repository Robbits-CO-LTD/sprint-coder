[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$Fingerprint,
    [Parameter(Mandatory = $true)][string]$Symptom,
    [Parameter(Mandatory = $true)][string]$Impact,
    [Parameter(Mandatory = $true)][string[]]$ReproSteps,
    [Parameter(Mandatory = $true)][string]$Expected,
    [Parameter(Mandatory = $true)][string]$ExpectationSource,
    [Parameter(Mandatory = $true)][string]$Actual,
    [Parameter(Mandatory = $true)][string[]]$ReproSessionIds,
    [Parameter(Mandatory = $true)][string[]]$ExcludedAlternatives,
    [Parameter(Mandatory = $true)][string]$Environment,
    [Parameter(Mandatory = $true)][string[]]$AcceptanceCriteria,
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40,64}$')][string]$SourceSha,
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][string]$FailureClass,
    [Parameter(Mandatory = $true)][ValidateSet('browser-use', 'computer-use')][string]$Driver,
    [string[]]$EvidenceNames = @(),
    [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$redactor = Join-Path $PSScriptRoot 'Protect-E2ePatrolText.ps1'
$ja = @'
{
  "symptomImpact": "\u75c7\u72b6\u3068\u5f71\u97ff",
  "reproSteps": "\u518d\u73fe\u624b\u9806",
  "expectedEvidence": "\u671f\u5f85\u3057\u305f\u7d50\u679c\u3068\u6839\u62e0",
  "actual": "\u5b9f\u969b\u306e\u7d50\u679c",
  "independentRepro": "\u72ec\u7acb\u518d\u73fe",
  "excluded": "\u9664\u5916\u3057\u305f\u5225\u306e\u8aac\u660e",
  "environment": "\u74b0\u5883",
  "acceptance": "\u5b8c\u4e86\u6761\u4ef6",
  "impact": "\u5f71\u97ff",
  "evidence": "\u6839\u62e0",
  "freshSession": "\u521d\u671f\u72b6\u614b\u3092\u5fa9\u5143\u3057\u305f\u5225\u30bb\u30c3\u30b7\u30e7\u30f3",
  "sameSymptom": "\u3067\u540c\u3058\u75c7\u72b6\u3092\u518d\u73fe"
}
'@ | ConvertFrom-Json

if (-not $Title.StartsWith('[bug] ')) {
    throw 'Title must start with [bug].'
}
if ($Title.Length -lt 25 -or $Title.Length -gt 70) {
    throw 'Title length must be between 25 and 70 characters.'
}
if ($Title -match '#\d+') {
    throw 'Title must not contain an Issue or PR number.'
}
if (@($ReproSessionIds | Select-Object -Unique).Count -lt 2) {
    throw 'Two distinct reproduction sessions are required.'
}

function Join-List {
    param([string[]]$Items)
    return (($Items | ForEach-Object { "- $_" }) -join "`r`n")
}

$marker = "<!-- e2e-patrol:fingerprint=$Fingerprint -->"
$body = @"
$marker

## $($ja.symptomImpact)

$Symptom

$($ja.impact): $Impact

## $($ja.reproSteps)

$(Join-List $ReproSteps)

## $($ja.expectedEvidence)

$Expected

$($ja.evidence): $ExpectationSource

## $($ja.actual)

$Actual

## $($ja.independentRepro)

$(Join-List ($ReproSessionIds | ForEach-Object { "$($ja.freshSession) ``$_`` $($ja.sameSymptom)" }))

## $($ja.excluded)

$(Join-List $ExcludedAlternatives)

## $($ja.environment)

$Environment

## $($ja.acceptance)

$(Join-List $AcceptanceCriteria)

## E2E Patrol context

- repository: $Repository
- source SHA: $($SourceSha.ToLowerInvariant())
- run ID: $RunId
- failure class: $FailureClass
- driver: $Driver
- local evidence names: $(if ($EvidenceNames.Count -gt 0) { $EvidenceNames -join ', ' } else { 'none' })
"@

$safeTitle = & $redactor -Text $Title
$safeBody = & $redactor -Text $body
if (-not $safeTitle.passed -or -not $safeBody.passed) {
    throw 'Redaction verification failed.'
}
if ([regex]::Matches($safeBody.text, [regex]::Escape($marker)).Count -ne 1) {
    throw 'Fingerprint marker must appear exactly once.'
}

$requiredHeadings = @(
    "## $($ja.symptomImpact)",
    "## $($ja.reproSteps)",
    "## $($ja.expectedEvidence)",
    "## $($ja.actual)",
    "## $($ja.independentRepro)",
    "## $($ja.excluded)",
    "## $($ja.environment)",
    "## $($ja.acceptance)",
    '## E2E Patrol context'
)
foreach ($heading in $requiredHeadings) {
    if (-not $safeBody.text.Contains($heading)) {
        throw "Required heading missing: $heading"
    }
}

$parent = Split-Path -Parent $OutputPath
if ($parent) {
    [void](New-Item -ItemType Directory -Path $parent -Force)
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($OutputPath, $safeBody.text, $utf8NoBom)

[pscustomobject]@{
    title = $safeTitle.text
    body_path = $OutputPath
    marker = $marker
    redaction_passed = $true
}
