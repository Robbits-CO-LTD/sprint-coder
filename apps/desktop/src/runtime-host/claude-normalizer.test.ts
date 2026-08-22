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
  it('classifies an expired OAuth session as authentication required', () => {
    const normalizer = new ClaudeJsonlNormalizer({ builtInTools: [] });
    expect(() =>
      normalizer.push(
        JSON.stringify({
          type: 'result',
          is_error: true,
          result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        }),
      ),
    ).toThrow(ClaudeAuthenticationError);
  });

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

  it('accepts the exact empty native tool set reported by the managed Claude profile', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    expect(() =>
      normalizer.push('{"type":"system","subtype":"init","tools":[],"mcp_servers":[]}'),
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
      normalizer.push('{"type":"system","subtype":"init","tools":[],"mcp_servers":[{"name":"x"}]}'),
    ).toThrow(ClaudeCapabilityViolationError);
  });

  it('accepts the exact managed Team MCP capability surface', () => {
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
      builtInTools: [],
      teamMcp: { serverName: 'team', toolNames: teamTools },
    });
    expect(() =>
      normalizer.push(
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          tools: [...teamTools],
          mcp_servers: [{ name: 'team', status: 'connected' }],
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    ['memory', ['mcp__team__project_memory_remember']],
    ['skill creator', ['mcp__team__skill_draft_create']],
  ])('accepts the exact %s MCP subset', (_kind, toolNames) => {
    const normalizer = new ClaudeJsonlNormalizer({
      builtInTools: [],
      teamMcp: { serverName: 'team', toolNames },
    });
    expect(() =>
      normalizer.push(
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          tools: [...toolNames],
          mcp_servers: [{ name: 'team', status: 'connected' }],
        }),
      ),
    ).not.toThrow();
  });

  it('reports bounded missing and unexpected tool differences on exact-match failure', () => {
    const expected = ['mcp__team__team_hire_worker'];
    const normalizer = new ClaudeJsonlNormalizer({
      builtInTools: [],
      teamMcp: { serverName: 'team', toolNames: expected },
    });
    try {
      normalizer.push(
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          tools: ['mcp__team__skill_draft_create'],
          mcp_servers: [{ name: 'team', status: 'connected' }],
        }),
      );
      throw new Error('expected capability violation');
    } catch (error) {
      expect(error).toBeInstanceOf(ClaudeCapabilityViolationError);
      expect(error).toMatchObject({
        missingTools: expected,
        unexpectedTools: ['mcp__team__skill_draft_create'],
      });
    }
  });

  it('accepts the real Claude CLI Team MCP initialization while the configured server is pending', () => {
    const normalizer = new ClaudeJsonlNormalizer({
      builtInTools: [],
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
          tools: [],
          mcp_servers: [{ name: 'team', status: 'pending' }],
        }),
      ),
    ).not.toThrow();
  });

  it('rejects an extra MCP tool with the native tool profile empty', () => {
    const normalizer = new ClaudeJsonlNormalizer({
      builtInTools: [],
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
          tools: ['mcp__team__team_hire_worker', 'mcp__team__unexpected'],
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
    normalizer.push('{"type":"system","subtype":"init","tools":[],"mcp_servers":[]}');
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

describe('managed MCP tool calls', () => {
  it('surfaces the call as an operation but never derives file changes from Claude output', () => {
    const normalizer = new ClaudeJsonlNormalizer();
    const toolUse = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'mcp__team__apply_patch',
            input: { path: '/outside/untrusted.ts' },
          },
        ],
      },
    });
    expect(normalizer.push(toolUse)).toContainEqual({
      type: 'operation',
      phase: 'tool_call_start',
      label: 'Claude tool call started (mcp__team__apply_patch)',
      sideEffect: true,
    });
    expect(
      normalizer.push(
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'File created successfully' },
            ],
          },
        }),
      ),
    ).toEqual([]);
  });
});
