import {
  claudeEffortSchema,
  codexModelIdSchema,
  codexModelOptionSchema,
  publicErrorSchema,
  toolCatalogSnapshotSchema,
  turnStageSchema,
  type PublicError,
  type CodexModelOption,
  type TurnStage,
} from '@sprint-coder/contracts';
import { verifyToolCatalogSnapshot, type ToolCatalogSnapshot } from '@sprint-coder/domain';
import { basename, dirname, isAbsolute, normalize, sep } from 'node:path';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { canonicalizeExistingPath, pathComparisonKey } from '../path-comparison';
import { TEAM_MCP_TOOL_NAMES, type TeamMcpToolName } from './team-mcp-tool-contract';

export const RUNTIME_PROTOCOL_VERSION = 11;

export type RuntimeImageAttachmentManifestEntry = Readonly<{
  id: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  byteLength: number;
  sha256: string;
}>;

export type RuntimePreparedImageAttachments = Readonly<{
  runtimeInstanceId: string;
  taskId: string;
  turnId: string;
  operationId: string;
  selectionIdentity: string;
  manifestDigest: string;
  decodedByteLength: number;
}>;

export function runtimeImageManifestDigest(
  manifest: readonly RuntimeImageAttachmentManifestEntry[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        manifest.map(({ id, mimeType, byteLength, sha256 }) => ({
          byteLength,
          id,
          mimeType,
          sha256,
        })),
      ),
    )
    .digest('hex');
}

export type RuntimeWorkspaceRoot = Readonly<{
  rootId: string;
  path: string;
  label: string;
  role: 'primary' | 'secondary';
}>;

export type RuntimeWorkspaceSet = Readonly<{
  primaryRootId: string | null;
  roots: readonly RuntimeWorkspaceRoot[];
  digest: string;
}>;

/** Compatibility adapter for in-process callers that still own one isolated Workspace. */
export function runtimeWorkspaceSetFromLegacyPath(path: string | null): RuntimeWorkspaceSet {
  if (path === null)
    return {
      primaryRootId: null,
      roots: [],
      digest: createHash('sha256').update('').digest('hex'),
    };
  const canonicalPath = canonicalizeExistingPath(path);
  const identityPath = pathComparisonKey(canonicalPath);
  const rootId = createHash('sha256').update(identityPath).digest('hex');
  return {
    primaryRootId: rootId,
    roots: [
      {
        rootId,
        path: canonicalPath,
        label: basename(canonicalPath) || canonicalPath,
        role: 'primary',
      },
    ],
    digest: createHash('sha256').update(`legacy\0${identityPath}`).digest('hex'),
  };
}

export type RuntimeContextFragment = Readonly<{
  id: string;
  source: 'system' | 'history' | 'goal' | 'compaction' | 'background' | 'skill';
  trust: 'system' | 'user' | 'assistant';
  authority: 'system' | 'user' | 'none';
  content: string;
}>;
export type RuntimeProjectContextItem = Readonly<{
  id: string;
  kind: 'instruction' | 'memory' | 'reference';
  authority: 'user' | 'none';
  localOnly: boolean;
  sealedDigest: string;
  content: string;
}>;
export type RuntimeSkillInput = Readonly<{
  name: string;
  path: string;
}>;

/** Additive, optional per-turn addendum: when present, the Codex/Claude adapter wires the real Leader
 * up to team-mcp-bridge.ts (via an ephemeral MCP stdio server) instead of running the plain
 * no-tools profile. `socketPath`/`token` name the bridge connection; `guidance` is appended to the
 * turn's prompt (see LEADER_MCP_SYSTEM_PROMPT in team-tools.ts). */
export type RuntimeTeamMcpOption = Readonly<{
  socketPath: string;
  token: string;
  guidance: string;
  /** Exact, Main-authorized tools exposed by this Turn's bridge registration. */
  toolNames: readonly TeamMcpToolName[];
  managedTools?: readonly RuntimeManagedToolDefinition[];
  toolCatalogDigest?: string;
}>;

export type RuntimeManagedToolDefinition = Readonly<{
  name: string;
  description: string;
  inputSchema: unknown;
}>;

export type RuntimeProcessIdentity = Readonly<{
  pid: number;
  parentPid: number;
  startIdentity: string;
}>;

export type RuntimeToolRequest = Readonly<{
  callId: string;
  toolName: string;
  arguments: unknown;
  catalogDigest: string;
}>;

export type RuntimeFailureStage =
  | 'first_event_timeout'
  | 'idle_timeout'
  | 'total_timeout'
  | 'protocol_error'
  | 'startup_error'
  | 'spawn_error'
  | 'abnormal_exit';

export type RuntimeStartRejectionReasonCode =
  | 'invalid_project_context_authority'
  | 'invalid_payload_digest'
  | 'invalid_runtime_start_envelope'
  | 'runtime_instance_mismatch';

export type RuntimeStartRejection = Readonly<{
  reasonCode: RuntimeStartRejectionReasonCode;
  itemKind?: 'instruction' | 'memory' | 'reference';
  authority?: 'user' | 'none';
}>;

export type RuntimeProtocolFailureReasonCode =
  RuntimeStartRejectionReasonCode | 'runtime_start_timeout';

export const RECOGNIZED_CODEX_NOTIFICATION_NAMES = new Set([
  'turn/started',
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/started',
  'item/completed',
  'turn/completed',
]);

export type ResolvedCliCommand = Readonly<{
  source:
    | 'explicit'
    | 'path'
    | 'user-local'
    | 'npm'
    | 'desktop-direct'
    | 'desktop-versioned'
    | 'fallback';
  executable: string;
  version: string;
  compatibility: 'verified' | 'compatible' | 'untested' | 'unsupported';
  capabilities: readonly string[];
}>;

