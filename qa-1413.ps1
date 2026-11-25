[CmdletBinding()]
param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
if ((node --version) -notmatch '^v22\.') { throw 'Use Node.js 22.' }
$repo = $PSScriptRoot
$desktop = Join-Path $repo 'apps/desktop'
$generated = Join-Path $desktop 'src/renderer/qa-1413-generated.json'
$manifest = Join-Path $desktop 'qa-1413-local/session.json'
$electron = Join-Path $repo 'node_modules/electron/dist/electron.exe'
$runner = Join-Path $repo 'node_modules/vite-node/vite-node.mjs'
if (!(Test-Path -LiteralPath $electron -PathType Leaf)) {
  throw 'Prepare the development dependencies and Windows native modules before the offline test.'
}

$previousNodeMode = $env:ELECTRON_RUN_AS_NODE
$previousCheckMode = $env:SPRINT_CODER_QA_1413_CHECK_ONLY
Push-Location "$desktop"
try {
  if (!(Test-Path -LiteralPath $manifest)) {
    $env:ELECTRON_RUN_AS_NODE = '1'
    & $electron $runner ./scripts/seed-qa-1413.ts 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated QA profile.' }
  }
  if (!(Test-Path -LiteralPath $generated) -or
    (Get-FileHash -LiteralPath $manifest).Hash -ne (Get-FileHash -LiteralPath $generated).Hash) {
    throw 'The window fixture does not match the isolated QA profile.'
  }
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  if ($CheckOnly) { $env:SPRINT_CODER_QA_1413_CHECK_ONLY = '1' }
  else { Remove-Item Env:SPRINT_CODER_QA_1413_CHECK_ONLY -ErrorAction SilentlyContinue }
  & npm.cmd start
  if ($LASTEXITCODE -ne 0) { throw 'The isolated QA build did not open.' }
} finally {
  Pop-Location
  $env:ELECTRON_RUN_AS_NODE = $previousNodeMode
  $env:SPRINT_CODER_QA_1413_CHECK_ONLY = $previousCheckMode
}
