[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BeforeWindowsJson,
    [Parameter(Mandatory = $true)][string]$AfterWindowsJson,
    [Parameter(Mandatory = $true)][long]$TargetWindowId,
    [Parameter(Mandatory = $true)][string]$TargetApp,
    [Parameter(Mandatory = $true)][bool]$LaunchAttempted,
    [bool]$PreviousFocusKnown = $false,
    [long]$PreviousFocusWindowId = 0,
    [string]$PreviousFocusApp = ''
)

$ErrorActionPreference = 'Stop'

try {
    $beforeParsed = $BeforeWindowsJson | ConvertFrom-Json
    $afterParsed = $AfterWindowsJson | ConvertFrom-Json
} catch {
    throw "Window inventory JSON is invalid: $($_.Exception.Message)"
}

function Expand-Inventory {
    param([object]$Parsed)
    foreach ($entry in @($Parsed)) {
        if ($entry -is [System.Array]) {
            foreach ($nested in $entry) {
                Write-Output $nested
            }
        } else {
            Write-Output $entry
        }
    }
}

$before = @(Expand-Inventory $beforeParsed)
$after = @(Expand-Inventory $afterParsed)

function Find-ExactWindow {
    param([object[]]$Windows, [long]$Id, [string]$App)
    return @($Windows | Where-Object { [long]$_.id -eq $Id -and [string]$_.app -eq $App })
}

$targetAfter = @(Find-ExactWindow $after $TargetWindowId $TargetApp)
if ($targetAfter.Count -ne 1) {
    return [pscustomobject]@{
        result = 'cleanup_hold'
        ownership = 'unknown'
        should_close = $false
        should_restore_focus = $false
        reason = 'target_missing_or_ambiguous_after'
    }
}

$targetBefore = @(Find-ExactWindow $before $TargetWindowId $TargetApp)
$ownership = 'unknown'
$reason = 'ownership_unproven'
$shouldClose = $false

if ($targetBefore.Count -eq 1) {
    $ownership = 'reused_existing'
    $reason = 'target_existed_before'
} elseif ($targetBefore.Count -eq 0 -and $LaunchAttempted) {
    $newTargetAppWindows = @($after | Where-Object {
        [string]$_.app -eq $TargetApp -and
        @(Find-ExactWindow $before ([long]$_.id) ([string]$_.app)).Count -eq 0
    })
    if ($newTargetAppWindows.Count -eq 1 -and [long]$newTargetAppWindows[0].id -eq $TargetWindowId) {
        $ownership = 'owned_new'
        $reason = 'single_new_window_after_recorded_launch'
        $shouldClose = $true
    } else {
        $reason = 'multiple_or_mismatched_new_windows'
    }
}

$focusExists = $false
if ($PreviousFocusKnown -and $PreviousFocusWindowId -ne 0 -and $PreviousFocusApp) {
    $focusExists = (@(Find-ExactWindow $after $PreviousFocusWindowId $PreviousFocusApp).Count -eq 1)
}
$shouldRestore = ($PreviousFocusKnown -and $focusExists -and
    -not ($PreviousFocusWindowId -eq $TargetWindowId -and $PreviousFocusApp -eq $TargetApp))

if ($ownership -eq 'unknown') {
    return [pscustomobject]@{
        result = 'cleanup_hold'
        ownership = $ownership
        should_close = $false
        should_restore_focus = $shouldRestore
        reason = $reason
    }
}

[pscustomobject]@{
    result = $(if ($ownership -eq 'owned_new') { 'close_new' } else { 'preserve_existing' })
    ownership = $ownership
    should_close = $shouldClose
    should_restore_focus = $shouldRestore
    reason = $reason
}
