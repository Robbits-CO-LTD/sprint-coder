import { randomUUID } from 'node:crypto';
import type { TurnStage } from '@sprint-coder/contracts';
import type { RuntimeCanonicalEvent } from './protocol';

const stages: TurnStage[] = ['understanding', 'planning', 'executing', 'synthesizing'];

export class ClaudeOutputError extends Error {}
export class ClaudeAuthenticationError extends ClaudeOutputError {}
export class ClaudeRateLimitError extends ClaudeOutputError {
  constructor(
    message: string,
    readonly resetAtEpochSeconds: number | null,
  ) {
    super(message);
  }
}
// Defense in depth: the fixed --tools ""/--strict-mcp-config invocation profile (buildClaudeArgs)
// should make this structurally impossible, but the normalizer independently verifies the CLI's
// own reported capabilities before trusting anything else in the stream, mirroring how the Codex
// normalizer treats an unexpected approval request as a fatal profile violation.
export class ClaudeCapabilityViolationError extends Error {
  constructor(
    message: string,
    readonly missingTools: readonly string[] = [],
    readonly unexpectedTools: readonly string[] = [],
  ) {
    super(message);
  }
}

// What the CLI's own session-init report is allowed to show. Native tools are always the exact
// empty set. A turn may add one exact authenticated MCP surface for Managed Harness tools.
export type ClaudeExpectedCapabilities = Readonly<{
  builtInTools: readonly string[] | 'default';
  teamMcp?: Readonly<{ serverName: string; toolNames: readonly string[] }>;
}>;

const MANAGED_CAPABILITIES: ClaudeExpectedCapabilities = {
  builtInTools: [],
};

export class ClaudeJsonlNormalizer {
  private stageIndex = -1;
  private readonly messageId = randomUUID();
  private completed = false;
  private rateLimitRejected = false;
  private rateLimitResetAtEpochSeconds: number | null = null;
  // Captured from the session-init report's own `model` field (e.g. "claude-sonnet-5") — the
  // concrete model id the CLI actually resolved for this turn's `auto`/alias selection. Surfaced
  // on the terminal `completed` event so Main can show it in the UI (see the ADR amendment).
  private resolvedModel: string | undefined;
  constructor(private readonly expected: ClaudeExpectedCapabilities = MANAGED_CAPABILITIES) {}

  push(line: string): RuntimeCanonicalEvent[] {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new ClaudeOutputError('Claude emitted unparsable JSONL output');
    }
    if (!isRecord(value) || typeof value['type'] !== 'string')
      throw new ClaudeOutputError('Claude emitted an invalid JSONL event');

    const type = value['type'];
    if (type === 'system' && readString(value, 'subtype') === 'init') {
      assertExpectedCapabilities(value, this.expected);
      const model = readString(value, 'model');
      if (model !== null) this.resolvedModel = model;
      return this.advanceTo('understanding');
    }
    if (type === 'stream_event') return this.pushStreamEvent(value);
    if (type === 'assistant') return this.rememberToolUse(value);
    if (type === 'user') return [];
    if (type === 'rate_limit_event') {
      this.rememberRateLimit(value);
      return [];
    }
    if (type === 'result') return this.pushResult(value);
    // assistant (full message; superseded by the stream_event deltas we already emitted),
    // Other system subtypes (e.g. post_turn_summary) carry nothing the canonical protocol needs.
    return [];
  }

  private pushStreamEvent(value: Record<string, unknown>): RuntimeCanonicalEvent[] {
    const event = isRecord(value['event']) ? value['event'] : null;
    if (event === null) return [];
    if (event['type'] === 'content_block_start' || event['type'] === 'content_block_stop')
      return [];
    if (event['type'] !== 'content_block_delta') return [];
    const delta = isRecord(event['delta']) ? event['delta'] : null;
    if (delta === null) return [];

    // Reasoning text (issue #17). `--include-partial-messages` is already on the argv
    // (claude-adapter.ts), so no CLI flag change was needed — this was simply being dropped.
    //
    // Deliberately does NOT advance the stage: reasoning arrives during understanding/planning, and
    // treating it as synthesis would jump the Run Card's stage the moment the model starts thinking.
    if (delta['type'] === 'thinking_delta') {
      const thinking = readString(delta, 'thinking') ?? readString(delta, 'text');
      return thinking === null || thinking.length === 0
        ? []
        : [{ type: 'reasoning', text: thinking }];
    }
    // Managed tool arguments are untrusted structured data and are never promoted into UI events.
    if (delta['type'] === 'input_json_delta') return [];
    // `signature_delta` (the thinking block's cryptographic signature) is dropped explicitly rather
    // than by falling through: it is a real delta that carries nothing displayable, and a future
    // reader should see it was considered.
    if (delta['type'] !== 'text_delta') return [];

    const text = readString(delta, 'text');
    if (text === null || text.length === 0) return [];
    return [
      ...this.advanceTo('synthesizing'),
      { type: 'delta', messageId: this.messageId, delta: text },
    ];
  }

  /**
   * Surfaces every authenticated MCP `tool_use` as an operation. File changes themselves are
   * derived only from Managed Harness post-images in Main, never from Claude's report.
   */
  private rememberToolUse(value: Record<string, unknown>): RuntimeCanonicalEvent[] {
    const message = isRecord(value['message']) ? value['message'] : null;
    const content = message === null ? null : message['content'];
    if (!Array.isArray(content)) return [];
    const operations: RuntimeCanonicalEvent[] = [];
    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'tool_use') continue;
      const name = readString(block, 'name');
      const id = readString(block, 'id');
      if (name === null || id === null) continue;
      operations.push({
        type: 'operation',
        phase: 'tool_call_start',
        label: `Claude tool call started (${name})`,
        sideEffect: name.startsWith('mcp__team__'),
      });
    }
    return operations.length === 0 ? [] : [...this.advanceTo('executing'), ...operations];
  }

  private pushResult(value: Record<string, unknown>): RuntimeCanonicalEvent[] {
    if (value['is_error'] === true) {
      const message = readString(value, 'result') ?? 'Claude reported a failed turn';
      if (
        /not logged in|authentication[_ ]failed|failed to authenticate|oauth session expired/iu.test(
          message,
        )
      )
        throw new ClaudeAuthenticationError(message);
      if (
        this.rateLimitRejected ||
        readNumber(value, 'api_error_status') === 429 ||
        /(?:rate|weekly|usage) limit|hit your .* limit/iu.test(message)
      )
        throw new ClaudeRateLimitError(message, this.rateLimitResetAtEpochSeconds);
      throw new ClaudeOutputError(message);
    }
    if (this.completed) return [];
    this.completed = true;
    return [
      ...this.advanceTo('synthesizing'),
      this.resolvedModel === undefined
        ? { type: 'completed' }
        : { type: 'completed', resolvedModel: this.resolvedModel },
    ];
  }

  private rememberRateLimit(value: Record<string, unknown>): void {
    const info = isRecord(value['rate_limit_info']) ? value['rate_limit_info'] : null;
    if (info === null || readString(info, 'status') !== 'rejected') return;
    this.rateLimitRejected = true;
    const resetsAt = readNumber(info, 'resetsAt');
    if (resetsAt !== null && resetsAt > 0) this.rateLimitResetAtEpochSeconds = resetsAt;
  }

  private advanceTo(target: TurnStage): RuntimeCanonicalEvent[] {
    const targetIndex = stages.indexOf(target);
    const events: RuntimeCanonicalEvent[] = [];
    while (this.stageIndex < targetIndex) {
      this.stageIndex += 1;
      const stage = stages[this.stageIndex];
      if (stage !== undefined) events.push({ type: 'stage', stage });
    }
    return events;
  }
}