export type RuntimeFailureDiagnostic = Readonly<{
  version: 1;
  diagnosticId: string;
  runtimeKind: 'codex' | 'claude';
  failureStage: RuntimeFailureStage;
  elapsedMs: number;
  appVersion: string;
  cliVersion: string | null;
  capabilityMismatch?: Readonly<{
    missingTools: readonly string[];
    unexpectedTools: readonly string[];
  }>;
  cliResolution?: ResolvedCliCommand;
  teamMcp: Readonly<{
    enabled: boolean;
    status: 'configured' | 'not_configured';
  }>;
  lastRecognizedNotification: string | null;
  lastReceivedNotification: string | null;
  unsupportedNotificationCount: number;
  stderrObserved: boolean;
  stderrTruncated: boolean;
  codexIsolation?: Readonly<{
    userConfigSnapshot: 'disabled' | 'missing' | 'copied';
    selectedSkillCount: number;
    disabledUnexpectedSkillCount: number;
    verified: boolean;
  }>;
  recordedAt: string;
  reasonCode?: RuntimeProtocolFailureReasonCode;
}>;

type EnvelopeBase = {
  protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  runtimeInstanceId: string;
  taskId: string;
  turnId: string;
  seq: number;
  operationId: string;
};

export type RuntimeCanonicalEvent =
  | { type: 'heartbeat'; at: string }
  | {
      type: 'operation';
      phase: 'command_start' | 'command_end' | 'tool_call_start' | 'tool_call_end';
      label: string;
      sideEffect?: boolean;
    }
  | { type: 'stage'; stage: TurnStage }
  | { type: 'delta'; messageId: string; delta: string }
  // `resolvedModel` is additive/optional: only the Claude adapter's normalizer ever populates it
  // (captured from the stream-json `system/init` event's `model` field — see
  // claude-normalizer.ts), giving Main a way to surface the concrete model id the CLI actually
  // resolved for an `auto`/alias selection (see the ADR amendment). Codex's normalizer never sets
  // it, so this stays undefined for Codex turns.
  | { type: 'completed'; resolvedModel?: string; finalText?: string }
  // The model's own reasoning text (issue #17). Verified to arrive in the current profile:
  // `--effort max` on a prompt that needs reasoning produces `content_block_start type='thinking'`
  // followed by `thinking_delta` (codex-cli's Claude CLI 2.1.218). It does NOT arrive for a trivial
  // prompt at `--effort high`, which is why the degraded "no reasoning at all" path is a normal
  // case rather than a hypothetical.
  //
  // Additive: runtime-host and main ship in the same app, so RUNTIME_PROTOCOL_VERSION stays put.
  | { type: 'reasoning'; text: string }
  // Codex's thread id, captured from its structured `thread.started` event (issue #11).
  //
  // This is how generated images are located, and the reason it is an *id* rather than a path is
  // the whole security argument: the CLI writes images to
  // `$CODEX_HOME/generated_images/<thread_id>/<call_id>.png` itself, and the only place a path to
  // them appears in the event stream is inside model-generated prose ("生成済みファイル:
  // [call_x.png](/Users/…)"). Reading a path out of that prose would be an arbitrary-file-read
  // primitive driven by attacker-influenceable text — a prompt injection in repo content could name
  // ~/.ssh/id_rsa and the app would copy it into an artifact the user then opens. Verified on
  // codex-cli 0.144.4 that `thread.started`'s `thread_id` matches the directory name exactly, so
  // Main can enumerate a bounded directory and never parse a path at all.
  | { type: 'thread'; threadId: string };

// File changes never cross this Runtime boundary. Main records them from the Managed Harness
// post-image after the Edit Saga commits, so provider output cannot forge Timeline evidence.

type RuntimeStartRequest = {
  input: string;
  workspace: RuntimeWorkspaceSet;
  model: string;
  effort?: string;
  writeScope?: 'read-only' | 'workspace-write' | 'full';
  contextFragments: RuntimeContextFragment[];
  projectItems: RuntimeProjectContextItem[];
  projectSnapshotDigest: string | null;
  payload: string;
  payloadDigest: string;
  skills?: RuntimeSkillInput[];
  toolCatalogSnapshot: ToolCatalogSnapshot;
  teamMcp?: RuntimeTeamMcpOption;
};

export type MainToRuntimeEnvelope =
  | (EnvelopeBase & { type: 'hello' })
  | (EnvelopeBase & {
      type: 'prepare_images';
      selectionIdentity: string;
      manifest: RuntimeImageAttachmentManifestEntry[];
      paths: string[];
      manifestDigest: string;
    })
  | (EnvelopeBase & RuntimeStartRequest & { type: 'start' })
  | (EnvelopeBase &
      RuntimeStartRequest & {
        type: 'commit_images';
        selectionIdentity: string;
        manifestDigest: string;
      })
  | (EnvelopeBase & { type: 'cancel' })
  | (EnvelopeBase & {
      type: 'tool_result';
      callId: string;
      success: boolean;
      output: unknown;
    });

