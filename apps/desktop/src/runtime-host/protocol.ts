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

export const RUNTIME_PROTOCOL_VERSION = 5;

export type RuntimeContextFragment = Readonly<{
  id: string;
  source: 'system' | 'history' | 'goal' | 'compaction' | 'background';
  trust: 'system' | 'user' | 'assistant';
  authority: 'system' | 'user' | 'none';
  content: string;
}>;

/** Additive, optional per-turn addendum: when present, the Claude adapter wires the real Leader
 * up to team-mcp-bridge.ts (via an ephemeral MCP stdio server) instead of running the plain
 * no-tools profile. `socketPath`/`token` name the bridge connection; `guidance` is appended to the
 * turn's system prompt (see LEADER_MCP_SYSTEM_PROMPT in team-tools.ts). Ignored entirely by the
 * Codex adapter. */
export type RuntimeTeamMcpOption = Readonly<{
  socketPath: string;
  token: string;
  guidance: string;
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
  | { type: 'stage'; stage: TurnStage }
  | { type: 'delta'; messageId: string; delta: string }
  // `resolvedModel` is additive/optional: only the Claude adapter's normalizer ever populates it
  // (captured from the stream-json `system/init` event's `model` field — see
  // claude-normalizer.ts), giving Main a way to surface the concrete model id the CLI actually
  // resolved for an `auto`/alias selection (see the ADR amendment). Codex's normalizer never sets
  // it, so this stays undefined for Codex turns.
  | { type: 'completed'; resolvedModel?: string }
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

export type MainToRuntimeEnvelope =
  | (EnvelopeBase & { type: 'hello' })
  | (EnvelopeBase & {
      type: 'start';
      input: string;
      workspacePath: string | null;
      model: string;
      // Additive, optional: only meaningful for the Claude adapter (see buildClaudeArgs' effort
      // param) — Codex has no equivalent CLI flag on this version and its adapter ignores it.
      effort?: string;
      contextFragments: RuntimeContextFragment[];
      toolCatalogSnapshot: ToolCatalogSnapshot;
      teamMcp?: RuntimeTeamMcpOption;
    })
  | (EnvelopeBase & { type: 'cancel' });

export type RuntimeToMainEnvelope =
  | (EnvelopeBase & {
      type: 'hello';
      codexAvailable: boolean;
      codexVersion?: string;
      codexModels: CodexModelOption[];
      // Additive fields for the Claude CLI runtime (Slice 3.4). A given Runtime Host process
      // only ever hosts one adapter kind, so exactly one provider's fields are meaningful per
      // process; the other provider's boolean/array still round-trip validation with its
      // always-supplied default (false/[]) rather than being made structurally optional, which
      // keeps existing `codexAvailable`/`codexModels` consumers unchanged.
      claudeAvailable: boolean;
      claudeVersion?: string;
      claudeModels: CodexModelOption[];
    })
  | (EnvelopeBase & { type: 'started'; acceptedContextFragmentIds: string[] })
  | (EnvelopeBase & { type: 'event'; event: RuntimeCanonicalEvent })
  | (EnvelopeBase & { type: 'exit'; code: number; canceled: boolean })
  | (EnvelopeBase & { type: 'error'; error: PublicError });

export function isMainToRuntimeEnvelope(value: unknown): value is MainToRuntimeEnvelope {
  if (!hasValidBase(value)) return false;
  if (value.type === 'hello' || value.type === 'cancel') return true;
  return (
    value.type === 'start' &&
    'input' in value &&
    typeof value.input === 'string' &&
    'workspacePath' in value &&
    (value.workspacePath === null || typeof value.workspacePath === 'string') &&
    'model' in value &&
    codexModelIdSchema.safeParse(value.model).success &&
    (!('effort' in value) ||
      value.effort === undefined ||
      claudeEffortSchema.safeParse(value.effort).success) &&
    'contextFragments' in value &&
    isRuntimeContextFragments(value.contextFragments) &&
    'toolCatalogSnapshot' in value &&
    isVerifiedReadOnlyCatalog(value.toolCatalogSnapshot) &&
    (!('teamMcp' in value) || value.teamMcp === undefined || isRuntimeTeamMcpOption(value.teamMcp))
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
    record['guidance'].length <= 20_000
  );
}

function isRuntimeContextFragments(value: unknown): value is RuntimeContextFragment[] {
  if (!Array.isArray(value) || value.length > 256) return false;
  let totalCharacters = 0;
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
      !['system', 'history', 'goal', 'compaction', 'background'].includes(
        record['source'] as string,
      ) ||
      !['system', 'user', 'assistant'].includes(record['trust'] as string) ||
      !['system', 'user', 'none'].includes(record['authority'] as string) ||
      !hasValidFragmentAuthority(record) ||
      typeof record['content'] !== 'string' ||
      record['content'].length > 40_000
    )
      return false;
    ids.add(record['id']);
    totalCharacters += record['content'].length;
    if (totalCharacters > 128_000) return false;
  }
  return true;
}

