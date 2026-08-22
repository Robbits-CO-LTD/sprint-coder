import type { SkillCompatibilityReport, SkillProfile } from '@sprint-coder/contracts';
import { parseDocument, stringify } from 'yaml';

const MAX_FRONTMATTER_BYTES = 64 * 1024;
const STANDARD_FIELDS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);
const CLAUDE_FIELDS = new Set([
  'when_to_use',
  'argument-hint',
  'arguments',
  'disable-model-invocation',
  'user-invocable',
  'disallowed-tools',
  'context',
  'agent',
  'model',
  'shell',
]);

export type ParsedSkillMetadata = Readonly<{
  name: string;
  description: string;
  frontmatter: Readonly<Record<string, unknown>>;
  body: string;
  compatibility: SkillCompatibilityReport;
}>;

export function portableSkillCompatibility(): SkillCompatibilityReport {
  return {
    profile: 'portable',
    runtimeSupport: { codex: 'full', claude: 'full', provider: 'full' },
    features: ['standard:description', 'standard:name'],
    requestedTools: [],
    warnings: [],
    blockers: [],
    requiresConversion: false,
    nativeModeConsentRequired: false,
  };
}

export function createPortableSkillFile(skillFile: Buffer): Buffer {
  const parsed = analyzeSkillPackage(skillFile);
  const frontmatter = Object.fromEntries(
    [...STANDARD_FIELDS]
      .filter((key) => key in parsed.frontmatter)
      .map((key) => [key, parsed.frontmatter[key]]),
  );
  return Buffer.from(
    `---\n${stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n${parsed.body}`,
    'utf8',
  );
}

