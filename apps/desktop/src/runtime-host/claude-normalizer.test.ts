import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeCapabilityViolationError,
  ClaudeJsonlNormalizer,
  ClaudeOutputError,
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

  it('treats a non-empty reported tool or MCP capability as a fatal profile violation', () => {
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