export type RuntimeToMainEnvelope =
  | (EnvelopeBase & {
      type: 'hello';
      codexAvailable: boolean;
      codexReadiness: 'ready' | 'authentication_required' | 'unavailable';
      codexVersion?: string;
      codexCli?: ResolvedCliCommand;
      codexModels: CodexModelOption[];
      // Additive fields for the Claude CLI runtime (Slice 3.4). A given Runtime Host process
      // only ever hosts one adapter kind, so exactly one provider's fields are meaningful per
      // process; the other provider's boolean/array still round-trip validation with its
      // always-supplied default (false/[]) rather than being made structurally optional, which
      // keeps existing `codexAvailable`/`codexModels` consumers unchanged.
      claudeAvailable: boolean;
      claudeReadiness: 'ready' | 'authentication_required' | 'unavailable';
      claudeVersion?: string;
      claudeCli?: ResolvedCliCommand;
      claudeModels: CodexModelOption[];
    })
  | (EnvelopeBase & {
      type: 'images_prepared';
      selectionIdentity: string;
      manifestDigest: string;
      decodedByteLength: number;
    })
  | (EnvelopeBase & { type: 'images_prepare_failed'; error: PublicError })
  | (EnvelopeBase & {
      type: 'runtime_process';
      processIdentity: RuntimeProcessIdentity;
    })
  | (EnvelopeBase & {
      type: 'started';
      acceptedContextFragmentIds: string[];
      acceptedProjectItemIds: string[];
      acceptedProjectSnapshotDigest: string | null;
      acceptedPayloadDigest: string;
    })
  | (EnvelopeBase & { type: 'stopped'; forced: boolean })
  | (EnvelopeBase & { type: 'event'; event: RuntimeCanonicalEvent })
  | (EnvelopeBase & { type: 'tool_request'; request: RuntimeToolRequest })
  | (EnvelopeBase & { type: 'tool_cancel'; callId: string })
  | (EnvelopeBase & { type: 'exit'; code: number; canceled: boolean })
  | (EnvelopeBase & {
      type: 'error';
      error: PublicError;
      diagnostic?: RuntimeFailureDiagnostic;
      rejection?: RuntimeStartRejection;
    });

export type CorrelatedRuntimeStartRejection = Readonly<{
  taskId: string;
  turnId: string;
  operationId: string;
  rejection: RuntimeStartRejection;
}>;

/** Extracts bounded correlation and allowlisted metadata without reflecting content-bearing data. */
export function correlatedRuntimeStartRejection(
  value: unknown,
  expectedRuntimeInstanceId: string,
): CorrelatedRuntimeStartRejection | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record['type'] !== 'start' && record['type'] !== 'commit_images') return null;
  const taskId = safeCorrelationId(record['taskId']);
  const turnId = safeCorrelationId(record['turnId']);
  const operationId = safeCorrelationId(record['operationId']);
  if (taskId === null || turnId === null || operationId === null) return null;

  if (record['runtimeInstanceId'] !== expectedRuntimeInstanceId)
    return {
      taskId,
      turnId,
      operationId,
      rejection: { reasonCode: 'runtime_instance_mismatch' },
    };
  if (!isWithinStartRejectionInspectionBudget(record))
    return {
      taskId,
      turnId,
      operationId,
      rejection: { reasonCode: 'invalid_runtime_start_envelope' },
    };
  if (isMainToRuntimeEnvelope(value)) return null;
  const invalidAuthority = invalidProjectContextAuthority(record['projectItems']);
  if (invalidAuthority !== null)
    return {
      taskId,
      turnId,
      operationId,
      rejection: { reasonCode: 'invalid_project_context_authority', ...invalidAuthority },
    };
  if (!hasMatchingPayloadDigest(record))
    return {
      taskId,
      turnId,
      operationId,
      rejection: { reasonCode: 'invalid_payload_digest' },
    };
  return {
    taskId,
    turnId,
    operationId,
    rejection: { reasonCode: 'invalid_runtime_start_envelope' },
  };
}

function isWithinStartRejectionInspectionBudget(record: Record<string, unknown>): boolean {
  const projectItems = record['projectItems'];
  if (Array.isArray(projectItems) && projectItems.length > 256) return false;
  const payload = record['payload'];
  if (typeof payload !== 'string') return true;
  // Check code-unit length first so a hostile multi-megabyte string is never traversed or hashed.
  return payload.length <= 512 * 1024 && Buffer.byteLength(payload, 'utf8') <= 512 * 1024;
}

export function isMainToRuntimeEnvelope(value: unknown): value is MainToRuntimeEnvelope {
  if (!hasValidBase(value)) return false;
  if (value.type === 'hello' || value.type === 'cancel') return true;
  if (value.type === 'tool_result')
    return (
      'callId' in value &&
      isBoundedCallId(value.callId) &&
      'success' in value &&
      typeof value.success === 'boolean' &&
      'output' in value &&
      isBoundedJson(value.output, 1024 * 1024)
    );
  if (value.type === 'prepare_images') return isRuntimeImagePreparation(value);
  return (
    (value.type === 'start' || value.type === 'commit_images') &&
    (value.type !== 'commit_images' ||
      ('selectionIdentity' in value &&
        isSha256(value.selectionIdentity) &&
        'manifestDigest' in value &&
        isSha256(value.manifestDigest))) &&
    'input' in value &&
    typeof value.input === 'string' &&
    'workspace' in value &&
    isRuntimeWorkspaceSet(value.workspace) &&
    'model' in value &&
    codexModelIdSchema.safeParse(value.model).success &&
    (!('effort' in value) ||
      value.effort === undefined ||
      claudeEffortSchema.safeParse(value.effort).success) &&
    // Validated here rather than trusted: this value decides whether the adapter hands the CLI a
    // writable sandbox, so an unrecognised string must not fall through to a permissive default.
    (!('writeScope' in value) ||
      value.writeScope === undefined ||
      value.writeScope === 'read-only' ||
      value.writeScope === 'workspace-write' ||
      value.writeScope === 'full') &&
    'contextFragments' in value &&
    isRuntimeContextFragments(value.contextFragments) &&
    'projectItems' in value &&
    isRuntimeProjectContextItems(value.projectItems, value.contextFragments) &&
    'projectSnapshotDigest' in value &&
    (value.projectSnapshotDigest === null || isSha256(value.projectSnapshotDigest)) &&
    'payload' in value &&
    typeof value.payload === 'string' &&
    Buffer.byteLength(value.payload, 'utf8') <= 512 * 1024 &&
    'payloadDigest' in value &&
    isSha256(value.payloadDigest) &&
    createHash('sha256').update(Buffer.from(value.payload, 'utf8')).digest('hex') ===
      value.payloadDigest &&
    (!('skills' in value) || value.skills === undefined || isRuntimeSkillInputs(value.skills)) &&
    !('codexConfigPolicy' in value) &&
    'toolCatalogSnapshot' in value &&
    isVerifiedReadOnlyCatalog(value.toolCatalogSnapshot) &&
    (!('teamMcp' in value) || value.teamMcp === undefined || isRuntimeTeamMcpOption(value.teamMcp))
  );
}

