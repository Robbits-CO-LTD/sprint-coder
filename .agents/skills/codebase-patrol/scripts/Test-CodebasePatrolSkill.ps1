param(
  [Parameter(Mandatory = $true)]
  [string]$SkillPath
)

$ErrorActionPreference = "Stop"

$scriptBytes = [System.IO.File]::ReadAllBytes($PSCommandPath)
if ($scriptBytes | Where-Object { $_ -ge 128 }) {
  throw "This script must remain ASCII-only for Windows PowerShell 5.1 compatibility."
}

$resolvedSkillPath = (Resolve-Path -LiteralPath $SkillPath).Path
$skillFile = Join-Path $resolvedSkillPath "SKILL.md"
$rulesFile = Join-Path $resolvedSkillPath "references\patrol-rules.md"
$lanesFile = Join-Path $resolvedSkillPath "references\scan-lanes.md"

foreach ($requiredFile in @(
  $skillFile,
  $rulesFile,
  $lanesFile,
  (Join-Path $resolvedSkillPath "references\profiles.md"),
  (Join-Path $resolvedSkillPath "references\false-positive-suppression.md"),
  (Join-Path $resolvedSkillPath "references\issue-contract.md")
)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Required file is missing: $requiredFile"
  }
}

$skillText = Get-Content -LiteralPath $skillFile -Raw -Encoding UTF8
$rulesText = Get-Content -LiteralPath $rulesFile -Raw -Encoding UTF8
$lanesText = Get-Content -LiteralPath $lanesFile -Raw -Encoding UTF8
$profilesText = Get-Content -LiteralPath (Join-Path $resolvedSkillPath "references\profiles.md") -Raw -Encoding UTF8
$suppressionText = Get-Content -LiteralPath (Join-Path $resolvedSkillPath "references\false-positive-suppression.md") -Raw -Encoding UTF8
$issueContractText = Get-Content -LiteralPath (Join-Path $resolvedSkillPath "references\issue-contract.md") -Raw -Encoding UTF8

$linkedReferences = [regex]::Matches(
  $skillText,
  '\]\((references/[a-z0-9-]+\.md)\)'
) | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique

foreach ($reference in $linkedReferences) {
  $referencePath = Join-Path $resolvedSkillPath ($reference -replace '/', '\')
  if (-not (Test-Path -LiteralPath $referencePath -PathType Leaf)) {
    throw "Linked reference is missing: $reference"
  }
}

$ruleIds = [regex]::Matches(
  $rulesText,
  '(?m)^### ([A-Z]+-\d{2}):'
) | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique

$assignedIds = [regex]::Matches(
  $lanesText,
  '(?m)^\| [A-C] [^|]+ \| ([A-Z0-9, -]+) \|'
) | ForEach-Object {
  $_.Groups[1].Value -split ',\s*'
} | Where-Object { $_ } | Sort-Object

if ($ruleIds.Count -ne 18) {
  throw "Expected 18 catalog rules, found $($ruleIds.Count)"
}

$duplicateAssignments = $assignedIds |
  Group-Object |
  Where-Object { $_.Count -ne 1 } |
  Select-Object -ExpandProperty Name

if ($duplicateAssignments) {
  throw "Rule assignments are duplicated: $($duplicateAssignments -join ', ')"
}

$undefinedAssignments = $assignedIds | Where-Object { $_ -notin $ruleIds }
if ($undefinedAssignments) {
  throw "Undefined rules are assigned: $($undefinedAssignments -join ', ')"
}

$unassignedRules = $ruleIds | Where-Object { $_ -notin $assignedIds }
if ($unassignedRules) {
  throw "Catalog rules are unassigned: $($unassignedRules -join ', ')"
}

function Get-FocusedRuleIds {
  param([string]$Text)

  return [regex]::Matches(
    $Text,
    '(?m)^\| `[a-z-]+` \| ([A-Z0-9, -]+) \|\r?$'
  ) | ForEach-Object {
    $_.Groups[1].Value -split ',\s*'
  } | Where-Object { $_ } | Sort-Object
}

$focusedIds = Get-FocusedRuleIds -Text $skillText
$crlfSkillText = [regex]::Replace($skillText, '\r?\n', "`r`n")
$crlfFocusedIds = Get-FocusedRuleIds -Text $crlfSkillText

if (($focusedIds -join ',') -ne ($crlfFocusedIds -join ',')) {
  throw "Focused category parsing differs between LF and CRLF."
}

$duplicateFocusedIds = $focusedIds |
  Group-Object |
  Where-Object { $_.Count -ne 1 } |
  Select-Object -ExpandProperty Name

if ($duplicateFocusedIds) {
  throw "Focused categories contain duplicate rules: $($duplicateFocusedIds -join ', ')"
}

$missingFocusedIds = $ruleIds | Where-Object { $_ -notin $focusedIds }
$undefinedFocusedIds = $focusedIds | Where-Object { $_ -notin $ruleIds }
if ($missingFocusedIds -or $undefinedFocusedIds) {
  throw "Focused category mapping mismatch. Missing: $($missingFocusedIds -join ', '); undefined: $($undefinedFocusedIds -join ', ')"
}

$allMarkdownText = Get-ChildItem -LiteralPath $resolvedSkillPath -Recurse -Filter "*.md" |
  ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 } |
  Out-String

