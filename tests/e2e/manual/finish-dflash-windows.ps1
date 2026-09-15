$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$lane = 'C:\Users\yusei\sc-issue-434-20260915'
$taskName = 'SprintCoderDFlash434-20260915'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task -and ($task.State -eq 'Running' -or $task.Actions.Arguments -notlike ('*' + $lane + '\run-dflash-windows.ps1*'))) { throw 'Owned task running or ownership mismatch' }
if ((Get-Content (Join-Path $lane 'cleanup-run.exit')).Trim() -ne '0') { throw 'Cleanup phase did not succeed' }
$owned = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('Sprint Coder.exe','llama-server.exe','node.exe') -and
    ($_.ExecutablePath -like ($lane + '\*') -or $_.CommandLine -like ('*' + $lane + '*'))
} | Select-Object ProcessId,Name)
if ($owned.Count -ne 0) { throw 'Owned app/runtime processes remain' }
$partials = @(Get-ChildItem (Join-Path $lane 'profile\local-models\partials'))
$models = @(Get-ChildItem (Join-Path $lane 'profile\local-models\models'))
if ($partials.Count -ne 0 -or $models.Count -ne 0) { throw 'Model or partial artifacts remain' }
if ($task) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
$result = [pscustomobject]@{
    cleanup='PASS'; ownedProcessCount=$owned.Count; modelDirectoryCount=$models.Count;
    partialFileCount=$partials.Count;
    taskRemoved=($null -eq (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue));
    freeBytes=(Get-PSDrive C).Free;
    originalZipSha256=(Get-FileHash (Join-Path $lane 'beta3.zip') -Algorithm SHA256).Hash.ToLowerInvariant()
}
$result | ConvertTo-Json | Set-Content (Join-Path $lane 'final-cleanup.json') -Encoding UTF8
$result | ConvertTo-Json
