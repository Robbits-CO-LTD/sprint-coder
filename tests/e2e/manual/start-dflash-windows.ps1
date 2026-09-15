param([ValidateSet('download','acceptance','cleanup')][string]$Phase = 'download')
$ErrorActionPreference = 'Stop'
$lane = 'C:\Users\yusei\sc-issue-434-20260915'
$taskName = 'SprintCoderDFlash434-20260915'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and ($existing.State -eq 'Running' -or $existing.Actions.Arguments -notlike ('*' + $lane + '\run-dflash-windows.ps1*'))) { throw 'Task ownership mismatch or still running' }
if ($Phase -eq 'download' -and (Get-PSDrive C).Free -lt 23000000000) { throw 'Insufficient disk for the real pair plus rollback headroom' }
$arguments = '-NoProfile -File "' + $lane + '\run-dflash-windows.ps1" -Lane "' + $lane + '" -DependencyRoot "C:\Users\yusei\sc-windows-validation-20260914\repo" -NodePath "C:\Users\yusei\sc-windows-validation-20260914\node-v22.23.2-win-x64\node.exe" -Phase ' + $Phase
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument $arguments
$principal = New-ScheduledTaskPrincipal -UserId 'yuseipc\yusei' -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
if ($existing) {
    Set-ScheduledTask -TaskName $taskName -Action $action | Select-Object TaskName,State
} else {
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Select-Object TaskName,State
}
Start-ScheduledTask -TaskName $taskName
