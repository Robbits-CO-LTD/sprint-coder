import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CLAUDE_CONNECTION_ID,
  BUILTIN_CODEX_CONNECTION_ID,
  modelSelectionForRuntime,
} from './connection-identity';

describe('modelSelectionForRuntime', () => {
  it('maps built-in Claude and Codex CLI runtimes to stable Connection identities', () => {
    expect(modelSelectionForRuntime('claude', 'claude-opus-5')).toEqual({
      connectionId: BUILTIN_CLAUDE_CONNECTION_ID,
      requestedProvider: 'anthropic',
      requestedModel: 'claude-opus-5',
    });
    expect(modelSelectionForRuntime('codex', 'gpt-5.6-sol')).toEqual({
      connectionId: BUILTIN_CODEX_CONNECTION_ID,
      requestedProvider: 'openai',
      requestedModel: 'gpt-5.6-sol',
    });
  });

  it('keeps the test-only mock runtime outside user-facing Connection identity', () => {
    expect(modelSelectionForRuntime('mock', 'auto')).toEqual({
      connectionId: null,
      requestedProvider: null,
      requestedModel: null,
    });
  });
});
