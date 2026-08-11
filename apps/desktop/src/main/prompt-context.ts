import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RuntimeWriteScope } from '@sprint-coder/contracts';
import type { ToolCatalogSnapshot } from '@sprint-coder/domain';
import type { RuntimeContextFragment, RuntimeWorkspaceSet } from '../runtime-host/protocol';
import { digestCanonical } from './context-compiler';

export const PROMPT_CONTEXT_VERSION = 1;
const MAX_WORKSPACE_RULE_BYTES = 64 * 1024;

export type PromptAgent = Readonly<{
  role: 'primary' | 'subagent';
  mode: 'read-only' | 'write-capable';
  parentToolNames?: readonly string[];
}>;

export type PromptWorkspaceRule = Readonly<{
  path: string;
  scope: string;
  depth: number;
  content: string;
}>;

export type PromptEnvironment = Readonly<{
  os: string;
  shell: string | null;
  currentDate: string;
  workingDirectory: string | null;
  workspaceRoots: readonly Readonly<{
    label: string;
    path: string;
    role: 'primary' | 'secondary';
  }>[];
  vcs: readonly Readonly<{ root: string; branch: string | null; changes: readonly string[] }>[];
}>;

export type CanonicalPromptContext = Readonly<{
  version: typeof PROMPT_CONTEXT_VERSION;
  agent: PromptAgent;
  environment: PromptEnvironment;
  workspaceRules: readonly PromptWorkspaceRule[];
  tools: readonly Readonly<{
    name: string;
    id: string;
    kind: string;
    sideEffect: string;
  }>[];
  skills: readonly string[];
  integrations: readonly string[];
}>;

export type CompiledPromptGuidance = Readonly<{
  context: CanonicalPromptContext;
  content: string;
  digest: string;
}>;

