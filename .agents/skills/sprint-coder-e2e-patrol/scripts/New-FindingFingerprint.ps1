[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$AppTargetId,
    [Parameter(Mandatory = $true)][string]$ScreenOrRoute,
    [Parameter(Mandatory = $true)][string]$StableElementAnchor,
    [Parameter(Mandatory = $true)]
    [ValidateSet('crash', 'console-error', 'network-5xx', 'data-not-persisted', 'wrong-value', 'nav-dead-end', 'layout-broken', 'a11y-blocking', 'perf-timeout', 'state-not-restored', 'input-behavior')]
    [string]$FailureClass,
    [Parameter(Mandatory = $true)][string]$ExpectationDelta,
    [string]$ViewportBucket = ''
)

$ErrorActionPreference = 'Stop'

function Normalize-StableText {
    param([string]$Value)
    $normalized = $Value.Trim().ToLowerInvariant()
    $normalized = [regex]::Replace($normalized, '\s+', ' ')
    $normalized = [regex]::Replace($normalized, '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', '<uuid>', 'IgnoreCase')
    $normalized = [regex]::Replace($normalized, '\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b', '<timestamp>', 'IgnoreCase')
    return $normalized
}

function Normalize-Delta {
    param([string]$Value)
    $normalized = Normalize-StableText $Value
    $normalized = [regex]::Replace($normalized, '(?<=:)\d{2,5}\b', '<port>')
    $normalized = [regex]::Replace($normalized, '\b\d+\b', '<n>')
    return $normalized
}

$parts = @(
    (Normalize-StableText $Repository),
    (Normalize-StableText $AppTargetId),
    (Normalize-StableText $ScreenOrRoute),
    (Normalize-StableText $StableElementAnchor),
    $FailureClass.ToLowerInvariant(),
    (Normalize-Delta $ExpectationDelta)
)

if ($FailureClass -eq 'layout-broken') {
    if ([string]::IsNullOrWhiteSpace($ViewportBucket)) {
        throw 'ViewportBucket is required for layout-broken.'
    }
    $parts += (Normalize-StableText $ViewportBucket)
}

$canonical = $parts -join '|'
$sha = [System.Security.Cryptography.SHA256]::Create()
try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($canonical)
    $hash = $sha.ComputeHash($bytes)
} finally {
    $sha.Dispose()
}

($hash | ForEach-Object { $_.ToString('x2') }) -join ''
