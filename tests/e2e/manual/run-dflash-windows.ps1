param(
    [Parameter(Mandatory=$true)][string]$Lane,
    [Parameter(Mandatory=$true)][string]$DependencyRoot,
    [Parameter(Mandatory=$true)][string]$NodePath,
    [ValidateSet('download','acceptance','cleanup')][string]$Phase = 'download'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
if ((Get-Process -Id $PID).SessionId -eq 0) { throw 'Interactive session required' }
& $NodePath (Join-Path $PSScriptRoot 'dflash-windows-guard.cjs') $Lane $DependencyRoot --ownership-only | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Owned lane/profile preflight rejected' }
Set-Location $Lane
$runner = if ($Phase -eq 'cleanup') { 'acceptance' } else { $Phase }
& $NodePath (Join-Path $Lane ('dflash-windows-' + $runner + '.cjs')) $Lane $DependencyRoot $Phase *> (Join-Path $Lane ($Phase + '-run.log'))
$code = $LASTEXITCODE
$code | Set-Content (Join-Path $Lane ($Phase + '-run.exit'))
exit $code