function isRuntimeImagePreparation(value: Record<string, unknown>): boolean {
  if (
    !isSha256(value['selectionIdentity']) ||
    !isSha256(value['manifestDigest']) ||
    !Array.isArray(value['manifest']) ||
    value['manifest'].length < 1 ||
    value['manifest'].length > 4 ||
    !Array.isArray(value['paths']) ||
    value['paths'].length !== value['manifest'].length
  )
    return false;
  let total = 0;
  let directory: string | null = null;
  const ids = new Set<string>();
  for (const [index, raw] of value['manifest'].entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry['id'] !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(entry['id']) ||
      ids.has(entry['id']) ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(String(entry['mimeType'])) ||
      !Number.isSafeInteger(entry['byteLength']) ||
      Number(entry['byteLength']) < 1 ||
      Number(entry['byteLength']) > 5 * 1024 * 1024 ||
      !isSha256(entry['sha256']) ||
      Object.keys(entry).some((key) => !['id', 'mimeType', 'byteLength', 'sha256'].includes(key))
    )
      return false;
    ids.add(entry['id']);
    total += Number(entry['byteLength']);
    const path = value['paths'][index];
    if (typeof path !== 'string' || !isAbsolute(path)) return false;
    const expectedExtension =
      entry['mimeType'] === 'image/png'
        ? '.png'
        : entry['mimeType'] === 'image/jpeg'
          ? '.jpg'
          : '.webp';
    if (basename(path) !== `${String(index + 1).padStart(3, '0')}${expectedExtension}`)
      return false;
    const currentDirectory = dirname(path);
    if (directory === null) directory = currentDirectory;
    else if (currentDirectory !== directory) return false;
  }
  return total <= 16 * 1024 * 1024;
}

function isRuntimeWorkspaceSet(value: unknown): value is RuntimeWorkspaceSet {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!isSha256(record['digest']) || !Array.isArray(record['roots']) || record['roots'].length > 16)
    return false;
  const roots = record['roots'];
  const primaryRootId = record['primaryRootId'];
  if (primaryRootId !== null && typeof primaryRootId !== 'string') return false;
  const ids = new Set<string>();
  const paths = new Set<string>();
  let primaryCount = 0;
  for (const root of roots) {
    if (typeof root !== 'object' || root === null) return false;
    const item = root as Record<string, unknown>;
    if (
      typeof item['rootId'] !== 'string' ||
      item['rootId'].length === 0 ||
      typeof item['path'] !== 'string' ||
      !isAbsolute(item['path']) ||
      normalize(item['path']) !== item['path'] ||
      typeof item['label'] !== 'string' ||
      item['label'].length === 0 ||
      (item['role'] !== 'primary' && item['role'] !== 'secondary') ||
      ids.has(item['rootId']) ||
      paths.has(pathComparisonKey(item['path']))
    )
      return false;
    ids.add(item['rootId']);
    paths.add(pathComparisonKey(item['path']));
    if (item['role'] === 'primary') {
      primaryCount += 1;
      if (item['rootId'] !== primaryRootId) return false;
    }
  }
  return roots.length === 0
    ? primaryRootId === null && primaryCount === 0
    : typeof primaryRootId === 'string' && primaryCount === 1;
}

function isRuntimeSkillInputs(value: unknown): value is RuntimeSkillInput[] {
  return (
    Array.isArray(value) &&
    value.length <= 6 &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        Object.keys(item).every((key) => key === 'name' || key === 'path') &&
        typeof (item as Record<string, unknown>)['name'] === 'string' &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(
          (item as Record<string, unknown>)['name'] as string,
        ) &&
        typeof (item as Record<string, unknown>)['path'] === 'string' &&
        isManagedRuntimeSkillPath(
          (item as Record<string, unknown>)['name'] as string,
          (item as Record<string, unknown>)['path'] as string,
        ),
    )
  );
}

function isManagedRuntimeSkillPath(name: string, path: string): boolean {
  if (path.length < 1 || path.length > 4_096 || !isAbsolute(path) || normalize(path) !== path)
    return false;
  const parts = path.split(sep);
  const digest = parts.at(-1);
  const skillId = parts.at(-2);
  const source = parts.at(-3);
  const revisions = parts.at(-4);
  return (
    revisions === 'revisions' &&
    ['builtin', 'created', 'claude', 'agents'].includes(source ?? '') &&
    skillId === name &&
    /^[a-f0-9]{64}$/.test(digest ?? '')
  );
}

