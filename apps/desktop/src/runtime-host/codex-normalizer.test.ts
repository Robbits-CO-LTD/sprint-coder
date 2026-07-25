import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApprovalRequestedError, CodexJsonlNormalizer, CodexOutputError } from './codex-normalizer';

describe('CodexJsonlNormalizer', () => {
  it('converts Codex JSONL into canonical events without exposing provider payloads', () => {
    const fixture = readFileSync(join(__dirname, 'fixtures/codex-normal.jsonl'), 'utf8');
    const normalizer = new CodexJsonlNormalizer();
    const events = fixture
      .trim()
      .split('\n')
      .flatMap((line) => normalizer.push(line));

    expect(events.map((event) => (event.type === 'stage' ? event.stage : event.type))).toEqual([
      // Codex's own thread id, emitted from its structured `thread.started` event so Main can locate
      // generated images without parsing a path out of model prose (issue #11).
      'thread',
      'understanding',
      'planning',
      'executing',
      'synthesizing',
      'delta',
      'completed',
    ]);
    expect(events.find((event) => event.type === 'delta')).toMatchObject({
      type: 'delta',
      delta: 'Canonical answer.',
    });
    expect(JSON.stringify(events)).not.toContain('input_tokens');
  });

  // issue #11: the thread id is the *only* handle used to find generated images, so it has to come
  // from this structured field and be usable as one path segment — nothing more.
  it('surfaces the thread id from thread.started and nothing else from that event', () => {
    const normalizer = new CodexJsonlNormalizer();
    const events = normalizer.push(
      JSON.stringify({
        type: 'thread.started',
        thread_id: '019f976e-45b1-7a60-bd4d-14374e766d9a',
        cwd: '/private/tmp',
        secret: 'must not be forwarded',
      }),
    );
    expect(events).toEqual([{ type: 'thread', threadId: '019f976e-45b1-7a60-bd4d-14374e766d9a' }]);
    expect(JSON.stringify(events)).not.toContain('must not be forwarded');
  });

  it('emits nothing when thread.started carries no usable id', () => {
    // Validated here rather than only at the protocol boundary: Main interpolates this into a
    // filesystem path, and a normalizer that can emit something the protocol rejects would drop the
    // event silently, so images would stop appearing for no visible reason.
    for (const raw of [
      { type: 'thread.started' },
      { type: 'thread.started', thread_id: '' },
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'thread.started', thread_id: '../escape' },
      { type: 'thread.started', thread_id: '/absolute/path' },
      { type: 'thread.started', thread_id: 42 },
    ]) {
      const normalizer = new CodexJsonlNormalizer();
      expect(normalizer.push(JSON.stringify(raw)), JSON.stringify(raw)).toEqual([]);
    }
  });

  // Adversarial fixtures (Phase 7 hardening, IMPLEMENTATION_PLAN §10.4 5a): the Codex CLI is
  // launched with `approval_policy="never"` (codex-adapter.ts buildCodexArgs), so it should
  // never legitimately emit an approval-shaped event. If it does anyway — a Broker-bypass
  // attempt, a compromised CLI, or a future CLI version regressing the flag's effect — the
  // Turn must fail hard rather than silently continue or (worse) surface an interactive prompt.
  it('treats a top-level approval-requested event type as a fatal profile violation', () => {
    const normalizer = new CodexJsonlNormalizer();
    expect(() => normalizer.push('{"type":"approval_requested","id":"1"}')).toThrow(
      ApprovalRequestedError,
    );
  });

  it('treats a top-level human_input-shaped event type as a fatal profile violation', () => {
    const normalizer = new CodexJsonlNormalizer();
    expect(() => normalizer.push('{"type":"human_input_requested"}')).toThrow(
      ApprovalRequestedError,
    );
  });

  it('treats a nested item-level approval type as a fatal profile violation, not merely a skipped item', () => {
    const normalizer = new CodexJsonlNormalizer();
    expect(() =>
      normalizer.push('{"type":"item.completed","item":{"type":"command_approval_request"}}'),
    ).toThrow(ApprovalRequestedError);
  });

  it('treats an explicit error event as a thrown output error, not a silent completion', () => {
    const normalizer = new CodexJsonlNormalizer();
    expect(() => normalizer.push('{"type":"error","message":"boom"}')).toThrow(CodexOutputError);
  });

  it('treats turn.failed as a thrown output error', () => {
    const normalizer = new CodexJsonlNormalizer();
    expect(() => normalizer.push('{"type":"turn.failed","message":"denied by sandbox"}')).toThrow(
      CodexOutputError,
    );
  });

  it('throws on unparsable JSONL instead of silently dropping the line', () => {
    const normalizer = new CodexJsonlNormalizer();
    expect(() => normalizer.push('not json')).toThrow(CodexOutputError);
  });

  it('throws on a structurally invalid event (missing type)', () => {
    const normalizer = new CodexJsonlNormalizer();
    expect(() => normalizer.push('{"foo":"bar"}')).toThrow(CodexOutputError);
  });

  it('does not emit a second completed event for a duplicate turn.completed', () => {
    const normalizer = new CodexJsonlNormalizer();
    normalizer.push('{"type":"turn.started"}');
    const first = normalizer.push('{"type":"turn.completed"}');
    expect(first.at(-1)).toEqual({ type: 'completed' });
    const second = normalizer.push('{"type":"turn.completed"}');
    expect(second).toEqual([]);
  });
});
