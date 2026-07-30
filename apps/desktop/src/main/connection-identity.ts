import {
  modelSelectionSchema,
  type ModelSelection,
  type RuntimeKind,
} from '@sprint-coder/contracts';

export const BUILTIN_CLAUDE_CONNECTION_ID = 'builtin:claude-cli';
export const BUILTIN_CODEX_CONNECTION_ID = 'builtin:codex-cli';

export type BuiltinRuntimeSelection = Readonly<{
  runtimeKind: Extract<RuntimeKind, 'claude' | 'codex'>;
  model: string;
}>;

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

export function builtinRuntimeForModelSelection(
  selection: ModelSelection,
): BuiltinRuntimeSelection | null {
  const parsed = modelSelectionSchema.parse(selection);
  if (parsed.connectionId === null) return null;
  if (parsed.requestedModel === null)
    throw new Error('A selected Connection must include a requested model');
  if (
    parsed.connectionId === BUILTIN_CLAUDE_CONNECTION_ID &&
    parsed.requestedProvider === 'anthropic'
  )
    return { runtimeKind: 'claude', model: parsed.requestedModel };
  if (parsed.connectionId === BUILTIN_CODEX_CONNECTION_ID && parsed.requestedProvider === 'openai')
    return { runtimeKind: 'codex', model: parsed.requestedModel };
  return null;
}
