param([ValidateSet('download','acceptance','cleanup')][string]$Phase = 'download')
$ErrorActionPreference = 'Stop'
$lane = 'C:\Users\yusei\sc-issue-434-20260915'
$taskName = 'SprintCoderDFlash434-20260915'
& 'C:\Users\yusei\sc-windows-validation-20260914\node-v22.23.2-win-x64\node.exe' (Join-Path $PSScriptRoot 'dflash-windows-guard.cjs') $lane 'C:\Users\yusei\sc-windows-validation-20260914\repo' --ownership-only | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Owned lane/profile preflight rejected' }
$expectedArgument = '*' + $lane + '\run-dflash-windows.ps1*'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    # Actions is an array: a bare -notlike would return the filtered elements, not a boolean.
    $ownedActions = @($existing.Actions | Where-Object { $_.Arguments -like $expectedArgument })
    if ($existing.State -eq 'Running' -or @($existing.Actions).Count -ne 1 -or $ownedActions.Count -ne 1) {
        throw 'Task ownership mismatch or still running'
    }
}
if ($Phase -eq 'download' -and (Get-PSDrive C).Free -lt 23000000000) { throw 'Insufficient disk for the real pair plus rollback headroom' }
$arguments = '-NoProfile -File "' + $lane + '\run-dflash-windows.ps1" -Lane "' + $lane + '" -DependencyRoot "C:\Users\yusei\sc-windows-validation-20260914\repo" -NodePath "C:\Users\yusei\sc-windows-validation-20260914\node-v22.23.2-win-x64\node.exe" -Phase ' + $Phase
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument $arguments
$principal = New-ScheduledTaskPrincipal -UserId 'yuseipc\yusei' -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
# Re-register instead of updating only the action: Set-ScheduledTask -Action would keep a
# principal (another user, RunLevel Highest) or settings (no execution time limit) that an
# earlier registration of this task name left behind.
if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Select-Object TaskName,State
Start-ScheduledTask -TaskName $taskName