function hasValidFragmentAuthority(fragment: Record<string, unknown>): boolean {
  if (fragment['source'] === 'system') return fragment['authority'] === 'system';
  if (fragment['source'] === 'goal') return fragment['authority'] === 'user';
  if (fragment['source'] === 'history')
    return fragment['authority'] === (fragment['trust'] === 'user' ? 'user' : 'none');
  return fragment['authority'] === 'none';
}

function isVerifiedReadOnlyCatalog(value: unknown): value is ToolCatalogSnapshot {
  const parsed = toolCatalogSnapshotSchema.safeParse(value);
  return (
    parsed.success &&
    parsed.data.entries.length === 0 &&
    verifyToolCatalogSnapshot(parsed.data as unknown as ToolCatalogSnapshot)
  );
}

export function isRuntimeToMainEnvelope(value: unknown): value is RuntimeToMainEnvelope {
  if (!hasValidBase(value)) return false;
  if (value.type === 'hello')
    return (
      'codexAvailable' in value &&
      typeof value.codexAvailable === 'boolean' &&
      (!('codexVersion' in value) || typeof value.codexVersion === 'string') &&
      'codexModels' in value &&
      Array.isArray(value.codexModels) &&
      value.codexModels.length <= 32 &&
      value.codexModels.every((model) => codexModelOptionSchema.safeParse(model).success) &&
      'claudeAvailable' in value &&
      typeof value.claudeAvailable === 'boolean' &&
      (!('claudeVersion' in value) || typeof value.claudeVersion === 'string') &&
      'claudeModels' in value &&
      Array.isArray(value.claudeModels) &&
      value.claudeModels.length <= 32 &&
      value.claudeModels.every((model) => codexModelOptionSchema.safeParse(model).success)
    );
  if (value.type === 'started')
    return (
      'acceptedContextFragmentIds' in value &&
      Array.isArray(value.acceptedContextFragmentIds) &&
      value.acceptedContextFragmentIds.length <= 256 &&
      new Set(value.acceptedContextFragmentIds).size === value.acceptedContextFragmentIds.length &&
      value.acceptedContextFragmentIds.every(
        (id) => typeof id === 'string' && id.length > 0 && id.length <= 128,
      )
    );
  if (value.type === 'event') return 'event' in value && isRuntimeCanonicalEvent(value.event);
  if (value.type === 'exit')
    return (
      'code' in value &&
      typeof value.code === 'number' &&
      Number.isInteger(value.code) &&
      'canceled' in value &&
      typeof value.canceled === 'boolean'
    );
  return (
    value.type === 'error' && 'error' in value && publicErrorSchema.safeParse(value.error).success
  );
}

function isRuntimeCanonicalEvent(value: unknown): value is RuntimeCanonicalEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  if (value.type === 'completed')
    return (
      !('resolvedModel' in value) ||
      value.resolvedModel === undefined ||
      (typeof value.resolvedModel === 'string' &&
        value.resolvedModel.length > 0 &&
        value.resolvedModel.length <= 128)
    );
  if (value.type === 'stage')
    return 'stage' in value && turnStageSchema.safeParse(value.stage).success;
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