// Verifies the CLI's own session-init report matches the expected capability surface
// (buildClaudeArgs' --tools "" --strict-mcp-config, plus --mcp-config/--allowedTools for the
// Leader MCP profile). Any mismatch here would mean the fixed argv was bypassed, the CLI version
// changed behavior, or (team-mcp) some other MCP server than the one we configured connected —
// fail the Turn rather than proceed.
function assertExpectedCapabilities(
  value: Record<string, unknown>,
  expected: ClaudeExpectedCapabilities,
): void {
  const tools = value['tools'];
  const mcpServers = value['mcp_servers'];
  if (
    !Array.isArray(tools) ||
    tools.some((tool) => typeof tool !== 'string') ||
    !Array.isArray(mcpServers)
  )
    throw new ClaudeCapabilityViolationError(
      'Claude session reported malformed tool or MCP capabilities',
    );

  const reportedTools = new Set(tools as string[]);
  const expectedMcpTools = new Set(expected.teamMcp?.toolNames ?? []);
  const reportedMcpTools = new Set([...reportedTools].filter((tool) => tool.startsWith('mcp__')));
  const reportedTeamServer =
    mcpServers.length === 1 && isRecord(mcpServers[0]) ? mcpServers[0] : null;
  const teamServerPending =
    expected.teamMcp !== undefined &&
    reportedTeamServer?.['name'] === expected.teamMcp.serverName &&
    reportedTeamServer['status'] === 'pending';
  const mcpToolsMatch = teamServerPending
    ? reportedMcpTools.size === 0
    : reportedMcpTools.size === expectedMcpTools.size &&
      [...expectedMcpTools].every((name) => reportedMcpTools.has(name));
  const expectedExactTools =
    expected.builtInTools === 'default'
      ? null
      : new Set([...expected.builtInTools, ...(teamServerPending ? [] : [...expectedMcpTools])]);
  const toolsMatch =
    mcpToolsMatch &&
    (expectedExactTools === null ||
      (reportedTools.size === expectedExactTools.size &&
        [...expectedExactTools].every((name) => reportedTools.has(name))));
  const serversMatch =
    expected.teamMcp === undefined
      ? mcpServers.length === 0
      : reportedTeamServer?.['name'] === expected.teamMcp.serverName &&
        (reportedTeamServer['status'] === 'connected' ||
          reportedTeamServer['status'] === 'pending');
  if (!toolsMatch || !serversMatch) {
    const comparisonExpected = expectedExactTools ?? expectedMcpTools;
    const comparisonReported = expectedExactTools === null ? reportedMcpTools : reportedTools;
    const missingTools = [...comparisonExpected].filter((name) => !comparisonReported.has(name));
    const unexpectedTools = [...comparisonReported].filter((name) => !comparisonExpected.has(name));
    throw new ClaudeCapabilityViolationError(
      'Claude session reported unexpected tool or MCP capability',
      missingTools,
      unexpectedTools,
    );
  }
}

function readNumber(value: Record<string, unknown>, key: string): number | null {
  const candidate = value[key];
  return typeof candidate === 'number' && Number.isInteger(candidate) ? candidate : null;
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const item = value[key];
  return typeof item === 'string' ? item : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
