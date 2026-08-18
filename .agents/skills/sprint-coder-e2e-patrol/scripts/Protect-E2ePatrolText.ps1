[CmdletBinding(DefaultParameterSetName = 'Text')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Text')][AllowEmptyString()][string]$Text,
    [Parameter(Mandatory = $true, ParameterSetName = 'File')][string]$InputPath,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

if ($PSCmdlet.ParameterSetName -eq 'File') {
    if (-not (Test-Path -LiteralPath $InputPath -PathType Leaf)) {
        throw "InputPath does not exist: $InputPath"
    }
    $Text = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $InputPath).Path)
}

$protected = $Text
$applied = New-Object System.Collections.Generic.List[string]

$rules = @(
    @{ Name = 'authorization'; Pattern = '(?im)\b(authorization\s*:\s*)(?:bearer\s+)?[^\r\n]+'; Replacement = '$1[REDACTED]' },
    @{ Name = 'cookie'; Pattern = '(?im)\b(set-cookie|cookie)\s*:\s*[^\r\n]+'; Replacement = '$1: [REDACTED]' },
    @{ Name = 'secret-token'; Pattern = '(?i)\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|eyj[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,})\b'; Replacement = '[REDACTED_TOKEN]' },
    @{ Name = 'email'; Pattern = '(?i)\b[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b'; Replacement = '[REDACTED_EMAIL]' },
    @{ Name = 'connection-string'; Pattern = '(?i)\b(?:server|host|data source|user id|uid|password|pwd)\s*=\s*[^;\r\n]+(?:;[^;\r\n]*)*'; Replacement = '[REDACTED_CONNECTION]' },
    @{ Name = 'url-query'; Pattern = '(?i)(https?://[^\s?#]+)\?[^\s#)]*'; Replacement = '$1?[REDACTED_QUERY]' }
)

foreach ($rule in $rules) {
    $next = [regex]::Replace($protected, $rule.Pattern, $rule.Replacement)
    if ($next -ne $protected) {
        $applied.Add($rule.Name)
        $protected = $next
    }
}

$residualPatterns = @(
    '(?i)\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})\b',
    '(?im)\bauthorization\s*:\s*(?!\[REDACTED\])\S+',
    '(?im)\b(?:set-cookie|cookie)\s*:\s*(?!\[REDACTED\])\S+',
    '(?i)\b[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9-]+\.[a-z]{2,}\b',
    '(?i)https?://[^\s?#]+\?(?!\[REDACTED_QUERY\])'
)

$residual = New-Object System.Collections.Generic.List[string]
foreach ($pattern in $residualPatterns) {
    if ([regex]::IsMatch($protected, $pattern)) {
        $residual.Add($pattern)
    }
}

$passed = ($residual.Count -eq 0)
if ($OutputPath) {
    if (-not $passed) {
        throw 'Redaction verification failed; output was not written.'
    }
    $parent = Split-Path -Parent $OutputPath
    if ($parent) {
        [void](New-Item -ItemType Directory -Path $parent -Force)
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($OutputPath, $protected, $utf8NoBom)
}

[pscustomobject]@{
    passed = $passed
    text = $protected
    applied = @($applied)
    residual_count = $residual.Count
}
