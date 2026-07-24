import { randomUUID } from 'node:crypto';
import type { TurnStage } from '@sprint-coder/contracts';
import type { RuntimeCanonicalEvent } from './protocol';

const stages: TurnStage[] = ['understanding', 'planning', 'executing', 'synthesizing'];

export class ClaudeOutputError extends Error {}
// Defense in depth: the fixed --tools ""/--strict-mcp-config invocation profile (buildClaudeArgs)
// should make this structurally impossible, but the normalizer independently verifies the CLI's
// own reported capabilities before trusting anything else in the stream, mirroring how the Codex
// normalizer treats an unexpected approval request as a fatal profile violation.
export class ClaudeCapabilityViolationError extends Error {}

// What the CLI's own session-init report is allowed to show. Defaults to the plain no-tools/
// no-MCP profile every non-team turn uses; the Leader MCP profile (buildClaudeArgs' teamMcp
// branch) is the one case that legitimately reports a non-empty tool/MCP surface, so it supplies
// the exact fully-qualified tool names it expects instead.
export type ClaudeExpectedCapabilities =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'team-mcp'; serverName: string; toolNames: readonly string[] }>;

const NO_CAPABILITIES: ClaudeExpectedCapabilities = { kind: 'none' };

export class ClaudeJsonlNormalizer {
  private stageIndex = -1;
  private readonly messageId = randomUUID();
  private completed = false;
  // Captured from the session-init report's own `model` field (e.g. "claude-sonnet-5") — the
  // concrete model id the CLI actually resolved for this turn's `auto`/alias selection. Surfaced
  // on the terminal `completed` event so Main can show it in the UI (see the ADR amendment).
  private resolvedModel: string | undefined;

  constructor(private readonly expected: ClaudeExpectedCapabilities = NO_CAPABILITIES) {}

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
    if (type === 'result') return this.pushResult(value);
    // assistant (full message; superseded by the stream_event deltas we already emitted),
    // rate_limit_event, and other system subtypes (e.g. post_turn_summary) carry nothing the
    // canonical protocol needs.
    return [];
  }

  private pushStreamEvent(value: Record<string, unknown>): RuntimeCanonicalEvent[] {
    const event = isRecord(value['event']) ? value['event'] : null;
    if (event === null || event['type'] !== 'content_block_delta') return [];
    const delta = isRecord(event['delta']) ? event['delta'] : null;
    if (delta === null || delta['type'] !== 'text_delta') return [];
    const text = readString(delta, 'text');
    if (text === null || text.length === 0) return [];
    return [
      ...this.advanceTo('synthesizing'),
      { type: 'delta', messageId: this.messageId, delta: text },
    ];
  }

  private pushResult(value: Record<string, unknown>): RuntimeCanonicalEvent[] {
    if (value['is_error'] === true)
      throw new ClaudeOutputError(readString(value, 'result') ?? 'Claude reported a failed turn');
    if (this.completed) return [];
    this.completed = true;
    return [
      ...this.advanceTo('synthesizing'),
      this.resolvedModel === undefined
        ? { type: 'completed' }
        : { type: 'completed', resolvedModel: this.resolvedModel },
    ];
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
  if (expected.kind === 'none') {
    if (
      (Array.isArray(tools) && tools.length > 0) ||
      (Array.isArray(mcpServers) && mcpServers.length > 0)
    )
      throw new ClaudeCapabilityViolationError(
        'Claude session reported unexpected tool or MCP capability',
      );
    return;
  }
  const reportedTools = new Set(Array.isArray(tools) ? tools : []);
  const expectedTools = new Set(expected.toolNames);
  const toolsMatch =
    reportedTools.size === expectedTools.size &&
    [...expectedTools].every((name) => reportedTools.has(name));
  const serversMatch =
    Array.isArray(mcpServers) &&
    mcpServers.length === 1 &&
    isRecord(mcpServers[0]) &&
    mcpServers[0]['name'] === expected.serverName &&
    mcpServers[0]['status'] === 'connected';
  if (!toolsMatch || !serversMatch)
    throw new ClaudeCapabilityViolationError(
      'Claude session reported unexpected tool or MCP capability for the team MCP profile',
    );
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const item = value[key];
  return typeof item === 'string' ? item : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
