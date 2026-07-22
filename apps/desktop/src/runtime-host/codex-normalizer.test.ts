import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexJsonlNormalizer } from './codex-normalizer';

describe('CodexJsonlNormalizer', () => {
  it('converts Codex JSONL into canonical events without exposing provider payloads', () => {
    const fixture = readFileSync(join(__dirname, 'fixtures/codex-normal.jsonl'), 'utf8');
    const normalizer = new CodexJsonlNormalizer();
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
      'completed',
    ]);
    expect(events.find((event) => event.type === 'delta')).toMatchObject({
      type: 'delta',
      delta: 'Canonical answer.',
    });
    expect(JSON.stringify(events)).not.toContain('input_tokens');
  });
});
