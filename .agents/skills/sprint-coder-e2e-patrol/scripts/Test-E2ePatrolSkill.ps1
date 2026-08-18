[CmdletBinding()]
param([switch]$KeepTemp)

$ErrorActionPreference = 'Stop'
$scriptRoot = $PSScriptRoot
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("e2e-patrol-test-" + [Guid]::NewGuid().ToString('N'))
$passed = 0

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw "ASSERTION FAILED: $Message"
    }
    $script:passed++
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$Message)
    $threw = $false
    try {
        & $Action
    } catch {
        $threw = $true
    }
    Assert-True $threw $Message
}

try {
    [void](New-Item -ItemType Directory -Path $tempRoot -Force)

    foreach ($scriptFile in Get-ChildItem -LiteralPath $scriptRoot -Filter '*.ps1') {
        $tokens = $null
        $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($scriptFile.FullName, [ref]$tokens, [ref]$errors)
        Assert-True ($errors.Count -eq 0) "PowerShell parse failed: $($scriptFile.Name)"
    }

    $skillRoot = Split-Path -Parent $scriptRoot
    $skillText = [System.IO.File]::ReadAllText((Join-Path $skillRoot 'SKILL.md'))
    $e2eContractText = [System.IO.File]::ReadAllText((Join-Path $skillRoot 'references\e2e-contract.md'))
    Assert-True $skillText.Contains('response channel') 'Skill must classify auxiliary capture channel loss as tooling failure.'
    Assert-True $e2eContractText.Contains('two target-bound markers') 'CDP sessions must be bound with two target markers.'
    Assert-True $e2eContractText.Contains('two or more points inside the expected duration') 'Short animations must be sampled while visible.'
    Assert-True $e2eContractText.Contains('reuse the exact owned browser') 'Restart persistence must reuse the same owned profile.'
    Assert-True $e2eContractText.Contains('A user request does not override') 'Production side effects must remain prohibited.'

    $fingerprintScript = Join-Path $scriptRoot 'New-FindingFingerprint.ps1'
    $fingerprintArgs = @{
        Repository = 'owner/repo'
        AppTargetId = 'fixture-web'
        ScreenOrRoute = '/preferences'
        StableElementAnchor = 'button:Save preference'
        FailureClass = 'data-not-persisted'
        ExpectationDelta = 'Expected Saved but got count 14 at 2026-07-30T10:22:33Z'
    }
    $fingerprint1 = & $fingerprintScript @fingerprintArgs
    $fingerprintArgs.ExpectationDelta = 'Expected Saved but got count 99 at 2026-07-31T11:33:44Z'
    $fingerprint2 = & $fingerprintScript @fingerprintArgs
    Assert-True ($fingerprint1 -eq $fingerprint2) 'Fingerprint must ignore dynamic counts and timestamps.'
    $fingerprintArgs.StableElementAnchor = 'button:Different'
    $fingerprint3 = & $fingerprintScript @fingerprintArgs
    Assert-True ($fingerprint1 -ne $fingerprint3) 'Fingerprint must change for a different stable anchor.'

    $redactor = Join-Path $scriptRoot 'Protect-E2ePatrolText.ps1'
    $raw = 'Authorization: Bearer ' + ('sk-' + ('a' * 16)) + ' user@example.com HTTPS://example.test/a?token=abc'
    $redacted = & $redactor -Text $raw
    Assert-True $redacted.passed 'Redaction must pass after replacing prohibited values.'
    Assert-True (-not $redacted.text.Contains('user@example.com')) 'Email must be removed.'
    Assert-True (-not $redacted.text.Contains('token=abc')) 'URL query must be removed.'
    Assert-True (-not $redacted.text.Contains(('sk-' + ('a' * 16)))) 'Token must be removed.'

    $promotableScript = Join-Path $scriptRoot 'Test-FindingPromotable.ps1'
    $promotion = & $promotableScript -Classification fail_product -ReproSessionIds @('a', 'b') -ExpectationSource acceptance -EnvironmentHealthy $true -ArtifactVerified $true -ToolHealthy $true -RedactionPassed $true
    Assert-True $promotion.promotable 'Complete promotion evidence must pass.'
    $held = & $promotableScript -Classification fail_product -ReproSessionIds @('a', 'a') -ExpectationSource acceptance -EnvironmentHealthy $true -ArtifactVerified $true -ToolHealthy $true -RedactionPassed $true
    Assert-True (-not $held.promotable) 'Repeated work in one session must not pass.'

    $runRoot = Join-Path $tempRoot 'run'
    [void](New-Item -ItemType Directory -Path $runRoot -Force)
    [System.IO.File]::WriteAllText((Join-Path $runRoot 'manifest.json'), '{}', (New-Object System.Text.UTF8Encoding($false)))
    $recordScript = Join-Path $scriptRoot 'Write-E2ePatrolRecord.ps1'
    $browserRecord = & $recordScript -RunPath $runRoot -RecordType observation -CaseId WEB-01 -SessionId a -PrimarySurface browser-use -Message 'Expected Saved; observed Not saved.' -EvidenceNames @('session-a/after-save.png')
    Assert-True $browserRecord.recorded 'Browser record must be appended.'
    $computerRecord = & $recordScript -RunPath $runRoot -RecordType surface -CaseId WIN-01 -PrimarySurface computer-use -ComputerUseReason CU-03-non-dom-app -Message 'Native Notepad surface selected.'
    Assert-True ($computerRecord.computer_use_reason -eq 'CU-03-non-dom-app') 'Computer Use reason must be recorded.'
    Assert-Throws {
        & $recordScript -RunPath $runRoot -RecordType surface -CaseId WIN-02 -PrimarySurface computer-use -Message 'Missing reason.' | Out-Null
    } 'Computer Use without a reason must fail.'
    Assert-Throws {
        & $recordScript -RunPath $runRoot -RecordType surface -CaseId WEB-02 -PrimarySurface browser-use -ComputerUseReason CU-03-non-dom-app -Message 'Wrong routing.' | Out-Null
    } 'DOM Browser Use must not carry a Computer Use reason.'

    $cleanupPlanner = Join-Path $scriptRoot 'Get-ComputerUseCleanupPlan.ps1'
    $beforeNew = '[{"id":1,"app":"existing.exe"}]'
    $afterNew = '[{"id":1,"app":"existing.exe"},{"id":2,"app":"new.exe"}]'
    $newPlan = & $cleanupPlanner -BeforeWindowsJson $beforeNew -AfterWindowsJson $afterNew -TargetWindowId 2 -TargetApp new.exe -LaunchAttempted $true -PreviousFocusKnown $true -PreviousFocusWindowId 1 -PreviousFocusApp existing.exe
    Assert-True ($newPlan.ownership -eq 'owned_new' -and $newPlan.should_close) 'A single new window after a recorded launch must be closed.'
    Assert-True $newPlan.should_restore_focus 'Known prior focus must be restored after closing an owned window.'
    $existingPlan = & $cleanupPlanner -BeforeWindowsJson $beforeNew -AfterWindowsJson $beforeNew -TargetWindowId 1 -TargetApp existing.exe -LaunchAttempted $true -PreviousFocusKnown $true -PreviousFocusWindowId 1 -PreviousFocusApp existing.exe
    Assert-True ($existingPlan.ownership -eq 'reused_existing' -and -not $existingPlan.should_close) 'An existing window must never be closed.'
    $unknownPlan = & $cleanupPlanner -BeforeWindowsJson '[]' -AfterWindowsJson '[{"id":3,"app":"unknown.exe"}]' -TargetWindowId 3 -TargetApp unknown.exe -LaunchAttempted $false
    Assert-True ($unknownPlan.result -eq 'cleanup_hold' -and -not $unknownPlan.should_close) 'Unknown ownership must be held without a close action.'
    $cleanupConfirmer = Join-Path $scriptRoot 'Confirm-ComputerUseCleanup.ps1'
    $newCleanup = & $cleanupConfirmer -PostCleanupWindowsJson $beforeNew -TargetWindowId 2 -TargetApp new.exe -Ownership owned_new -PreviousFocusKnown $true -FocusRestored $true -BindingsDiscarded $true
    Assert-True ($newCleanup.complete -and $newCleanup.result -eq 'cleanup_complete') 'A newly launched window must be absent after cleanup.'
    $existingCleanup = & $cleanupConfirmer -PostCleanupWindowsJson $beforeNew -TargetWindowId 1 -TargetApp existing.exe -Ownership reused_existing -PreviousFocusKnown $true -FocusRestored $true -BindingsDiscarded $true
    Assert-True ($existingCleanup.complete -and $existingCleanup.result -eq 'cleanup_preserved_existing') 'A reused existing window must remain open.'
    $unknownCleanup = & $cleanupConfirmer -PostCleanupWindowsJson '[{"id":3,"app":"unknown.exe"}]' -TargetWindowId 3 -TargetApp unknown.exe -Ownership unknown -BindingsDiscarded $true
    Assert-True (-not $unknownCleanup.complete -and $unknownCleanup.result -eq 'cleanup_hold') 'Unknown ownership must remain on hold without force close.'
    $cleanupRecord = & $recordScript -RunPath $runRoot -RecordType cleanup -CaseId WIN-01 -PrimarySurface computer-use -ComputerUseReason CU-03-non-dom-app -Classification cleanup_preserved_existing -Message 'Existing window preserved and handles discarded.' -DetailsJson '{"ownership":"reused_existing","closed":false,"bindings_discarded":true}'
    Assert-True $cleanupRecord.recorded 'Cleanup result must be appended to the execution record.'

    $bodyPath = Join-Path $tempRoot 'issue.md'
    $bodyResult = & (Join-Path $scriptRoot 'New-E2ePatrolIssueBody.ps1') `
        -Title '[bug] Preference save status remains unchanged after submit' `
        -Fingerprint $fingerprint1 `
        -Symptom 'preferences screen save status remains Not saved' `
        -Impact 'user cannot confirm preference persistence' `
        -ReproSteps @('Open preferences screen', 'Select Save preference') `
        -Expected 'Saved is displayed' `
        -ExpectationSource 'ui-contract: Saving a preference must show Saved.' `
        -Actual 'Not saved remains displayed' `
        -ReproSessionIds @('session-a', 'session-b') `
        -ExcludedAlternatives @('Authentication healthy', 'Fresh artifact verified', 'Browser driver healthy') `
        -Environment 'local fixture' `
        -AcceptanceCriteria @('Saved is displayed after submit', 'The result persists after reload') `
        -Repository 'owner/repo' `
        -SourceSha ('a' * 40) `
        -RunId 'test-run' `
        -FailureClass 'data-not-persisted' `
        -Driver browser-use `
        -EvidenceNames @('session-a.txt', 'session-b.txt') `
        -OutputPath $bodyPath
    Assert-True (Test-Path -LiteralPath $bodyResult.body_path) 'Issue body must be written.'
    $bodyText = [System.IO.File]::ReadAllText($bodyPath)
    Assert-True ([regex]::Matches($bodyText, [regex]::Escape($bodyResult.marker)).Count -eq 1) 'Issue marker must occur once.'

    $fakeGh = Join-Path $tempRoot 'fake-gh.cmd'
    $fakeGhContent = @'
@echo off
if "%E2E_FAKE_SCENARIO%"=="dedup-fail" (
  echo inventory failed 1>&2
  exit /b 2
)
if "%1 %2"=="label list" (
  if "%E2E_FAKE_SCENARIO%"=="success-stderr" echo label warning 1>&2
  echo [{"name":"bug"},{"name":"e2e"},{"name":"priority-high"}]
  exit /b 0
)
if "%1 %2"=="issue create" (
  if "%E2E_FAKE_SCENARIO%"=="success-stderr" echo create warning 1>&2
  echo https://github.com/owner/repo/issues/42
  exit /b 0
)
if "%1 %2"=="issue view" (
  if "%E2E_FAKE_SCENARIO%"=="success-stderr" echo view warning 1>&2
  if "%E2E_FAKE_SCENARIO%"=="post-fail" (
    echo {"number":42,"title":"wrong","body":"none","state":"CLOSED","url":"https://github.com/owner/repo/issues/42","labels":[]}
  ) else (
    echo {"number":42,"title":"[bug] Preference save status remains unchanged after submit","body":"\u003c!-- e2e-patrol:fingerprint=__FP__ --\u003e","state":"OPEN","url":"https://github.com/owner/repo/issues/42","labels":[{"name":"bug"},{"name":"e2e"}]}
  )
  exit /b 0
)
if "%1"=="api" (
  if "%E2E_FAKE_SCENARIO%"=="dedup-stderr-success" echo inventory warning 1>&2
  if "%E2E_FAKE_SCENARIO%"=="duplicate-open" echo [[{"number":7,"title":"preferences screen","body":"\u003c!-- e2e-patrol:fingerprint=__FP__ --\u003e save status remains Not saved user cannot confirm preference persistence","state":"OPEN","html_url":"https://github.com/owner/repo/issues/7"}]]
  if "%E2E_FAKE_SCENARIO%"=="regression" echo [[{"number":8,"title":"preferences screen","body":"\u003c!-- e2e-patrol:fingerprint=__FP__ --\u003e save status remains Not saved user cannot confirm preference persistence","state":"CLOSED","html_url":"https://github.com/owner/repo/issues/8"}]]
  if "%E2E_FAKE_SCENARIO%"=="collision" echo [[{"number":9,"title":"other screen","body":"\u003c!-- e2e-patrol:fingerprint=__FP__ --\u003e unrelated behavior","state":"OPEN","html_url":"https://github.com/owner/repo/issues/9"}]]
  if "%E2E_FAKE_SCENARIO%"=="semantic" echo [[{"number":10,"title":"preferences screen","body":"save status remains Not saved user cannot confirm preference persistence","state":"OPEN","html_url":"https://github.com/owner/repo/issues/10"}]]
  if "%E2E_FAKE_SCENARIO%"=="pull" echo [[{"number":11,"title":"preferences screen","body":"save status remains Not saved user cannot confirm preference persistence","state":"open","html_url":"https://github.com/owner/repo/pull/11","pull_request":{"url":"https://api.github.com/repos/owner/repo/pulls/11"}}]]
  if not "%E2E_FAKE_SCENARIO%"=="duplicate-open" if not "%E2E_FAKE_SCENARIO%"=="regression" if not "%E2E_FAKE_SCENARIO%"=="collision" if not "%E2E_FAKE_SCENARIO%"=="semantic" if not "%E2E_FAKE_SCENARIO%"=="pull" echo [[]]
  exit /b 0
)
exit /b 3
'@
    $fakeGhContent = $fakeGhContent.Replace('__FP__', $fingerprint1)
    [System.IO.File]::WriteAllText($fakeGh, $fakeGhContent, (New-Object System.Text.ASCIIEncoding))

    $dedupeScript = Join-Path $scriptRoot 'Find-DuplicateE2EIssue.ps1'
    $dedupeArgs = @{
        Repository = 'owner/repo'
        Fingerprint = $fingerprint1
        Screen = 'preferences screen'
        Symptom = 'save status remains Not saved'
        Impact = 'user cannot confirm preference persistence'
        GhCommand = $fakeGh
    }
    foreach ($case in @(
        @{ Scenario = 'unique'; Expected = 'unique' },
        @{ Scenario = 'duplicate-open'; Expected = 'duplicate_open' },
        @{ Scenario = 'regression'; Expected = 'regression_hold' },
        @{ Scenario = 'collision'; Expected = 'collision' },
        @{ Scenario = 'semantic'; Expected = 'duplicate_open' },
        @{ Scenario = 'pull'; Expected = 'fix_in_progress' }
    )) {
        $env:E2E_FAKE_SCENARIO = $case.Scenario
        $decision = & $dedupeScript @dedupeArgs
        Assert-True ($decision.result -eq $case.Expected) "Unexpected dedupe decision for $($case.Scenario): $($decision.result)."
    }
    $env:E2E_FAKE_SCENARIO = 'dedup-fail'
    Assert-Throws { & $dedupeScript @dedupeArgs | Out-Null } 'Inventory failure must stop duplicate checking.'
    $env:E2E_FAKE_SCENARIO = 'dedup-stderr-success'
    $stderrDecision = & $dedupeScript @dedupeArgs
    Assert-True ($stderrDecision.result -eq 'unique') 'Successful GitHub inventory stderr must not corrupt JSON stdout.'

    $submitScript = Join-Path $scriptRoot 'Submit-E2ePatrolIssue.ps1'
    $dry = & $submitScript -Repository owner/repo -Title $bodyResult.title -BodyPath $bodyPath -Fingerprint $fingerprint1 -IndexPath (Join-Path $tempRoot 'dry-index.json') -RunId test-run -SourceSha ('a' * 40) -PromotionPassed $true -DedupResult unique -DryRun -GhCommand (Join-Path $tempRoot 'does-not-exist.cmd')
    Assert-True (-not $dry.created) 'Dry-run must not invoke GitHub.'
    Assert-Throws {
        & $submitScript -Repository owner/repo -Title $bodyResult.title -BodyPath $bodyPath -Fingerprint $fingerprint1 -IndexPath (Join-Path $tempRoot 'held-index.json') -RunId held-run -SourceSha ('a' * 40) -PromotionPassed $false -DedupResult unique -DryRun | Out-Null
    } 'A Finding that failed promotion must not create a draft submission.'
    Assert-Throws {
        & $submitScript -Repository owner/repo -Title $bodyResult.title -BodyPath $bodyPath -Fingerprint $fingerprint1 -IndexPath (Join-Path $tempRoot 'duplicate-index.json') -RunId duplicate-run -SourceSha ('a' * 40) -PromotionPassed $true -DedupResult duplicate_open -DryRun | Out-Null
    } 'A duplicate Finding must not create a draft submission.'

    $env:E2E_FAKE_SCENARIO = 'success'
    $indexPath = Join-Path $tempRoot 'index.json'
    $created = & $submitScript -Repository owner/repo -Title $bodyResult.title -BodyPath $bodyPath -Fingerprint $fingerprint1 -IndexPath $indexPath -RunId test-run -SourceSha ('a' * 40) -PromotionPassed $true -DedupResult unique -GhCommand $fakeGh
    Assert-True $created.created 'Live submission must record a verified Issue.'
    Assert-True (($created.labels -join ',') -eq 'bug,e2e') 'Only existing bug and E2E labels may be selected.'
    Assert-True (Test-Path -LiteralPath $indexPath) 'Verified creation index must be written.'
    $env:E2E_FAKE_SCENARIO = 'success-stderr'
    $stderrCreated = & $submitScript -Repository owner/repo -Title $bodyResult.title -BodyPath $bodyPath -Fingerprint $fingerprint1 -IndexPath (Join-Path $tempRoot 'stderr-index.json') -RunId stderr-run -SourceSha ('a' * 40) -PromotionPassed $true -DedupResult unique -GhCommand $fakeGh
    Assert-True $stderrCreated.created 'Successful GitHub stderr must not hide a created and verified Issue.'

    $limitIndex = Join-Path $tempRoot 'limit-index.json'
    $limitEntries = 1..5 | ForEach-Object {
        [pscustomobject]@{ fingerprint = ('{0:x64}' -f $_); number = $_; url = "https://example/$($_)"; source_sha = ('a' * 40); run_id = 'limit-run'; verified_at = 'now' }
    }
    $limitObject = [pscustomobject]@{ schema_version = 1; repository = 'owner/repo'; created_issues = @($limitEntries) }
    [System.IO.File]::WriteAllText($limitIndex, ($limitObject | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
    Assert-Throws {
        & $submitScript -Repository owner/repo -Title $bodyResult.title -BodyPath $bodyPath -Fingerprint ('f' * 64) -IndexPath $limitIndex -RunId limit-run -SourceSha ('a' * 40) -PromotionPassed $true -DedupResult unique -GhCommand $fakeGh | Out-Null
    } 'The five-Issue limit must stop creation.'

    $env:E2E_FAKE_SCENARIO = 'post-fail'
    Assert-Throws {
        & $submitScript -Repository owner/repo -Title $bodyResult.title -BodyPath $bodyPath -Fingerprint ('e' * 64) -IndexPath (Join-Path $tempRoot 'post-fail-index.json') -RunId post-fail-run -SourceSha ('a' * 40) -PromotionPassed $true -DedupResult unique -GhCommand $fakeGh | Out-Null
    } 'Post-create verification failure must stop the batch.'
    $env:E2E_FAKE_SCENARIO = 'success'
    Assert-Throws {
        & $submitScript -Repository owner/repo -Title $bodyResult.title -BodyPath $bodyPath -Fingerprint ('d' * 64) -IndexPath (Join-Path $tempRoot 'post-fail-index.json') -RunId post-fail-run -SourceSha ('a' * 40) -PromotionPassed $true -DedupResult unique -GhCommand $fakeGh | Out-Null
    } 'A halted run must reject later Issue creation attempts.'

    [pscustomobject]@{
        status = 'PASS'
        assertions = $passed
        powershell_version = $PSVersionTable.PSVersion.ToString()
    }
} finally {
    Remove-Item Env:E2E_FAKE_SCENARIO -ErrorAction SilentlyContinue
    if (-not $KeepTemp -and (Test-Path -LiteralPath $tempRoot)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    } elseif ($KeepTemp) {
        Write-Host "TEST_TEMP=$tempRoot"
    }
}