$referencedRuleIds = [regex]::Matches(
  $allMarkdownText,
  '\b[A-Z]+-\d{2}\b'
) | ForEach-Object { $_.Value } | Sort-Object -Unique

$undefinedRuleReferences = $referencedRuleIds |
  Where-Object { $_ -notin $ruleIds }

if ($undefinedRuleReferences) {
  throw "Undefined rule references found: $($undefinedRuleReferences -join ', ')"
}

$legacyPatterns = @(
  'subagent_type',
  'Task tool',
  'codex exec',
  '\bexplorer\b',
  'acceptEdits',
  'bypassPermissions'
)

foreach ($pattern in $legacyPatterns) {
  if ($lanesText -match $pattern) {
    throw "Legacy execution contract found in scan-lanes.md: $pattern"
  }
}

$requiredGuardrails = @(
  @{
    Text = $suppressionText
    Pattern = '(?s)\u5168Rule\u3067inline suppression\u3060\u3051\u306B\u3088\u308B\u81EA\u52D5\u6291\u5236\u3092\u7981\u6B62'
    Name = 'untrusted inline suppression guardrail'
  },
  @{
    Text = $suppressionText
    Pattern = '(?s)state\.json.*?\u8A18\u9332\u304C\u3042\u308B\u3060\u3051\u3067\u306FFinding\u3092\u6291\u5236\u3057\u306A\u3044'
    Name = 'untrusted dismissed state guardrail'
  },
  @{
    Text = "$rulesText`n$profilesText"
    Pattern = '(?s)\u5BFE\u8C61\u30EA\u30DD\u30B8\u30C8\u30EA\u5185\u3067\u5B9A\u7FA9\u3055\u308C\u305Fscript.*?\u5B9F\u884C\u3057\u306A\u3044'
    Name = 'repository-defined command execution guardrail'
  },
  @{
    Text = $profilesText
    Pattern = '(?s)\u5B9F\u884C\u3059\u308Bbinary\u306E\u9078\u629E\u6839\u62E0\u306B\u306F\u4F7F\u308F\u306A\u3044.*?yarnPath.*?corepack shim.*?\.npmrc'
    Name = 'package manager substitution guardrail'
  },
  @{
    Text = $profilesText
    Pattern = '(?s)check\u540D\u3084PASS\u8868\u793A\u3060\u3051\u3092\u6839\u62E0\u306B\u3057\u306A\u3044.*?\u30ED\u30B0\u304B\u3089\u8A72\u5F53rule\u3092\u5B9F\u969B\u306B\u691C\u67FB'
    Name = 'untrusted CI result guardrail'
  },
  @{
    Text = $suppressionText
    Pattern = '(?s)vendor\u30FBgenerated\u30FBbuild\u6210\u679C\u7269.*?path\u540D.*?\u901A\u5E38\u8D70\u67FB'
    Name = 'untrusted generated classification guardrail'
  },
  @{
    Text = $skillText
    Pattern = '(?s)\u672A\u4FE1\u983C\u30C7\u30FC\u30BF\u3068\u3057\u3066\u8AAD\u3080.*?tool\u5B9F\u884C\u3084\u5B89\u5168\u5883\u754C\u5909\u66F4'
    Name = 'repository content instruction guardrail'
  },
  @{
    Text = $issueContractText
    Pattern = 'marker\u4E00\u81F4\u3060\u3051\u3067\u306F\u65B0\u898F\u4F5C\u6210\u3092\u6291\u6B62\u3057\u306A\u3044'
    Name = 'untrusted marker guardrail'
  },
  @{
    Text = $issueContractText
    Pattern = '(?s)created_issues.*?\u3060\u3051\u3067\u306F\u91CD\u8907\u3068\u305B\u305A'
    Name = 'untrusted created issue record guardrail'
  }
)