function isRuntimeTeamMcpOption(value: unknown): value is RuntimeTeamMcpOption {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['socketPath'] === 'string' &&
    record['socketPath'].length > 0 &&
    record['socketPath'].length <= 1024 &&
    typeof record['token'] === 'string' &&
    record['token'].length >= 16 &&
    record['token'].length <= 256 &&
    typeof record['guidance'] === 'string' &&
    record['guidance'].length <= 20_000 &&
    Array.isArray(record['toolNames']) &&
    (record['toolNames'].length > 0 ||
      (Array.isArray(record['managedTools']) && record['managedTools'].length > 0)) &&
    record['toolNames'].length <= TEAM_MCP_TOOL_NAMES.length &&
    new Set(record['toolNames']).size === record['toolNames'].length &&
    record['toolNames'].every(
      (name) => typeof name === 'string' && TEAM_MCP_TOOL_NAMES.includes(name as TeamMcpToolName),
    ) &&
    (record['managedTools'] === undefined ||
      (Array.isArray(record['managedTools']) &&
        record['managedTools'].length <= 32 &&
        new Set(
          record['managedTools'].map((tool) =>
            typeof tool === 'object' && tool !== null
              ? (tool as Record<string, unknown>)['name']
              : null,
          ),
        ).size === record['managedTools'].length &&
        record['managedTools'].every(isRuntimeManagedToolDefinition))) &&
    (record['toolCatalogDigest'] === undefined || isSha256(record['toolCatalogDigest']))
  );
}

function isRuntimeManagedToolDefinition(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const tool = value as Record<string, unknown>;
  return (
    Object.keys(tool).every((key) => ['name', 'description', 'inputSchema'].includes(key)) &&
    typeof tool['name'] === 'string' &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(tool['name']) &&
    typeof tool['description'] === 'string' &&
    tool['description'].length > 0 &&
    tool['description'].length <= 2_000 &&
    isBoundedJson(tool['inputSchema'], 64 * 1024)
  );
}

function isRuntimeContextFragments(value: unknown): value is RuntimeContextFragment[] {
  if (!Array.isArray(value) || value.length > 256) return false;
  let totalBytes = 0;
  const ids = new Set<string>();
  for (const fragment of value) {
    if (typeof fragment !== 'object' || fragment === null) return false;
    const record = fragment as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) => !['id', 'source', 'trust', 'authority', 'content'].includes(key),
      ) ||
      typeof record['id'] !== 'string' ||
      record['id'].length < 1 ||
      record['id'].length > 128 ||
      ids.has(record['id']) ||
      !['system', 'history', 'goal', 'compaction', 'background', 'skill'].includes(
        record['source'] as string,
      ) ||
      !['system', 'user', 'assistant'].includes(record['trust'] as string) ||
      !['system', 'user', 'none'].includes(record['authority'] as string) ||
      !hasValidFragmentAuthority(record) ||
      typeof record['content'] !== 'string' ||
      Buffer.byteLength(record['content'], 'utf8') > 64 * 1024
    )
      return false;
    ids.add(record['id']);
    totalBytes += Buffer.byteLength(record['content'], 'utf8');
    if (totalBytes > 128 * 1024) return false;
  }
  return true;
}

function isRuntimeProjectContextItems(
  value: unknown,
  fragments: readonly RuntimeContextFragment[],
): value is RuntimeProjectContextItem[] {
  if (!Array.isArray(value) || fragments.length + value.length > 256) return false;
  let totalBytes = fragments.reduce(
    (total, fragment) => total + Buffer.byteLength(fragment.content, 'utf8'),
    0,
  );
  const ids = new Set(fragments.map((fragment) => fragment.id));
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return false;
    const record = item as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) => !['id', 'kind', 'authority', 'localOnly', 'sealedDigest', 'content'].includes(key),
      ) ||
      typeof record['id'] !== 'string' ||
      record['id'].length < 1 ||
      record['id'].length > 128 ||
      ids.has(record['id']) ||
      !['instruction', 'memory', 'reference'].includes(record['kind'] as string) ||
      !['user', 'none'].includes(record['authority'] as string) ||
      !hasValidProjectItemAuthority(record['kind'], record['authority']) ||
      typeof record['localOnly'] !== 'boolean' ||
      !isSha256(record['sealedDigest']) ||
      typeof record['content'] !== 'string'
    )
      return false;
    const bytes = Buffer.byteLength(record['content'], 'utf8');
    if (bytes > 64 * 1024) return false;
    totalBytes += bytes;
    if (totalBytes > 128 * 1024) return false;
    ids.add(record['id']);
  }
  return true;
}

