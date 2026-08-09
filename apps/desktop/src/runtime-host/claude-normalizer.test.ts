import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeAuthenticationError,
  ClaudeCapabilityViolationError,
  ClaudeJsonlNormalizer,
  ClaudeOutputError,
  ClaudeRateLimitError,
} from './claude-normalizer';

describe('ClaudeJsonlNormalizer', () => {
  it('converts Claude stream-json JSONL into canonical events without exposing provider payloads', () => {
    const fixture = readFileSync(join(__dirname, 'fixtures/claude-normal.jsonl'), 'utf8');
    const normalizer = new ClaudeJsonlNormalizer();
    const events = fixture
      .trim()
      .split('\n')
      .flatMap((line) => normalizer.push(line));

    expect(events.map((event) => (event.type === 'stage' ? event.stage : event.type))).toEqual([
      'understanding',
      'planning',
      'executing',
      'synthesizing',
      'delta',
      'delta',
      'completed',
    ]);
    const deltas = events.filter((event) => event.type === 'delta');
    expect(deltas.map((event) => (event.type === 'delta' ? event.delta : ''))).toEqual([
      'Canonical ',
      'answer.',
    ]);
    // All deltas share one messageId (a single streamed assistant message).
    expect(
      new Set(deltas.map((event) => (event.type === 'delta' ? event.messageId : ''))).size,
    ).toBe(1);
    expect(JSON.stringify(events)).not.toContain('input_tokens');
    expect(JSON.stringify(events)).not.toContain('session_id');
    // The fixture's system/init event carries "model":"claude-sonnet-5" — captured and surfaced
    // on the terminal completed event (see the ADR amendment).
    expect(events.at(-1)).toEqual({ type: 'completed', resolvedModel: 'claude-sonnet-5' });
  });

  it('maps a Claude result failure (is_error) to a thrown output error, not a silent completion', () => {
    const fixture = readFileSync(join(__dirname, 'fixtures/claude-error.jsonl'), 'utf8');
    const normalizer = new ClaudeJsonlNormalizer();
    const lines = fixture.trim().split('\n');
    expect(() => {
      for (const line of lines) normalizer.push(line);
    }).toThrow(ClaudeOutputError);
  });

  it('identifies a Claude CLI login failure', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    expect(() =>
      normalizer.push(
        JSON.stringify({
          type: 'result',
          is_error: true,
          result: 'Not logged in · Please run /login',
        }),
      ),
    ).toThrow(ClaudeAuthenticationError);
  });

  it('classifies a rejected weekly limit and keeps its reset timestamp', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    normalizer.push(
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1_785_690_000 },
      }),
    );

    let caught: unknown;
    try {
      normalizer.push(
        JSON.stringify({
          type: 'result',
          is_error: true,
          api_error_status: 429,
          result: "You've hit your weekly limit · resets Aug 3 at 2am (Asia/Tokyo)",
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ClaudeRateLimitError);
    expect((caught as ClaudeRateLimitError).resetAtEpochSeconds).toBe(1_785_690_000);
  });

  it('throws on unparsable JSONL instead of silently dropping the line', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    expect(() => normalizer.push('not json')).toThrow(ClaudeOutputError);
  });

  it('throws on a structurally invalid event (missing type)', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    expect(() => normalizer.push('{"foo":"bar"}')).toThrow(ClaudeOutputError);
  });

  it('ignores unrecognized-but-well-formed event types (forward compatibility)', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    expect(normalizer.push('{"type":"rate_limit_event","status":"allowed"}')).toEqual([]);
    expect(normalizer.push('{"type":"system","subtype":"post_turn_summary"}')).toEqual([]);
  });

  it('accepts the exact read-only tools reported by the real Claude CLI', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    expect(() =>
      normalizer.push(
        '{"type":"system","subtype":"init","tools":["Glob","Grep","Read"],"mcp_servers":[]}',
      ),
    ).not.toThrow();
  });

  it('treats a tool outside the expected read-only profile as a fatal profile violation', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    expect(() =>
      normalizer.push('{"type":"system","subtype":"init","tools":["Bash"],"mcp_servers":[]}'),
    ).toThrow(ClaudeCapabilityViolationError);
  });

  it('treats a non-empty mcp_servers report as a fatal profile violation', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    expect(() =>
      normalizer.push(
        '{"type":"system","subtype":"init","tools":["Glob","Grep","Read"],"mcp_servers":[{"name":"x"}]}',
      ),
    ).toThrow(ClaudeCapabilityViolationError);
  });

  it('accepts the exact read-only plus Team MCP capability surface', () => {
    const teamTools = [
      'mcp__team__team_list_models',
      'mcp__team__team_hire_worker',
      'mcp__team__team_assign_task',
      'mcp__team__team_steer_execution',
      'mcp__team__team_cancel_execution',
      'mcp__team__team_get_status',
      'mcp__team__team_wait_events',
      'mcp__team__team_send_to_worker',
      'mcp__team__team_send_message',
      'mcp__team__team_read_messages',
      'mcp__team__team_wait_reports',
      'mcp__team__team_stop_worker',
    ];
    const normalizer = new ClaudeJsonlNormalizer({
      builtInTools: ['Read', 'Glob', 'Grep'],
      teamMcp: { serverName: 'team', toolNames: teamTools },
    });
    expect(() =>
      normalizer.push(
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          tools: ['Glob', 'Grep', 'Read', ...teamTools],
          mcp_servers: [{ name: 'team', status: 'connected' }],
        }),
      ),
    ).not.toThrow();
  });

  it('accepts the real Claude CLI Team MCP initialization while the configured server is pending', () => {
    const normalizer = new ClaudeJsonlNormalizer({
      builtInTools: ['Read', 'Glob', 'Grep'],
      teamMcp: {
        serverName: 'team',
        toolNames: [
          'mcp__team__team_list_models',
          'mcp__team__team_hire_worker',
          'mcp__team__team_assign_task',
          'mcp__team__team_steer_execution',
          'mcp__team__team_cancel_execution',
          'mcp__team__team_get_status',
          'mcp__team__team_wait_events',
          'mcp__team__team_send_to_worker',
          'mcp__team__team_send_message',
          'mcp__team__team_read_messages',
          'mcp__team__team_wait_reports',
          'mcp__team__team_stop_worker',
        ],
      },
    });
    expect(() =>
      normalizer.push(
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          tools: ['Glob', 'Grep', 'Read'],
          mcp_servers: [{ name: 'team', status: 'pending' }],
        }),
      ),
    ).not.toThrow();
  });

  it('rejects an extra MCP tool even when the full built-in profile is allowed', () => {
    const normalizer = new ClaudeJsonlNormalizer({
      builtInTools: 'default',
      teamMcp: {
        serverName: 'team',
        toolNames: ['mcp__team__team_hire_worker'],
      },
    });
    expect(() =>
      normalizer.push(
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          tools: ['Read', 'Bash', 'mcp__team__team_hire_worker', 'mcp__team__unexpected'],
          mcp_servers: [{ name: 'team', status: 'connected' }],
        }),
      ),
    ).toThrow(ClaudeCapabilityViolationError);
  });

  it('ignores non-text-delta stream_event payloads', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    expect(normalizer.push('{"type":"stream_event","event":{"type":"message_start"}}')).toEqual([]);
    expect(
      normalizer.push(
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}}',
      ),
    ).toEqual([]);
  });

  it('does not emit a second completed event for a duplicate result', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    normalizer.push(
      '{"type":"system","subtype":"init","tools":["Glob","Grep","Read"],"mcp_servers":[]}',
    );
    const first = normalizer.push('{"type":"result","is_error":false,"result":"ok"}');
    expect(first.at(-1)).toEqual({ type: 'completed' });
    const second = normalizer.push('{"type":"result","is_error":false,"result":"ok"}');
    expect(second).toEqual([]);
  });
});

