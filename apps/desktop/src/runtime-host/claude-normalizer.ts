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

export class ClaudeJsonlNormalizer {
  private stageIndex = -1;
  private readonly messageId = randomUUID();
  private completed = false;

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
      assertReadOnlyCapabilities(value);
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
    return [...this.advanceTo('synthesizing'), { type: 'completed' }];
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

// Verifies the CLI's own session-init report matches the immutable no-tools/no-MCP profile
// (buildClaudeArgs' --tools "" --strict-mcp-config). A non-empty list here would mean the fixed
// argv was bypassed or the CLI version changed behavior — fail the Turn rather than proceed.
function assertReadOnlyCapabilities(value: Record<string, unknown>): void {
  const tools = value['tools'];
  const mcpServers = value['mcp_servers'];
  if (
    (Array.isArray(tools) && tools.length > 0) ||
    (Array.isArray(mcpServers) && mcpServers.length > 0)
  )
    throw new ClaudeCapabilityViolationError(
      'Claude session reported unexpected tool or MCP capability',
    );
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const item = value[key];
  return typeof item === 'string' ? item : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