function hasValidProjectItemAuthority(kind: unknown, authority: unknown): boolean {
  if (kind === 'instruction') return authority === 'user';
  if (kind === 'reference') return authority === 'none';
  // Project Memory preserves its creator: user-authored Memory carries user authority while
  // assistant-authored Memory is context only and must never be upgraded from `none` in transit.
  return kind === 'memory' && (authority === 'user' || authority === 'none');
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function hasValidFragmentAuthority(fragment: Record<string, unknown>): boolean {
  if (fragment['source'] === 'system') return fragment['authority'] === 'system';
  if (fragment['source'] === 'goal') return fragment['authority'] === 'user';
  if (fragment['source'] === 'skill')
    return fragment['authority'] === (fragment['trust'] === 'user' ? 'user' : 'none');
  if (fragment['source'] === 'history')
    return fragment['authority'] === (fragment['trust'] === 'user' ? 'user' : 'none');
  return fragment['authority'] === 'none';
}

function isVerifiedReadOnlyCatalog(value: unknown): value is ToolCatalogSnapshot {
  const parsed = toolCatalogSnapshotSchema.safeParse(value);
  return parsed.success && verifyToolCatalogSnapshot(parsed.data as unknown as ToolCatalogSnapshot);
}

export function isRuntimeToMainEnvelope(value: unknown): value is RuntimeToMainEnvelope {
  if (!hasValidBase(value)) return false;
  if (value.type === 'hello')
    return (
      'codexAvailable' in value &&
      typeof value.codexAvailable === 'boolean' &&
      'codexReadiness' in value &&
      ['ready', 'authentication_required', 'unavailable'].includes(
        value.codexReadiness as string,
      ) &&
      (!('codexVersion' in value) || typeof value.codexVersion === 'string') &&
      (!('codexCli' in value) || isResolvedCliCommand(value.codexCli)) &&
      'codexModels' in value &&
      Array.isArray(value.codexModels) &&
      value.codexModels.length <= 32 &&
      value.codexModels.every((model) => codexModelOptionSchema.safeParse(model).success) &&
      'claudeAvailable' in value &&
      typeof value.claudeAvailable === 'boolean' &&
      'claudeReadiness' in value &&
      ['ready', 'authentication_required', 'unavailable'].includes(
        value.claudeReadiness as string,
      ) &&
      (!('claudeVersion' in value) || typeof value.claudeVersion === 'string') &&
      (!('claudeCli' in value) || isResolvedCliCommand(value.claudeCli)) &&
      'claudeModels' in value &&
      Array.isArray(value.claudeModels) &&
      value.claudeModels.length <= 32 &&
      value.claudeModels.every((model) => codexModelOptionSchema.safeParse(model).success)
    );
  if (value.type === 'images_prepared')
    return (
      'selectionIdentity' in value &&
      isSha256(value.selectionIdentity) &&
      'manifestDigest' in value &&
      isSha256(value.manifestDigest) &&
      'decodedByteLength' in value &&
      Number.isSafeInteger(value.decodedByteLength) &&
      Number(value.decodedByteLength) > 0 &&
      Number(value.decodedByteLength) <= 16 * 1024 * 1024
    );
  if (value.type === 'images_prepare_failed')
    return 'error' in value && publicErrorSchema.safeParse(value.error).success;
  if (value.type === 'runtime_process')
    return (
      'processIdentity' in value &&
      typeof value.processIdentity === 'object' &&
      value.processIdentity !== null &&
      Number.isSafeInteger((value.processIdentity as Record<string, unknown>)['pid']) &&
      Number((value.processIdentity as Record<string, unknown>)['pid']) > 0 &&
      Number.isSafeInteger((value.processIdentity as Record<string, unknown>)['parentPid']) &&
      Number((value.processIdentity as Record<string, unknown>)['parentPid']) >= 0 &&
      typeof (value.processIdentity as Record<string, unknown>)['startIdentity'] === 'string' &&
      String((value.processIdentity as Record<string, unknown>)['startIdentity']).length > 0 &&
      String((value.processIdentity as Record<string, unknown>)['startIdentity']).length <= 128
    );
  if (value.type === 'started')
    return (
      'acceptedContextFragmentIds' in value &&
      Array.isArray(value.acceptedContextFragmentIds) &&
      value.acceptedContextFragmentIds.length <= 256 &&
      new Set(value.acceptedContextFragmentIds).size === value.acceptedContextFragmentIds.length &&
      value.acceptedContextFragmentIds.every(
        (id) => typeof id === 'string' && id.length > 0 && id.length <= 128,
      ) &&
      'acceptedProjectItemIds' in value &&
      Array.isArray(value.acceptedProjectItemIds) &&
      value.acceptedContextFragmentIds.length + value.acceptedProjectItemIds.length <= 256 &&
      new Set(value.acceptedProjectItemIds).size === value.acceptedProjectItemIds.length &&
      value.acceptedProjectItemIds.every(
        (id) => typeof id === 'string' && id.length > 0 && id.length <= 128,
      ) &&
      'acceptedProjectSnapshotDigest' in value &&
      (value.acceptedProjectSnapshotDigest === null ||
        isSha256(value.acceptedProjectSnapshotDigest)) &&
      'acceptedPayloadDigest' in value &&
      isSha256(value.acceptedPayloadDigest)
    );
  if (value.type === 'event') return 'event' in value && isRuntimeCanonicalEvent(value.event);
  if (value.type === 'tool_request')
    return 'request' in value && isRuntimeToolRequest(value.request);
  if (value.type === 'tool_cancel') return 'callId' in value && isBoundedCallId(value.callId);
  if (value.type === 'stopped') return 'forced' in value && typeof value.forced === 'boolean';
  if (value.type === 'exit')
    return (
      'code' in value &&
      typeof value.code === 'number' &&
      Number.isInteger(value.code) &&
      'canceled' in value &&
      typeof value.canceled === 'boolean'
    );
  return (
    value.type === 'error' &&
    'error' in value &&
    publicErrorSchema.safeParse(value.error).success &&
    (!('diagnostic' in value) ||
      value.diagnostic === undefined ||
      isRuntimeFailureDiagnostic(value.diagnostic)) &&
    (!('rejection' in value) ||
      value.rejection === undefined ||
      isRuntimeStartRejection(value.rejection))
  );
}

function isRuntimeToolRequest(value: unknown): value is RuntimeToolRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    Object.keys(request).every((key) =>
      ['callId', 'toolName', 'arguments', 'catalogDigest'].includes(key),
    ) &&
    isBoundedCallId(request['callId']) &&
    typeof request['toolName'] === 'string' &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(request['toolName']) &&
    isSha256(request['catalogDigest']) &&
    isBoundedJson(request['arguments'], 512 * 1024)
  );
}

