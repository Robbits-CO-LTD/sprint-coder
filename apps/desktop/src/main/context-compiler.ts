import { createHash } from 'node:crypto';
import type { ContextFragment, ContextTrust, ProjectContextItem } from './context-ledger';

export type InstructionAuthority = 'system' | 'user' | 'workspace' | 'none';

export type WorkspaceRule = {
  path: string;
  content: string;
};

export type WorldState = Readonly<Record<string, string | number | boolean | null>>;

export type ToolTranscriptItem =
  | {
      type: 'tool-call';
      callId: string;
      toolName: string;
      arguments: unknown;
    }
  | {
      type: 'tool-result';
      callId: string;
      content: string;
      isError: boolean;
    };

export type CompiledContextItem =
  | {
      type: 'instruction';
      sourceId: string;
      authority: InstructionAuthority;
      trust: ContextTrust | 'workspace';
      content: string;
    }
  | {
      type: 'world-state';
      authority: 'none';
      changes: WorldState;
    }
  | ToolTranscriptItem;

export type CompileContextInput = {
  fragments: readonly ContextFragment[];
  projectItems?: readonly ProjectContextItem[];
  workspaceRules?: readonly WorkspaceRule[];
  previousWorldState?: WorldState;
  worldState?: WorldState;
  toolTranscript?: readonly ToolTranscriptItem[];
  maxToolPairs?: number;
};

export type CompiledContext = {
  items: CompiledContextItem[];
  digest: string;
};

export class ContextCompiler {
  compile(input: CompileContextInput): CompiledContext {
    const items: CompiledContextItem[] = input.fragments.map((fragment) => ({
      type: 'instruction',
      sourceId: fragment.id,
      authority: authorityFor(fragment),
      trust: fragment.trust,
      content: fragment.content,
    }));
    for (const item of input.projectItems ?? [])
      items.push({
        type: 'instruction',
        sourceId: item.id,
        authority: item.authority,
        trust: 'user',
        content:
          item.kind === 'reference'
            ? JSON.stringify({ type: 'untrusted_project_reference', data: item.content })
            : item.content,
      });

    for (const rule of input.workspaceRules ?? [])
      items.push({
        type: 'instruction',
        sourceId: `workspace:${rule.path}`,
        authority: 'workspace',
        trust: 'workspace',
        content: rule.content,
      });

    const changes = diffWorldState(input.previousWorldState ?? {}, input.worldState ?? {});
    if (Object.keys(changes).length > 0)
      items.push({ type: 'world-state', authority: 'none', changes });

    const maxToolPairs = Math.max(0, input.maxToolPairs ?? 20);
    const normalizedTranscript = normalizeToolTranscript(input.toolTranscript ?? []);
    if (maxToolPairs > 0) items.push(...normalizedTranscript.slice(-maxToolPairs * 2));
    return { items, digest: digestCanonical(items) };
  }
}

export function normalizeToolTranscript(
  transcript: readonly ToolTranscriptItem[],
): ToolTranscriptItem[] {
  const results = new Map<string, Extract<ToolTranscriptItem, { type: 'tool-result' }>>();
  for (const item of transcript)
    if (item.type === 'tool-result' && !results.has(item.callId)) results.set(item.callId, item);

  const normalized: ToolTranscriptItem[] = [];
  const seen = new Set<string>();
  for (const item of transcript) {
    if (item.type !== 'tool-call' || seen.has(item.callId)) continue;
    seen.add(item.callId);
    normalized.push(item);
    normalized.push(
      results.get(item.callId) ?? {
        type: 'tool-result',
        callId: item.callId,
        content: 'Tool result was not committed.',
        isError: true,
      },
    );
  }
  return normalized;
}

export function diffWorldState(previous: WorldState, current: WorldState): WorldState {
  const keys = [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort();
  const changes: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    const before = previous[key];
    const after = current[key];
    if (before !== after) changes[key] = after ?? null;
  }
  return changes;
}

export function digestCanonical(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function authorityFor(fragment: ContextFragment): InstructionAuthority {
  if (fragment.source === 'system') return 'system';
  if (fragment.source === 'goal') return 'user';
  if (fragment.source === 'compaction' || fragment.source === 'background') return 'none';
  return fragment.trust === 'user' ? 'user' : 'none';
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}
