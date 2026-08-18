import { randomUUID } from 'node:crypto';
import { readPartialJsonString } from './partial-json-string';
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

// What the CLI's own session-init report is allowed to show. The built-in set is exact for the
// read-only/workspace-write profiles and intentionally open for Claude's `--tools default` full
// profile. Team turns add one exact MCP server/tool surface to that built-in set.
export type ClaudeExpectedCapabilities = Readonly<{
  builtInTools: readonly string[] | 'default';
  teamMcp?: Readonly<{ serverName: string; toolNames: readonly string[] }>;
}>;

const READ_ONLY_CAPABILITIES: ClaudeExpectedCapabilities = {
  builtInTools: ['Read', 'Glob', 'Grep'],
};

/** A single tool call's arguments past this size are not a file body worth streaming (issue #39). */
const MAX_TOOL_ARGUMENT_BYTES = 1_048_576;

/** Built-in tools that write a file and report its path as `file_path` (issue #37). */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

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
  // tool_use_id -> the write it intends, held until its tool_result says whether it happened
  // (issue #37). Bounded at 200 entries so a runaway turn cannot grow this without limit.
  private readonly pendingWrites = new Map<string, { path: string; tool: string }>();
  // Live file bodies being streamed, keyed by content-block index (issue #39). Bounded at 8
  // concurrent blocks and at MAX_TOOL_ARGUMENT_BYTES each, so a runaway tool call cannot grow the
  // runtime host's memory without limit.
  private readonly editBlocks = new Map<
    number,
    { tool: string; buffer: string; path: string | null; sent: number; closed: boolean }
  >();

  constructor(private readonly expected: ClaudeExpectedCapabilities = READ_ONLY_CAPABILITIES) {}

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
    if (type === 'assistant') return this.rememberToolUse(value);
    if (type === 'user') return this.confirmWrites(value);
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
    if (event['type'] === 'content_block_start') return this.startBlock(event);
    if (event['type'] === 'content_block_stop') {
      this.editBlocks.delete(readNumber(event, 'index') ?? -1);
      return [];
    }
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
    // The file body as the model types it (issue #39). This used to be dropped as "tool arguments
    // carrying nothing displayable" — which was wrong: for Write and Edit these fragments ARE the
    // file's contents, arriving at generation speed.
    if (delta['type'] === 'input_json_delta') return this.pushToolArguments(event, delta);
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
   * Starts tracking a tool_use block whose arguments will carry a file body (issue #39).
   *
   * Keyed by the block index rather than the tool_use id, because that is what the deltas carry.
   * Only the writing tools are tracked: a Read's arguments stream too, and showing a path being
   * typed as though it were a file being written would be a lie about what is happening.
   */
  private startBlock(event: Record<string, unknown>): RuntimeCanonicalEvent[] {
    const block = isRecord(event['content_block']) ? event['content_block'] : null;
    const index = readNumber(event, 'index');
    if (block === null || index === null || block['type'] !== 'tool_use') return [];
    const name = readString(block, 'name');
    if (name === null || !WRITE_TOOLS.has(name)) return [];
    if (this.editBlocks.size >= 8) return [];
    this.editBlocks.set(index, { tool: name, buffer: '', path: null, sent: -1, closed: false });
    return [];
  }

  /**
   * Accumulates a tool call's argument fragments and emits the file body decoded so far.
   *
   * Emits only when the decoded length actually grew: a fragment that ends mid-escape adds nothing
   * yet, and re-sending an unchanged body would cost a repaint for no new information.
   */
  private pushToolArguments(
    event: Record<string, unknown>,
    delta: Record<string, unknown>,
  ): RuntimeCanonicalEvent[] {
    const index = readNumber(event, 'index');
    const block = index === null ? undefined : this.editBlocks.get(index);
    if (block === undefined) return [];
    const fragment = readString(delta, 'partial_json');
    if (fragment === null) return [];
    if (block.buffer.length + fragment.length > MAX_TOOL_ARGUMENT_BYTES) return [];
    block.buffer += fragment;

    if (block.path === null) {
      const path = readPartialJsonString(block.buffer, 'file_path');
      // Only once closed: a half-typed path would name a different file than the one being written.
      if (path === null || !path.complete) return [];
      block.path = path.value;
    }
    // Write carries the whole file; Edit carries only the replacement. Both are what the model is
    // producing for that file right now, which is what the view is showing.
    const body = readPartialJsonString(
      block.buffer,
      block.tool === 'Write' ? 'content' : 'new_string',
    );
    // Emit when there is new text, and also on the closing quote even if it added none: the terminal
    // frame is what tells the view to stop following and relabel itself, so suppressing it as
    // "nothing changed" would leave the panel saying 書き込み中 forever.
    if (body === null) return [];
    const grew = body.value.length !== block.sent;
    const closing = body.complete && !block.closed;
    if (!grew && !closing) return [];
    block.sent = body.value.length;
    block.closed = body.complete;
    return [
      ...this.advanceTo('executing'),
      { type: 'fileEdit', path: block.path, text: body.value, complete: body.complete },
    ];
  }

  /**
   * Surfaces every `tool_use` as an operation and records file-writing intents by tool_use_id.
   *
   * The operation lets Main stop an unsafe provider fallback after a tool may have produced side
   * effects, including Team MCP calls. A write intent still is not a `fileChange`: Claude's
   * permission layer may refuse it, so the change is emitted only after a successful result.
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
        sideEffect: WRITE_TOOLS.has(name) || name.startsWith('mcp__team__'),
      });
      if (!WRITE_TOOLS.has(name)) continue;
      const input = isRecord(block['input']) ? block['input'] : null;
      const path = input === null ? null : readString(input, 'file_path');
      if (path === null || path.length === 0 || path.length > 4096) continue;
      if (this.pendingWrites.size >= 200) continue;
      this.pendingWrites.set(id, { path, tool: name });
    }
    return operations.length === 0 ? [] : [...this.advanceTo('executing'), ...operations];
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