function isBoundedCallId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  );
}

function isBoundedJson(value: unknown, maxBytes: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= maxBytes;
  } catch {
    return false;
  }
}

function isResolvedCliCommand(value: unknown): value is ResolvedCliCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) =>
      ['source', 'executable', 'version', 'compatibility', 'capabilities'].includes(key),
    ) &&
    [
      'explicit',
      'path',
      'user-local',
      'npm',
      'desktop-direct',
      'desktop-versioned',
      'fallback',
    ].includes(String(record['source'])) &&
    typeof record['executable'] === 'string' &&
    record['executable'].length > 0 &&
    record['executable'].length <= 2_048 &&
    [...record['executable']].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    }) &&
    typeof record['version'] === 'string' &&
    record['version'].length > 0 &&
    record['version'].length <= 128 &&
    ['verified', 'compatible', 'untested', 'unsupported'].includes(
      String(record['compatibility']),
    ) &&
    Array.isArray(record['capabilities']) &&
    record['capabilities'].length <= 32 &&
    record['capabilities'].every(
      (capability) => typeof capability === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(capability),
    )
  );
}

export function isRuntimeFailureDiagnostic(value: unknown): value is RuntimeFailureDiagnostic {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const teamMcp = record['teamMcp'];
  const structurallyValid =
    Object.keys(record).every((key) =>
      [
        'version',
        'diagnosticId',
        'runtimeKind',
        'failureStage',
        'elapsedMs',
        'appVersion',
        'cliVersion',
        'capabilityMismatch',
        'cliResolution',
        'teamMcp',
        'lastRecognizedNotification',
        'lastReceivedNotification',
        'unsupportedNotificationCount',
        'stderrObserved',
        'stderrTruncated',
        'codexIsolation',
        'recordedAt',
        'reasonCode',
      ].includes(key),
    ) &&
    record['version'] === 1 &&
    typeof record['diagnosticId'] === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record['diagnosticId'],
    ) &&
    (record['runtimeKind'] === 'codex' || record['runtimeKind'] === 'claude') &&
    [
      'first_event_timeout',
      'idle_timeout',
      'total_timeout',
      'protocol_error',
      'startup_error',
      'spawn_error',
      'abnormal_exit',
    ].includes(String(record['failureStage'])) &&
    typeof record['elapsedMs'] === 'number' &&
    Number.isSafeInteger(record['elapsedMs']) &&
    record['elapsedMs'] >= 0 &&
    typeof record['appVersion'] === 'string' &&
    record['appVersion'].length <= 64 &&
    (record['cliVersion'] === null ||
      (typeof record['cliVersion'] === 'string' &&
        record['cliVersion'].length <= 128 &&
        (record['runtimeKind'] === 'codex'
          ? /^(?:codex|codex-cli) v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(
              record['cliVersion'],
            )
          : /^(?:claude-code )?v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?: \(Claude Code\))?$/.test(
              record['cliVersion'],
            )))) &&
    (!('capabilityMismatch' in record) ||
      record['capabilityMismatch'] === undefined ||
      isCapabilityMismatch(record['capabilityMismatch'])) &&
    (!('cliResolution' in record) ||
      record['cliResolution'] === undefined ||
      isResolvedCliCommand(record['cliResolution'])) &&
    typeof teamMcp === 'object' &&
    teamMcp !== null &&
    Object.keys(teamMcp).every((key) => key === 'enabled' || key === 'status') &&
    typeof (teamMcp as Record<string, unknown>)['enabled'] === 'boolean' &&
    ['configured', 'not_configured'].includes(
      String((teamMcp as Record<string, unknown>)['status']),
    ) &&
    (record['lastRecognizedNotification'] === null ||
      (typeof record['lastRecognizedNotification'] === 'string' &&
        RECOGNIZED_CODEX_NOTIFICATION_NAMES.has(record['lastRecognizedNotification']))) &&
    (record['lastReceivedNotification'] === null ||
      record['lastReceivedNotification'] === '[unsupported]' ||
      (typeof record['lastReceivedNotification'] === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u.test(record['lastReceivedNotification']) &&
        !/(?:^|[/:])(?:auth|credential|private|request|secret|token|users?)(?:[/:]|$)/iu.test(
          record['lastReceivedNotification'],
        ) &&
        !/^[A-Za-z]:[\\/]/u.test(record['lastReceivedNotification']))) &&
    typeof record['unsupportedNotificationCount'] === 'number' &&
    Number.isSafeInteger(record['unsupportedNotificationCount']) &&
    record['unsupportedNotificationCount'] >= 0 &&
    typeof record['stderrObserved'] === 'boolean' &&
    typeof record['stderrTruncated'] === 'boolean' &&
    (!('codexIsolation' in record) ||
      record['codexIsolation'] === undefined ||
      isCodexIsolationDiagnostic(record['codexIsolation'])) &&
    (!('reasonCode' in record) ||
      record['reasonCode'] === undefined ||
      [
        'invalid_project_context_authority',
        'invalid_payload_digest',
        'invalid_runtime_start_envelope',
        'runtime_instance_mismatch',
        'runtime_start_timeout',
      ].includes(String(record['reasonCode']))) &&
    typeof record['recordedAt'] === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record['recordedAt']) &&
    Number.isFinite(Date.parse(record['recordedAt']));
  if (!structurallyValid) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16 * 1024;
  } catch {
    return false;
  }
}

