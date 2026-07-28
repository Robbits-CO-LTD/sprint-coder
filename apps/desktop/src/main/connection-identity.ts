import {
  modelSelectionSchema,
  type ModelSelection,
  type RuntimeKind,
} from '@sprint-coder/contracts';

export const BUILTIN_CLAUDE_CONNECTION_ID = 'builtin:claude-cli';
export const BUILTIN_CODEX_CONNECTION_ID = 'builtin:codex-cli';

export function modelSelectionForRuntime(runtimeKind: RuntimeKind, model: string): ModelSelection {
  if (runtimeKind === 'claude')
    return modelSelectionSchema.parse({
      connectionId: BUILTIN_CLAUDE_CONNECTION_ID,
      requestedProvider: 'anthropic',
      requestedModel: model,
    });
  if (runtimeKind === 'codex')
    return modelSelectionSchema.parse({
      connectionId: BUILTIN_CODEX_CONNECTION_ID,
      requestedProvider: 'openai',
      requestedModel: model,
    });
  return { connectionId: null, requestedProvider: null, requestedModel: null };
}
