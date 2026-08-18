[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PostCleanupWindowsJson,
    [Parameter(Mandatory = $true)][long]$TargetWindowId,
    [Parameter(Mandatory = $true)][string]$TargetApp,
    [Parameter(Mandatory = $true)]
    [ValidateSet('owned_new', 'reused_existing', 'unknown')]
    [string]$Ownership,
    [bool]$PreviousFocusKnown = $false,
    [bool]$FocusRestored = $false,
    [Parameter(Mandatory = $true)][bool]$BindingsDiscarded
)

$ErrorActionPreference = 'Stop'

try {
    $parsed = $PostCleanupWindowsJson | ConvertFrom-Json
} catch {
    throw "Post-cleanup window inventory JSON is invalid: $($_.Exception.Message)"
}

$windows = New-Object System.Collections.Generic.List[object]
foreach ($entry in @($parsed)) {
    if ($entry -is [System.Array]) {
        foreach ($nested in $entry) {
            $windows.Add($nested)
        }
    } else {
        $windows.Add($entry)
    }
}

$targetCount = @($windows | Where-Object {
    [long]$_.id -eq $TargetWindowId -and [string]$_.app -eq $TargetApp
}).Count

$reasons = New-Object System.Collections.Generic.List[string]
if (-not $BindingsDiscarded) {
    $reasons.Add('bindings_not_discarded')
}
if ($PreviousFocusKnown -and -not $FocusRestored) {
    $reasons.Add('focus_not_restored')
}

if ($Ownership -eq 'unknown') {
    $reasons.Add('ownership_unknown')
} elseif ($Ownership -eq 'owned_new' -and $targetCount -ne 0) {
    $reasons.Add('owned_window_still_open')
} elseif ($Ownership -eq 'reused_existing' -and $targetCount -ne 1) {
    $reasons.Add('existing_window_missing_or_ambiguous')
}

if ($reasons.Count -gt 0) {
    return [pscustomobject]@{
        result = 'cleanup_hold'
        complete = $false
        reasons = @($reasons)
    }
}

[pscustomobject]@{
    result = $(if ($Ownership -eq 'owned_new') { 'cleanup_complete' } else { 'cleanup_preserved_existing' })
    complete = $true
    reasons = @()
}
