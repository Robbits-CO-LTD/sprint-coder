import { describe, expect, it } from 'vitest';
import {
  ContextCompiler,
  diffWorldState,
  normalizeToolTranscript,
  type ToolTranscriptItem,
} from './context-compiler';
import type { ContextFragment } from './context-ledger';

describe('ContextCompiler', () => {
  it('keeps authority separate from origin trust', () => {
    const compiled = new ContextCompiler().compile({
      fragments: [
        fragment('system', 'system', 'system'),
        fragment('goal', 'goal', 'user'),
        fragment('assistant', 'history', 'assistant'),
        fragment('summary', 'compaction', 'user'),
        fragment('background', 'background', 'user'),
      ],
      workspaceRules: [{ path: 'AGENTS.md', content: 'Repository rule' }],
    });

    expect(
      compiled.items
        .filter((item) => item.type === 'instruction')
        .map(({ sourceId, authority, trust }) => [sourceId, authority, trust]),
    ).toEqual([
      ['system', 'system', 'system'],
      ['goal', 'user', 'user'],
      ['assistant', 'none', 'assistant'],
      ['summary', 'none', 'user'],
      ['background', 'none', 'user'],
      ['workspace:AGENTS.md', 'workspace', 'workspace'],
    ]);
  });

  it('injects only the changed world-state fields in stable order', () => {
    expect(
      diffWorldState(
        { branch: 'main', policyEpoch: 1, removed: true },
        { policyEpoch: 2, branch: 'main', added: 'yes' },
      ),
    ).toEqual({ added: 'yes', policyEpoch: 2, removed: null });
  });

  it('normalizes tool calls and results as indivisible pairs', () => {
    const transcript: ToolTranscriptItem[] = [
      { type: 'tool-result', callId: 'orphan', content: 'ignore', isError: false },
      { type: 'tool-call', callId: 'a', toolName: 'mock_echo', arguments: { text: 'a' } },
      { type: 'tool-call', callId: 'b', toolName: 'mock_echo', arguments: { text: 'b' } },
      { type: 'tool-result', callId: 'a', content: 'a', isError: false },
    ];

    expect(normalizeToolTranscript(transcript)).toEqual([
      transcript[1],
      transcript[3],
      transcript[2],
      {
        type: 'tool-result',
        callId: 'b',
        content: 'Tool result was not committed.',
        isError: true,
      },
    ]);
    const compiled = new ContextCompiler().compile({
      fragments: [],
      toolTranscript: transcript,
      maxToolPairs: 1,
    });
    expect(compiled.items).toEqual([
      transcript[2],
      {
        type: 'tool-result',
        callId: 'b',
        content: 'Tool result was not committed.',
        isError: true,
      },
    ]);
  });

  it('produces the same digest for equivalent world-state key order', () => {
    const compiler = new ContextCompiler();
    const first = compiler.compile({ fragments: [], worldState: { branch: 'main', epoch: 0 } });
    const second = compiler.compile({ fragments: [], worldState: { epoch: 0, branch: 'main' } });
    expect(first.digest).toBe(second.digest);
  });
});

function fragment(
  id: string,
  source: ContextFragment['source'],
  trust: ContextFragment['trust'],
): ContextFragment {
  return {
    id,
    taskId: 'task',
    source,
    trust,
    tokenEstimate: 1,
    content: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    messageId: null,
  };
}