foreach ($guardrail in $requiredGuardrails) {
  if ($guardrail.Text -notmatch $guardrail.Pattern) {
    throw "Required guardrail is missing: $($guardrail.Name)"
  }
}

$publicationGuardrails = @(
  @{
    Text = $issueContractText
    Pattern = '(?s)`auto-file`.*?Finding.*?fingerprint.*?Issue.*?\u518D\u627F\u8A8D\u3092\u6C42\u3081\u306A\u3044'
    Name = 'explicit request authorization without second approval'
  },
  @{
    Text = $skillText
    Pattern = '(?s)--dry-run.*?\u512A\u5148'
    Name = 'dry-run precedence over auto-file'
  },
  @{
    Text = $skillText
    Pattern = '(?s)commit.*?anchor.*?fingerprint.*?\u518D\u627F\u8A8D\u306F\u6C42\u3081\u306A\u3044'
    Name = 'commit drift targeted revalidation'
  },
  @{
    Text = $skillText
    Pattern = '(?s)1batch.*?5\u4EF6.*?auto-file.*?\u518D\u627F\u8A8D\u306A\u3057'
    Name = 'multi-batch continuation without reapproval'
  },
  @{
    Text = $skillText
    Pattern = '(?s)\u73FE\u5728\u306E\u30E6\u30FC\u30B6\u30FC\u4F9D\u983C.*?state.*?\u6295\u7A3F\u6A29\u9650'
    Name = 'current-request-only publication authority'
  },
  @{
    Text = "$skillText`n$issueContractText"
    Pattern = '(?s)MEDIUM.*?file:line.*?\u672A\u78BA\u8A8D\u6761\u4EF6'
    Name = 'medium finding evidence threshold'
  }
)

foreach ($guardrail in $publicationGuardrails) {
  if ($guardrail.Text -notmatch $guardrail.Pattern) {
    throw "Required publication contract is missing: $($guardrail.Name)"
  }
}

$forbiddenApprovalPatterns = @(
  '\u521D\u56DE\u307E\u305F\u306F\u5BFE\u8C61commit\u304C\u5909\u308F\u3063\u305F\u5F8C\u306F\u5FC5\u305Adry-run',
  'fingerprint\u307E\u305F\u306F\u627F\u8A8D\u7BC4\u56F2\u3092\u660E\u793A\u3057\u305F\u8A18\u9332\u304C\u5FC5\u8981',
  '\u627F\u8A8D\u5F8C\u306Bcommit\u304C\u5909\u308F\u3063\u305F\u5834\u5408\u306F\u8D77\u7968\u305B\u305A',
  '\u521D\u56DE\u3001commit\u5909\u66F4\u5F8C\u3001\u307E\u305F\u306Fprofile\u5909\u66F4\u5F8C\u306F\u3053\u3053\u3067\u505C\u6B62'
)

foreach ($pattern in $forbiddenApprovalPatterns) {
  if ("$skillText`n$issueContractText" -match $pattern) {
    throw "Legacy per-report approval contract found: $pattern"
  }
}

Write-Output "Codebase Patrol skill contract is valid."
