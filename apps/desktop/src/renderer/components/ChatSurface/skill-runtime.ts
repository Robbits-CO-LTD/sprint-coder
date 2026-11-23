import type { RuntimeKind } from '@sprint-coder/contracts';

const cliSkillRuntimes = new Map<string, 'claude' | 'codex' | 'grok'>([
  ['builtin:claude-cli', 'claude'],
  ['builtin:codex-cli', 'codex'],
  ['builtin:grok-cli', 'grok'],
]);

export function skillRuntimeForConnection(
  connection: string | null | undefined,
  runtime: RuntimeKind,
) {
  return connection
    ? (cliSkillRuntimes.get(connection) ?? 'provider')
    : runtime === 'mock'
      ? 'provider'
      : runtime;
}

export const providerSkillGroups = {
  grok: 'Grok Skills',
  opencode: 'OpenCode Skills',
  antigravity: 'Antigravity Skills',
  cursor: 'Cursor Skills',
} as const;
