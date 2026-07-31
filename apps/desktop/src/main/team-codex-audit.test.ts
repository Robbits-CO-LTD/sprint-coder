import { describe, expect, it } from 'vitest';
import { evaluateCodexOnlyAudit } from './team-codex-audit';
import type { AgentRecord, TeamAttemptRecord } from './persistence';

const selection = {
  connectionId: 'builtin:codex-cli',
  requestedProvider: 'openai',
  requestedModel: 'gpt-5.6-sol',
} as const;

describe('Codex-only Team audit', () => {
  it('accepts only explicit Codex CLI OpenAI identities and completed resolutions', () => {
    const agent = { id: 'agent-1', modelSelection: selection } as AgentRecord;
    const attempt = {
      id: 'attempt-1',
      state: 'completed',
      modelSelection: selection,
      resolution: {
        resolvedProvider: 'openai',
        resolvedModel: 'gpt-5.6-sol',
      },
    } as TeamAttemptRecord;

    expect(evaluateCodexOnlyAudit([agent], [attempt])).toEqual({
      ok: true,
      agentCount: 1,
      attemptCount: 1,
      violations: [],
    });
  });

  it('reports non-Codex Connections, Providers, auto models, and bad resolutions', () => {
    const agent = {
      id: 'agent-1',
      modelSelection: {
        connectionId: 'builtin:claude-cli',
        requestedProvider: 'anthropic',
        requestedModel: 'auto',
      },
    } as AgentRecord;
    const attempt = {
      id: 'attempt-1',
      state: 'completed',
      modelSelection: agent.modelSelection,
      resolution: {
        resolvedProvider: 'anthropic',
        resolvedModel: 'claude',
      },
    } as TeamAttemptRecord;

    expect(evaluateCodexOnlyAudit([agent], [attempt])).toMatchObject({
      ok: false,
      violations: [
        'agent:agent-1:connection',
        'agent:agent-1:provider',
        'agent:agent-1:model',
        'attempt:attempt-1:connection',
        'attempt:attempt-1:provider',
        'attempt:attempt-1:model',
        'attempt:attempt-1:invalid_resolution',
      ],
    });
  });
});