// issue #17: thinking text was being dropped. `--include-partial-messages` was already on the argv,
// so this was purely a normalizer gap — verified against Claude CLI 2.1.218 that `--effort max` on a
// demanding prompt does emit `content_block_start type='thinking'` followed by `thinking_delta`.
describe('ClaudeJsonlNormalizer reasoning (issue #17)', () => {
  function streamEvent(delta: Record<string, unknown>): string {
    return JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta },
    });
  }

  it('emits reasoning for a thinking_delta', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    expect(
      normalizer.push(streamEvent({ type: 'thinking_delta', thinking: '考えています' })),
    ).toEqual([{ type: 'reasoning', text: '考えています' }]);
  });

  it('does not advance the stage on reasoning', () => {
    // Reasoning arrives during understanding/planning. Treating it as synthesis would jump the Run
    // Card's stage the moment the model starts thinking, before it has done anything.
    const normalizer = new ClaudeJsonlNormalizer();
    const events = normalizer.push(streamEvent({ type: 'thinking_delta', thinking: 'x' }));
    expect(events.some((event) => event.type === 'stage')).toBe(false);
  });

  it('drops signature_delta and input_json_delta explicitly', () => {
    // Both are real deltas that carry nothing displayable; a signature in particular must never be
    // shown as if it were the model's reasoning.
    const normalizer = new ClaudeJsonlNormalizer();
    expect(normalizer.push(streamEvent({ type: 'signature_delta', signature: 'abc' }))).toEqual([]);
    expect(
      normalizer.push(streamEvent({ type: 'input_json_delta', partial_json: '{"a":' })),
    ).toEqual([]);
  });

  it('ignores an empty or absent thinking payload', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    expect(normalizer.push(streamEvent({ type: 'thinking_delta', thinking: '' }))).toEqual([]);
    expect(normalizer.push(streamEvent({ type: 'thinking_delta' }))).toEqual([]);
  });

  it('still streams the answer text after reasoning', () => {
    // The two block types interleave across one turn; reasoning must not swallow the answer.
    const normalizer = new ClaudeJsonlNormalizer();
    normalizer.push(streamEvent({ type: 'thinking_delta', thinking: '考え中' }));
    const answer = normalizer.push(streamEvent({ type: 'text_delta', text: '答え' }));
    expect(answer.some((event) => event.type === 'delta')).toBe(true);
  });
});

