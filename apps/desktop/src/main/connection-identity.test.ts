import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CLAUDE_CONNECTION_ID,
  BUILTIN_CODEX_CONNECTION_ID,
  builtinRuntimeForModelSelection,
  modelSelectionForRuntime,
} from './connection-identity';

describe('connection identity', () => {
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

  it('round-trips built-in Claude and Codex selections', () => {
    expect(
      builtinRuntimeForModelSelection(modelSelectionForRuntime('claude', 'claude-opus-5')),
    ).toEqual({
      runtimeKind: 'claude',
      model: 'claude-opus-5',
    });
    expect(
      builtinRuntimeForModelSelection(modelSelectionForRuntime('codex', 'gpt-5.6-terra')),
    ).toEqual({
      runtimeKind: 'codex',
      model: 'gpt-5.6-terra',
    });
  });

  it('leaves an external Connection for the Provider Registry', () => {
    expect(
      builtinRuntimeForModelSelection({
        connectionId: 'connection:openai-production',
        requestedProvider: 'openai',
        requestedModel: 'gpt-5.6',
      }),
    ).toBeNull();
  });
});
