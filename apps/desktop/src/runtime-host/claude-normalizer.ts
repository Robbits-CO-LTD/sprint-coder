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

/** Built-in tools that write a file and report its path as `file_path` (issue #37). */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export class ClaudeJsonlNormalizer {
  private stageIndex = -1;
  private readonly messageId = randomUUID();
  private completed = false;
  // Captured from the session-init report's own `model` field (e.g. "claude-sonnet-5") — the
  // concrete model id the CLI actually resolved for this turn's `auto`/alias selection. Surfaced
  // on the terminal `completed` event so Main can show it in the UI (see the ADR amendment).
  private resolvedModel: string | undefined;
  // tool_use_id -> the write it intends, held until its tool_result says whether it happened
  // (issue #37). Bounded at 200 entries so a runaway turn cannot grow this without limit.
  private readonly pendingWrites = new Map<string, { path: string; tool: string }>();

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
    // Write intents and their outcomes arrive on the full assistant/user messages, not on the
    // partial-message deltas: `input_json_delta` carries tool arguments a fragment at a time and is
    // useless until complete.
    if (type === 'assistant') return this.rememberWriteIntents(value);
    if (type === 'user') return this.confirmWrites(value);
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
    // `signature_delta` (the thinking block's cryptographic signature) and `input_json_delta` (tool
    // arguments) are dropped explicitly rather than by falling through: both are real deltas that
    // carry nothing displayable, and a future reader should see that they were considered.
    if (delta['type'] !== 'text_delta') return [];

    const text = readString(delta, 'text');
    if (text === null || text.length === 0) return [];
    return [
      ...this.advanceTo('synthesizing'),
      { type: 'delta', messageId: this.messageId, delta: text },
    ];
  }

  /**
   * Records a `tool_use` for a file-writing tool, keyed by its tool_use_id.
   *
   * Nothing is emitted here. A tool_use is an intent, and Claude's own permission layer can still
   * refuse it — under the `ask` preset every one of them is denied (verified: the denial comes back
   * as a `tool_result` and is listed in `permission_denials` on the result). Reporting the intent as
   * an edit would tell the user a file changed when it did not.
   */
  private rememberWriteIntents(value: Record<string, unknown>): RuntimeCanonicalEvent[] {
    const message = isRecord(value['message']) ? value['message'] : null;
    const content = message === null ? null : message['content'];
    if (!Array.isArray(content)) return [];
    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'tool_use') continue;
      const name = readString(block, 'name');
      const id = readString(block, 'id');
      if (name === null || id === null || !WRITE_TOOLS.has(name)) continue;
      const input = isRecord(block['input']) ? block['input'] : null;
      const path = input === null ? null : readString(input, 'file_path');
      if (path === null || path.length === 0 || path.length > 4096) continue;
      if (this.pendingWrites.size >= 200) continue;
      this.pendingWrites.set(id, { path, tool: name });
    }
    return [];
  }

  /**
   * Turns a successful `tool_result` for a remembered write into a canonical fileChange.
   *
   * `Write` alone cannot say whether it created or replaced the file, so the distinction is read
   * out of the CLI's own result text ("File created successfully at:") and defaults to `update`
   * when it is not there — an overstated `add` would be a claim about the file's history, whereas
   * `update` only claims the file now differs.
   *
   * A file removed by a shell command is invisible here on purpose: there is no delete tool in this
   * tool set, and inferring deletions from Bash argv would mean parsing shell, which §Tool Broker
   * rules out as a boundary.
   */
  private confirmWrites(value: Record<string, unknown>): RuntimeCanonicalEvent[] {
    const message = isRecord(value['message']) ? value['message'] : null;
    const content = message === null ? null : message['content'];
    if (!Array.isArray(content)) return [];
    const changes: { path: string; kind: 'add' | 'update' | 'delete' }[] = [];
    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'tool_result') continue;
      const id = readString(block, 'tool_use_id');
      if (id === null) continue;
      const pending = this.pendingWrites.get(id);
      if (pending === undefined) continue;
      this.pendingWrites.delete(id);
      if (block['is_error'] === true) continue;
      const text = typeof block['content'] === 'string' ? block['content'] : '';
      changes.push({
        path: pending.path,
        kind: pending.tool === 'Write' && text.includes('created') ? 'add' : 'update',
      });
    }
    return changes.length === 0
      ? []
      : [...this.advanceTo('executing'), { type: 'fileChange', changes }];
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