describe('file writes (issue #37)', () => {
  const toolUse = (id: string, name: string, filePath: string): string =>
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input: { file_path: filePath } }],
      },
    });
  const toolResult = (id: string, content: string, isError = false): string =>
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) },
        ],
      },
    });

  it('reports a write only after its tool_result confirms it', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    // The intent alone proves nothing: under the ask preset the CLI denies every one of these, and
    // the denial arrives as the tool_result. Emitting on the intent would report edits that a
    // read-only Turn never made.
    expect(normalizer.push(toolUse('t1', 'Edit', '/ws/a.ts'))).toContainEqual({
      type: 'operation',
      phase: 'tool_call_start',
      label: 'Claude tool call started (Edit)',
      sideEffect: true,
    });
    expect(normalizer.push(toolResult('t1', 'The file has been updated.'))).toContainEqual({
      type: 'fileChange',
      changes: [{ path: '/ws/a.ts', kind: 'update' }],
    });
  });

  it('does not report a write whose tool_result is an error', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    normalizer.push(toolUse('t1', 'Write', '/ws/a.ts'));
    expect(
      normalizer.push(
        toolResult(
          't1',
          "Claude requested permissions to write, but you haven't granted it yet.",
          true,
        ),
      ),
    ).toEqual([]);
  });

  it('distinguishes a created file from a replaced one using the CLI’s own wording', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    normalizer.push(toolUse('t1', 'Write', '/ws/new.ts'));
    expect(
      normalizer.push(toolResult('t1', 'File created successfully at: /ws/new.ts')),
    ).toContainEqual({
      type: 'fileChange',
      changes: [{ path: '/ws/new.ts', kind: 'add' }],
    });
    // Without that wording it stays `update`, which claims less: that the file now differs, not
    // that this Turn brought it into existence.
    normalizer.push(toolUse('t2', 'Write', '/ws/old.ts'));
    expect(normalizer.push(toolResult('t2', 'Wrote 3 lines.'))).toContainEqual({
      type: 'fileChange',
      changes: [{ path: '/ws/old.ts', kind: 'update' }],
    });
  });

  it('ignores tools that do not write and results with no matching intent', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    expect(normalizer.push(toolUse('t1', 'Read', '/ws/a.ts'))).toContainEqual({
      type: 'operation',
      phase: 'tool_call_start',
      label: 'Claude tool call started (Read)',
      sideEffect: false,
    });
    expect(normalizer.push(toolResult('t1', '1\tcontents'))).toEqual([]);
    expect(normalizer.push(toolResult('unknown', 'done'))).toEqual([]);
  });

  it('surfaces Team MCP tool use so a failed attempt is not retried after side effects', () => {
    const normalizer = new ClaudeJsonlNormalizer();

    expect(normalizer.push(toolUse('t1', 'mcp__team__team_hire', '/unused'))).toContainEqual({
      type: 'operation',
      phase: 'tool_call_start',
      label: 'Claude tool call started (mcp__team__team_hire)',
      sideEffect: true,
    });
  });
});