export function compilePromptGuidance(input: {
  workspace: RuntimeWorkspaceSet;
  toolCatalog: ToolCatalogSnapshot;
  writeScope?: RuntimeWriteScope;
  agent?: PromptAgent;
  now?: Date;
  platform?: NodeJS.Platform;
  shell?: string | null;
  workspaceRules?: readonly PromptWorkspaceRule[];
  vcs?: PromptEnvironment['vcs'];
  skills?: readonly Readonly<{ name: string }>[];
  teamMcpEnabled?: boolean;
}): CompiledPromptGuidance {
  const requestedAgent = input.agent ?? {
    role: 'primary',
    mode: input.writeScope === 'read-only' ? 'read-only' : 'write-capable',
  };
  const parentTools =
    requestedAgent.parentToolNames === undefined ? null : new Set(requestedAgent.parentToolNames);
  const tools = input.toolCatalog.entries
    .filter(({ providerName }) => parentTools === null || parentTools.has(providerName))
    .map((entry) => ({
      name: entry.providerName,
      id: entry.toolId,
      kind: entry.kind,
      sideEffect: entry.sideEffect,
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const workspaceRoots = input.workspace.roots
    .map(({ label, path, role }) => ({ label, path, role }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const context: CanonicalPromptContext = {
    version: PROMPT_CONTEXT_VERSION,
    agent: {
      role: requestedAgent.role,
      mode:
        input.writeScope === 'read-only' || requestedAgent.mode === 'read-only'
          ? 'read-only'
          : 'write-capable',
      ...(requestedAgent.parentToolNames === undefined
        ? {}
        : { parentToolNames: [...requestedAgent.parentToolNames].sort() }),
    },
    environment: {
      os: input.platform ?? process.platform,
      shell:
        input.shell === undefined
          ? (process.env.SHELL ?? process.env.COMSPEC ?? null)
          : input.shell,
      currentDate: localDate(input.now ?? new Date()),
      workingDirectory:
        input.workspace.roots.find(({ rootId }) => rootId === input.workspace.primaryRootId)
          ?.path ?? null,
      workspaceRoots,
      vcs: [...(input.vcs ?? captureVcsSnapshot(input.workspace))].sort((left, right) =>
        left.root.localeCompare(right.root),
      ),
    },
    workspaceRules: [...(input.workspaceRules ?? discoverWorkspaceRules(input.workspace))].sort(
      (left, right) => left.depth - right.depth || left.path.localeCompare(right.path),
    ),
    tools,
    skills: [...new Set((input.skills ?? []).map(({ name }) => name))].sort(),
    integrations: input.teamMcpEnabled === true ? ['sprint-coder-team-mcp'] : [],
  };
  const content = renderPromptGuidance(context);
  return Object.freeze({ context, content, digest: digestCanonical(context) });
}

export function injectPromptGuidance(
  fragments: readonly RuntimeContextFragment[],
  compiled: CompiledPromptGuidance,
): RuntimeContextFragment[] {
  const systemIndex = fragments.findIndex(
    ({ source, authority, trust }) =>
      source === 'system' && authority === 'system' && trust === 'system',
  );
  const addendum = `\n\n[Sprint Coder execution context v${PROMPT_CONTEXT_VERSION}; digest=${compiled.digest}]\n${compiled.content}`;
  if (systemIndex < 0)
    return [
      {
        id: `prompt-context:${compiled.digest}`,
        source: 'system',
        authority: 'system',
        trust: 'system',
        content: addendum.trimStart(),
      },
      ...fragments,
    ];
  return fragments.map((fragment, index) =>
    index === systemIndex ? { ...fragment, content: `${fragment.content}${addendum}` } : fragment,
  );
}

export function discoverWorkspaceRules(workspace: RuntimeWorkspaceSet): PromptWorkspaceRule[] {
  const rules: PromptWorkspaceRule[] = [];
  for (const root of [...workspace.roots].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    for (const path of workspaceRuleCandidates(root.path)) {
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.size > MAX_WORKSPACE_RULE_BYTES) continue;
        const scope = dirname(path);
        const nested = relative(root.path, scope);
        rules.push({
          path,
          scope,
          depth: nested === '' ? 0 : nested.split(sep).length,
          content: readFileSync(path, 'utf8'),
        });
      } catch {
        // Missing, unreadable, symlinked, and oversized rule files are omitted rather than guessed.
      }
    }
  }
  return rules;
}

function workspaceRuleCandidates(root: string): string[] {
  const candidates = new Set([join(root, 'AGENTS.md')]);
  try {
    const output = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'AGENTS.md', '**/AGENTS.md'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    for (const item of output.split(/\r?\n/u).filter(Boolean).slice(0, 64)) {
      const path = resolve(root, item);
      const nested = relative(root, path);
      if (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
        candidates.add(path);
    }
  } catch {
    // A non-Git Workspace still receives its root AGENTS.md when present.
  }
  return [...candidates].sort();
}

export function captureVcsSnapshot(workspace: RuntimeWorkspaceSet): PromptEnvironment['vcs'] {
  return workspace.roots.map((root) => {
    try {
      const branch = execFileSync('git', ['branch', '--show-current'], {
        cwd: root.path,
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const status = execFileSync('git', ['status', '--short', '--untracked-files=normal'], {
        cwd: root.path,
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return {
        root: root.path,
        branch: branch === '' ? null : branch,
        changes: status.split(/\r?\n/u).filter(Boolean).slice(0, 100),
      };
    } catch {
      return { root: root.path, branch: null, changes: [] };
    }
  });
}

function renderPromptGuidance(context: CanonicalPromptContext): string {
  const lines = [
    '基本方針:',
    '- 現在の依頼を完了まで進める。観測していない結果を作らない。',
    '- ローカルで可逆な操作と、外部・破壊的・復元困難な操作を区別する。承認は対象操作だけに適用し、包括的な許可と解釈しない。',
    '- 未知のファイル、未commitの変更、利用者の作業を保持する。',
    '- 作業中は短い進捗を伝え、最終回答は結果・検証・残課題を簡潔に示す。',
    '',
    `実行主体: ${context.agent.role === 'primary' ? 'primary agent' : 'subagent'} / ${context.agent.mode}`,
  ];
  if (context.agent.role === 'subagent') {
    lines.push('- 親から委任された範囲だけを扱い、結果と根拠を親へ返す。');
    lines.push('- 親にない能力やツールを子が持つものとして扱わない。');
  }
  lines.push('', '実行環境:', JSON.stringify(context.environment));
  if (context.workspaceRules.length > 0) {
    lines.push('', 'Workspace規則（後にある深いscopeほど優先）:');
    for (const rule of context.workspaceRules)
      lines.push(`- ${rule.path} (scope: ${rule.scope})\n${rule.content}`);
  }
  if (context.tools.length > 0) {
    lines.push('', 'このTurnで実在が確認されたツール:');
    for (const tool of context.tools)
      lines.push(
        `- ${tool.name} [id=${tool.id}; kind=${tool.kind}; sideEffect=${tool.sideEffect}]`,
      );
    lines.push('一覧にないツールを利用可能だと仮定しない。');
  }
  if (context.skills.length > 0) {
    lines.push('', 'このTurnで明示的に選択されたSkill:');
    for (const skill of context.skills) lines.push(`- ${skill}`);
    lines.push('未選択のSkillを利用可能だと仮定しない。');
  }
  if (context.integrations.length > 0) {
    lines.push('', 'このTurnで接続済みの統合:');
    for (const integration of context.integrations) lines.push(`- ${integration}`);
  }
  return lines.join('\n');
}

function localDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