function isCapabilityMismatch(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const safeList = (candidate: unknown): boolean =>
    Array.isArray(candidate) &&
    candidate.length <= 32 &&
    candidate.every(
      (name) => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(name),
    );
  return (
    Object.keys(record).every((key) => ['missingTools', 'unexpectedTools'].includes(key)) &&
    safeList(record['missingTools']) &&
    safeList(record['unexpectedTools'])
  );
}

function isCodexIsolationDiagnostic(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) =>
      [
        'userConfigSnapshot',
        'selectedSkillCount',
        'disabledUnexpectedSkillCount',
        'verified',
      ].includes(key),
    ) &&
    ['disabled', 'missing', 'copied'].includes(String(record['userConfigSnapshot'])) &&
    Number.isSafeInteger(record['selectedSkillCount']) &&
    Number(record['selectedSkillCount']) >= 0 &&
    Number(record['selectedSkillCount']) <= 6 &&
    Number.isSafeInteger(record['disabledUnexpectedSkillCount']) &&
    Number(record['disabledUnexpectedSkillCount']) >= 0 &&
    Number(record['disabledUnexpectedSkillCount']) <= 10_000 &&
    typeof record['verified'] === 'boolean'
  );
}

function safeCorrelationId(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[0-9A-Za-z:._-]+$/.test(value)
    ? value
    : null;
}

function invalidProjectContextAuthority(value: unknown): {
  itemKind: 'instruction' | 'memory' | 'reference';
  authority: 'user' | 'none';
} | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const itemKind = record['kind'];
    const authority = record['authority'];
    if (
      (itemKind === 'instruction' || itemKind === 'memory' || itemKind === 'reference') &&
      (authority === 'user' || authority === 'none') &&
      !hasValidProjectItemAuthority(itemKind, authority)
    )
      return { itemKind, authority };
  }
  return null;
}

function hasMatchingPayloadDigest(record: Record<string, unknown>): boolean {
  return (
    typeof record['payload'] === 'string' &&
    isSha256(record['payloadDigest']) &&
    createHash('sha256').update(Buffer.from(record['payload'], 'utf8')).digest('hex') ===
      record['payloadDigest']
  );
}

function isRuntimeStartRejection(value: unknown): value is RuntimeStartRejection {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => ['reasonCode', 'itemKind', 'authority'].includes(key)) &&
    [
      'invalid_project_context_authority',
      'invalid_payload_digest',
      'invalid_runtime_start_envelope',
      'runtime_instance_mismatch',
    ].includes(String(record['reasonCode'])) &&
    (!('itemKind' in record) ||
      record['itemKind'] === undefined ||
      ['instruction', 'memory', 'reference'].includes(String(record['itemKind']))) &&
    (!('authority' in record) ||
      record['authority'] === undefined ||
      record['authority'] === 'user' ||
      record['authority'] === 'none')
  );
}

function isRuntimeCanonicalEvent(value: unknown): value is RuntimeCanonicalEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  if (value.type === 'heartbeat')
    return 'at' in value && typeof value.at === 'string' && Number.isFinite(Date.parse(value.at));
  if (value.type === 'completed') {
    const resolvedModelValid =
      !('resolvedModel' in value) ||
      value.resolvedModel === undefined ||
      (typeof value.resolvedModel === 'string' &&
        value.resolvedModel.length > 0 &&
        value.resolvedModel.length <= 128);
    const finalTextValid =
      !('finalText' in value) ||
      value.finalText === undefined ||
      (typeof value.finalText === 'string' &&
        value.finalText.length > 0 &&
        value.finalText.length <= 1_000_000);
    return resolvedModelValid && finalTextValid;
  }
  if (value.type === 'stage')
    return 'stage' in value && turnStageSchema.safeParse(value.stage).success;
  if (value.type === 'operation')
    return (
      'phase' in value &&
      ['command_start', 'command_end', 'tool_call_start', 'tool_call_end'].includes(
        String(value.phase),
      ) &&
      'label' in value &&
      typeof value.label === 'string' &&
      value.label.length > 0 &&
      value.label.length <= 1_000 &&
      (!('sideEffect' in value) ||
        value.sideEffect === undefined ||
        typeof value.sideEffect === 'boolean')
    );
  if (value.type === 'reasoning')
    return (
      'text' in value &&
      typeof value.text === 'string' &&
      value.text.length > 0 &&
      value.text.length <= 16_384
    );
  // Constrained to a UUID shape rather than any string: this value is interpolated into a
  // filesystem path by Main, so it must not be able to carry separators or traversal segments.
  if (value.type === 'thread')
    return (
      'threadId' in value &&
      typeof value.threadId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.threadId)
    );
  return (
    value.type === 'delta' &&
    'messageId' in value &&
    typeof value.messageId === 'string' &&
    value.messageId.length > 0 &&
    'delta' in value &&
    typeof value.delta === 'string' &&
    value.delta.length > 0 &&
    value.delta.length <= 16_384
  );
}

function hasValidBase(value: unknown): value is EnvelopeBase & { type: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'protocolVersion' in value &&
    value.protocolVersion === RUNTIME_PROTOCOL_VERSION &&
    'runtimeInstanceId' in value &&
    typeof value.runtimeInstanceId === 'string' &&
    value.runtimeInstanceId.length > 0 &&
    'taskId' in value &&
    typeof value.taskId === 'string' &&
    'turnId' in value &&
    typeof value.turnId === 'string' &&
    'seq' in value &&
    typeof value.seq === 'number' &&
    Number.isInteger(value.seq) &&
    value.seq > 0 &&
    'operationId' in value &&
    typeof value.operationId === 'string' &&
    value.operationId.length > 0 &&
    'type' in value &&
    typeof value.type === 'string'
  );
}
