[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('fail_product', 'fail_env', 'fail_artifact', 'fail_tooling', 'flaky_unresolved', 'blocked_safety')]
    [string]$Classification,
    [Parameter(Mandatory = $true)][string[]]$ReproSessionIds,
    [Parameter(Mandatory = $true)]
    [ValidateSet('spec', 'issue', 'acceptance', 'ui-contract', 'unknown')]
    [string]$ExpectationSource,
    [Parameter(Mandatory = $true)][bool]$EnvironmentHealthy,
    [Parameter(Mandatory = $true)][bool]$ArtifactVerified,
    [Parameter(Mandatory = $true)][bool]$ToolHealthy,
    [Parameter(Mandatory = $true)][bool]$RedactionPassed
)

$reasons = New-Object System.Collections.Generic.List[string]

if ($Classification -ne 'fail_product') {
    $reasons.Add('classification_not_product')
}
if (@($ReproSessionIds | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique).Count -lt 2) {
    $reasons.Add('independent_reproduction_missing')
}
if ($ExpectationSource -eq 'unknown') {
    $reasons.Add('expectation_unverified')
}
if (-not $EnvironmentHealthy) {
    $reasons.Add('environment_unhealthy')
}
if (-not $ArtifactVerified) {
    $reasons.Add('artifact_unverified')
}
if (-not $ToolHealthy) {
    $reasons.Add('tool_unhealthy')
}
if (-not $RedactionPassed) {
    $reasons.Add('redaction_failed')
}

[pscustomobject]@{
    promotable = ($reasons.Count -eq 0)
    reasons = @($reasons)
}