describe('live file bodies (issue #39)', () => {
  const start = (index: number, name: string, id = 'toolu_1'): string =>
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name } },
    });
  const fragment = (index: number, partial_json: string): string =>
    JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json },
      },
    });

  it('streams the file body as the arguments arrive, once the path is known', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    normalizer.push(start(2, 'Write'));
    // Nothing until the path is closed: a half-typed path names a different file than the one being
    // written, and the view is labelled with it.
    expect(normalizer.push(fragment(2, '{"file_path": "/ws/a'))).toEqual([]);
    expect(normalizer.push(fragment(2, '.ts", "content": "const'))).toContainEqual({
      type: 'fileEdit',
      path: '/ws/a.ts',
      text: 'const',
      complete: false,
    });
    expect(normalizer.push(fragment(2, ' a = 1;'))).toContainEqual({
      type: 'fileEdit',
      path: '/ws/a.ts',
      text: 'const a = 1;',
      complete: false,
    });
    expect(normalizer.push(fragment(2, '"}'))).toContainEqual({
      type: 'fileEdit',
      path: '/ws/a.ts',
      text: 'const a = 1;',
      complete: true,
    });
  });

  it('reads new_string for an Edit, which is what that tool is producing for the file', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    normalizer.push(start(0, 'Edit'));
    expect(
      normalizer.push(
        fragment(0, '{"file_path": "/ws/a.ts", "old_string": "1", "new_string": "2"}'),
      ),
    ).toContainEqual({ type: 'fileEdit', path: '/ws/a.ts', text: '2', complete: true });
  });

  it('ignores tool blocks that do not write a file', () => {
    // A Read's arguments stream too. Showing a path being typed as though it were a file being
    // written would misdescribe what the model is doing.
    const normalizer = new ClaudeJsonlNormalizer();
    normalizer.push(start(0, 'Read'));
    expect(normalizer.push(fragment(0, '{"file_path": "/ws/a.ts"}'))).toEqual([]);
  });

  it('emits nothing for a fragment that ends mid-escape, then emits once it resolves', () => {
    // A lone trailing backslash could still become \\n or \\\\; decoding it early and correcting it on
    // the next fragment would make the live view flicker between wrong and right.
    const normalizer = new ClaudeJsonlNormalizer();
    normalizer.push(start(0, 'Write'));
    normalizer.push(fragment(0, '{"file_path": "/ws/a.ts", "content": "a'));
    expect(normalizer.push(fragment(0, '\\'))).toEqual([]);
    expect(normalizer.push(fragment(0, 'n'))).toContainEqual({
      type: 'fileEdit',
      path: '/ws/a.ts',
      text: 'a\n',
      complete: false,
    });
  });

  it('stops tracking a block once it closes, so a later index reuse cannot resume it', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    normalizer.push(start(0, 'Write'));
    normalizer.push(fragment(0, '{"file_path": "/ws/a.ts", "content": "x"}'));
    normalizer.push(
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
    );
    expect(normalizer.push(fragment(0, 'ignored'))).toEqual([]);
  });
});
