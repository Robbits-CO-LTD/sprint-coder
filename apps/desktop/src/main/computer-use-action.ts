import { createHash } from 'node:crypto';
import {
  computerUseActionKindSchema,
  type ComputerUseAction,
  type ComputerUseActionKind,
} from '@sprint-coder/contracts';

export function computerUseActionKind(action: ComputerUseAction): ComputerUseActionKind {
  return computerUseActionKindSchema.parse(action.type);
}

export function computerUseActionRoute(action: ComputerUseAction): 'semantic' | 'visual' | 'none' {
  if (action.type === 'wait' || action.type === 'finish') return 'none';
  if (
    action.type === 'invoke' ||
    action.type === 'set_text' ||
    action.type === 'select' ||
    action.type === 'toggle' ||
    action.type === 'expand_collapse'
  )
    return 'semantic';
  return 'visual';
}

export function computerUseActionDigest(action: ComputerUseAction): string {
  return createHash('sha256')
    .update(stableStringify(redactActionText(action)))
    .digest('hex');
}

function redactActionText(action: ComputerUseAction): unknown {
  const value = action as unknown as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => {
      if ((key === 'text' || key === 'value') && typeof nested === 'string')
        return [key, { byteLength: Buffer.byteLength(nested, 'utf8'), sha256: sha256(nested) }];
      return [key, nested];
    }),
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(',')}}`;
}