export function analyzeSkillPackage(
  skillFile: Buffer,
  files: readonly { path: string; bytes?: Buffer; content?: string }[] = [],
): ParsedSkillMetadata {
  const text = decodeUtf8(skillFile, 'SKILL.md');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (match === null) throw new Error('SKILL.md frontmatter is required');
  if (Buffer.byteLength(match[1]!, 'utf8') > MAX_FRONTMATTER_BYTES)
    throw new Error('SKILL.md frontmatter is too large');

  const document = parseDocument(match[1]!, {
    schema: 'failsafe',
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0)
    throw new Error(`Invalid SKILL.md frontmatter: ${document.errors[0]!.message}`);
  if (document.warnings.length > 0)
    throw new Error(`Unsafe SKILL.md frontmatter: ${document.warnings[0]!.message}`);

  let parsed: unknown;
  try {
    parsed = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  } catch {
    throw new Error('SKILL.md frontmatter aliases are not allowed');
  }
  if (!isPlainRecord(parsed)) throw new Error('SKILL.md frontmatter must be a mapping');
  assertJsonLike(parsed, 'frontmatter');

  const name = requiredText(parsed['name'], 'name', 200);
  const description = requiredText(parsed['description'], 'description', 2_000);
  const body = text.slice(match[0].length);
  const compatibility = buildCompatibility(parsed, body, files);
  return { name, description, frontmatter: parsed, body, compatibility };
}

function buildCompatibility(
  frontmatter: Readonly<Record<string, unknown>>,
  body: string,
  files: readonly { path: string; bytes?: Buffer; content?: string }[],
): SkillCompatibilityReport {
  const features = new Set<string>();
  const warnings: string[] = [];
  const blockers: string[] = [];
  const unknownFields: string[] = [];

  for (const key of Object.keys(frontmatter)) {
    if (STANDARD_FIELDS.has(key)) features.add(`standard:${key}`);
    else if (CLAUDE_FIELDS.has(key)) features.add(`claude:${key}`);
    else unknownFields.push(key);
  }
  if (unknownFields.length > 0)
    blockers.push(`未対応のfrontmatter field: ${unknownFields.sort().join(', ')}`);

  const hasCodexMetadata = files.some(({ path }) => path === 'agents/openai.yaml');
  const hasPackageResources = files.some(
    ({ path }) =>
      ![
        'SKILL.md',
        'team/blueprint.json',
        'agents/openai.yaml',
        'manifest.json',
        'revision.json',
      ].includes(path),
  );
  if (hasCodexMetadata) features.add('codex:openai-metadata');
  if (hasPackageResources) features.add('package:resources');
  const hasArguments = /\$(?:ARGUMENTS(?:\[\d+\])?|\d+)\b/u.test(body);
  const hasFileReferences = /(^|[\s(])@[.\w/-]+/mu.test(body);
  const hasDynamicCommand = /^\s*!`[^`\r\n]+`\s*$/mu.test(body);
  if (hasArguments) features.add('claude:arguments');
  if (hasFileReferences) features.add('claude:file-reference');
  if (hasDynamicCommand) {
    features.add('claude:dynamic-command');
    blockers.push('!commandはManaged Harnessを迂回するため実行できません');
  }

  const requestedTools = normalizeStringList(frontmatter['allowed-tools']);
  const deniedTools = normalizeStringList(frontmatter['disallowed-tools']);
  if (requestedTools.length > 0)
    warnings.push('allowed-toolsは権限を付与せず、Sprint CoderのTool catalogが上限です');
  if (deniedTools.length > 0) features.add('claude:disallowed-tools');

  if (hasCodexMetadata) validateCodexMetadata(files);

  const hasClaudeFeature =
    [...features].some((feature) => feature.startsWith('claude:')) ||
    Object.keys(frontmatter).some((key) => CLAUDE_FIELDS.has(key));
  const profile: SkillProfile = hasClaudeFeature
    ? 'claude-native'
    : hasCodexMetadata
      ? 'codex-native'
      : 'portable';
  const unknownBlocked = unknownFields.length > 0;
  const claudeBlocked = hasDynamicCommand || unknownBlocked;
  const crossRuntimeBlocked =
    unknownBlocked ||
    hasDynamicCommand ||
    ['context', 'agent', 'model', 'shell'].some((key) => key in frontmatter);

  const runtimeSupport: SkillCompatibilityReport['runtimeSupport'] = {
    codex:
      profile === 'claude-native' && crossRuntimeBlocked
        ? 'blocked'
        : profile === 'claude-native'
          ? 'portable'
          : 'full',
    claude:
      claudeBlocked || (profile === 'claude-native' && crossRuntimeBlocked && hasDynamicCommand)
        ? 'blocked'
        : profile === 'codex-native' || (profile === 'portable' && hasPackageResources)
          ? 'portable'
          : 'full',
    provider:
      profile === 'portable'
        ? hasPackageResources
          ? 'portable'
          : 'full'
        : crossRuntimeBlocked || hasFileReferences
          ? 'blocked'
          : 'portable',
  };
  return {
    profile,
    runtimeSupport,
    features: [...features].sort(),
    requestedTools: [...new Set([...requestedTools, ...deniedTools])].sort(),
    warnings,
    blockers,
    requiresConversion:
      blockers.length > 0 || Object.values(runtimeSupport).some((support) => support === 'blocked'),
    nativeModeConsentRequired: profile === 'claude-native' && !claudeBlocked,
  };
}

function validateCodexMetadata(
  files: readonly { path: string; bytes?: Buffer; content?: string }[],
): void {
  const file = files.find(({ path }) => path === 'agents/openai.yaml');
  if (file === undefined) return;
  const text = file.content ?? (file.bytes === undefined ? '' : decodeUtf8(file.bytes, file.path));
  if (Buffer.byteLength(text, 'utf8') > MAX_FRONTMATTER_BYTES)
    throw new Error('agents/openai.yaml is too large');
  const document = parseDocument(text, {
    schema: 'failsafe',
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0)
    throw new Error('agents/openai.yaml is invalid or unsafe');
  try {
    const value: unknown = document.toJS({ maxAliasCount: 0, mapAsMap: false });
    if (!isPlainRecord(value)) throw new Error('not a mapping');
    assertJsonLike(value, 'agents/openai.yaml');
  } catch {
    throw new Error('agents/openai.yaml aliases are not allowed');
  }
}

function decodeUtf8(bytes: Buffer, label: string): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${label} must be valid UTF-8`);
  return text;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength)
    throw new Error(`SKILL.md ${field} is invalid`);
  return value.trim();
}

function normalizeStringList(value: unknown): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,]+/u)
      : [];
  return values
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 64);
}

function assertJsonLike(value: unknown, label: string, depth = 0): void {
  if (depth > 16) throw new Error(`${label} is too deeply nested`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error(`${label} contains too many values`);
    for (const item of value) assertJsonLike(item, label, depth + 1);
    return;
  }
  if (!isPlainRecord(value)) throw new Error(`${label} contains an unsupported YAML value`);
  if (Object.keys(value).length > 256) throw new Error(`${label} contains too many keys`);
  for (const item of Object.values(value)) assertJsonLike(item, label, depth + 1);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
