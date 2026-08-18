[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RunPath,
    [Parameter(Mandatory = $true)]
    [ValidateSet('surface', 'observation', 'promotion', 'dedup', 'filing', 'hold', 'cleanup')]
    [string]$RecordType,
    [Parameter(Mandatory = $true)][string]$CaseId,
    [string]$SessionId = '',
    [Parameter(Mandatory = $true)]
    [ValidateSet('browser-use', 'computer-use')]
    [string]$PrimarySurface,
    [ValidateSet('', 'CU-01-native-dialog', 'CU-02-os-shell', 'CU-03-non-dom-app', 'CU-04-ime-clipboard', 'CU-05-window-layout', 'CU-06-browser-unavailable')]
    [string]$ComputerUseReason = '',
    [string]$Classification = '',
    [Parameter(Mandatory = $true)][string]$Message,
    [string[]]$EvidenceNames = @(),
    [string]$DetailsJson = '{}'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $RunPath -PathType Container)) {
    throw "RunPath does not exist: $RunPath"
}
if (-not (Test-Path -LiteralPath (Join-Path $RunPath 'manifest.json') -PathType Leaf)) {
    throw 'RunPath does not contain manifest.json.'
}
if ($PrimarySurface -eq 'computer-use' -and [string]::IsNullOrWhiteSpace($ComputerUseReason)) {
    throw 'ComputerUseReason is required for Computer Use records.'
}
if ($PrimarySurface -eq 'browser-use' -and -not [string]::IsNullOrWhiteSpace($ComputerUseReason)) {
    throw 'ComputerUseReason must be empty for Browser Use records.'
}
foreach ($name in $EvidenceNames) {
    if ([System.IO.Path]::IsPathRooted($name) -or $name.Contains('..')) {
        throw 'EvidenceNames must contain safe relative names only.'
    }
}

$redactor = Join-Path $PSScriptRoot 'Protect-E2ePatrolText.ps1'
$safeMessage = & $redactor -Text $Message
if (-not $safeMessage.passed) {
    throw 'Record redaction verification failed.'
}
try {
    $safeDetails = & $redactor -Text $DetailsJson
    if (-not $safeDetails.passed -or $safeDetails.text -ne $DetailsJson) {
        throw 'details_redaction_changed'
    }
    $details = $safeDetails.text | ConvertFrom-Json
} catch {
    throw 'DetailsJson must be valid, already-redacted JSON.'
}

$record = [ordered]@{
    schema_version = 1
    recorded_at = [DateTime]::UtcNow.ToString('o')
    record_type = $RecordType
    case_id = $CaseId
    session_id = $(if ($SessionId) { $SessionId } else { $null })
    primary_surface = $PrimarySurface
    computer_use_reason = $(if ($ComputerUseReason) { $ComputerUseReason } else { $null })
    classification = $(if ($Classification) { $Classification } else { $null })
    message = $safeMessage.text
    evidence_names = @($EvidenceNames)
    details = $details
}

$eventPath = Join-Path $RunPath 'events.jsonl'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::AppendAllText($eventPath, (($record | ConvertTo-Json -Depth 8 -Compress) + "`r`n"), $utf8NoBom)

[pscustomobject]@{
    recorded = $true
    event_path = $eventPath
    record_type = $RecordType
    primary_surface = $PrimarySurface
    computer_use_reason = $record.computer_use_reason
}
