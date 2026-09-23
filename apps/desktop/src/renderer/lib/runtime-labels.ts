import type { ClaudeEffort, RuntimeKind } from '../types/sprint-coder';

// Shared user-facing labels for Runtime/effort choices. Extracted from Composer.tsx (issue #5) so
// the Composer chips and the settings dialog cannot drift apart on what a given option is called —
// two places naming the same setting differently is worse than either name.

export const RUNTIME_LABEL: Record<RuntimeKind, string> = {
  mock: 'Mock Runtime',
  codex: 'Codex',
  claude: 'Claude Code',
  grok: 'Grok CLI',
};

export const RUNTIME_DESC: Record<RuntimeKind, string> = {
  mock: '決定論的ローカル応答',
  codex: 'ローカルのCodex CLIで実応答',
  claude: 'ローカルのClaude Code CLIで実応答',
  grok: 'ローカルのGrok CLIで実応答',
};

export const RUNTIME_CLI_MISSING_HINT: Record<Exclude<RuntimeKind, 'mock'>, string> = {
  codex: 'Codex CLIが見つかりません',
  claude: 'Claude CLIが見つかりません',
  grok: 'Grok CLIが見つかりません',
};

type RuntimeReadiness = 'ready' | 'authentication_required' | 'unavailable';

export function runtimeReadinessOf(
  kind: RuntimeKind,
  runtime: {
    codexReadiness: RuntimeReadiness;
    claudeReadiness: RuntimeReadiness;
    grokReadiness: RuntimeReadiness;
  },
): RuntimeReadiness {
  return kind === 'mock' ? 'ready' : runtime[`${kind}Readiness`];
}

/** Whether the CLI executable itself was found, independently of whether it is usable. */
export function runtimeCliFoundOf(
  kind: RuntimeKind,
  runtime: { codexAvailable?: boolean; claudeAvailable?: boolean; grokAvailable?: boolean },
): boolean {
  return kind === 'mock' || runtime[`${kind}Available`] === true;
}

export function runtimeReadinessHint(
  kind: Exclude<RuntimeKind, 'mock'>,
  readiness: 'ready' | 'authentication_required' | 'unavailable',
  cliFound = false,
): string | null {
  if (readiness === 'ready') return null;
  if (readiness === 'authentication_required')
    return `${RUNTIME_LABEL[kind]}はインストール済みですが、ログインが必要です${kind === 'grok' ? '（ターミナルで grok login を実行）' : ''}`;
  // A CLI that was found but whose state could not be confirmed must not be reported as missing:
  // that sends people to reinstall when the real problem is elsewhere (issue #517).
  if (cliFound)
    return `${RUNTIME_LABEL[kind]}は見つかりましたが、利用できる状態か確認できませんでした${kind === 'grok' ? '（ターミナルで grok login の状態を確認してください）' : ''}`;
  return RUNTIME_CLI_MISSING_HINT[kind];
}

export const RUNTIME_KINDS: readonly RuntimeKind[] = ['mock', 'codex', 'claude', 'grok'];

export const EFFORT_LEVELS: readonly ClaudeEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultracode',
];

export const EFFORT_LABEL: Record<ClaudeEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
  ultracode: 'Ultracode',
};

export const EFFORT_DESC: Record<ClaudeEffort, string> = {
  low: '最速・最小のコストで応答',
  medium: '速度と精度のバランス',
  high: 'じっくり考えて応答',
  xhigh: 'より深く考えて応答',
  max: '最大限考えて応答（最も低速・高コスト）',
  ultracode: '複数エージェントを動員して最大限に検証（最も低速・高コスト）',
};

/** Why the effort control is unavailable, or null when it is usable. */
export function effortUnavailableReason(
  kind: RuntimeKind,
  claudeAvailable: boolean,
): string | null {
  if (kind !== 'claude') return 'Claude Runtime選択時にEffortを変更できます';
  if (!claudeAvailable) return RUNTIME_CLI_MISSING_HINT.claude;
  return null;
}
