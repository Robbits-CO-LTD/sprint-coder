import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolCatalogSnapshot } from '@sprint-coder/domain';
import type { RuntimeWorkspaceSet } from '../runtime-host/protocol';
import {
  compilePromptGuidance,
  discoverWorkspaceRules,
  injectPromptGuidance,
  type PromptWorkspaceRule,
} from './prompt-context';

const workspace: RuntimeWorkspaceSet = {
  primaryRootId: 'root',
  digest: 'workspace-digest',
  roots: [{ rootId: 'root', path: '/work/repo', label: 'repo', role: 'primary' }],
};

describe('prompt context compiler', () => {
  it('discovers the repository AGENTS.md as a scoped workspace rule', () => {
    const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
    const rules = discoverWorkspaceRules({
      primaryRootId: 'repo',
      digest: 'repo',
      roots: [{ rootId: 'repo', path: root, label: 'repo', role: 'primary' }],
    });
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: join(root, 'AGENTS.md'), scope: root, depth: 0 }),
      ]),
    );
  });

  it('is deterministic and applies deeper workspace rules later', () => {
    const rules: PromptWorkspaceRule[] = [
      { path: '/work/repo/src/AGENTS.md', scope: '/work/repo/src', depth: 1, content: 'deep' },
      { path: '/work/repo/AGENTS.md', scope: '/work/repo', depth: 0, content: 'root' },
    ];
    const input = {
      workspace,
      toolCatalog: catalog([]),
      now: new Date('2026-08-11T12:00:00.000Z'),
      platform: 'darwin' as const,
      shell: '/bin/zsh',
      workspaceRules: rules,
      vcs: [{ root: '/work/repo', branch: 'main', changes: [' M src/a.ts'] }],
    };

    const first = compilePromptGuidance(input);
    const second = compilePromptGuidance({ ...input, workspaceRules: [...rules].reverse() });

    expect(first.digest).toBe(second.digest);
    expect(first.content.indexOf('/work/repo/AGENTS.md')).toBeLessThan(
      first.content.indexOf('/work/repo/src/AGENTS.md'),
    );
    expect(first.content).toContain('未commitの変更');
    expect(first.context.environment.currentDate).toBe('2026-08-11');
  });

  it('lists only tools in the immutable catalog and never emits an empty tools section', () => {
    const withoutTools = compilePromptGuidance({
      workspace,
      toolCatalog: catalog([]),
      workspaceRules: [],
      vcs: [],
    });
    expect(withoutTools.content).not.toContain('実在が確認されたツール');
    expect(withoutTools.content).not.toContain('明示的に選択されたSkill');
    expect(withoutTools.content).not.toContain('接続済みの統合');

    const withCeiling = compilePromptGuidance({
      workspace,
      toolCatalog: catalog([
        tool('write_file', 'workspace.write', 'workspace', 'write'),
        tool('read_file', 'workspace.read', 'workspace', 'read'),
      ]),
      workspaceRules: [],
      vcs: [],
      writeScope: 'read-only',
      agent: { role: 'subagent', mode: 'write-capable', parentToolNames: ['read_file'] },
    });
    expect(withCeiling.context.agent.mode).toBe('read-only');
    expect(withCeiling.context.tools.map(({ name }) => name)).toEqual(['read_file']);
    expect(withCeiling.content).toContain('親にない能力やツールを子が持つものとして扱わない');
    expect(withCeiling.content).not.toContain('write_file');
  });

  it('tells an agent whose writes wait on approval cards that it can still write (issue #826)', () => {
    const input = {
      workspace,
      toolCatalog: catalog([
        tool('create_file', 'workspace.write', 'workspace', 'write'),
        tool('exec_command', 'command.exec', 'command', 'write'),
      ]),
      workspaceRules: [],
      vcs: [],
    };
    const ask = compilePromptGuidance({
      ...input,
      writeScope: 'workspace-write',
      writeApproval: 'per-call',
    });
    expect(ask.context.agent).toEqual({
      role: 'primary',
      mode: 'write-capable',
      writeApproval: 'per-call',
    });
    expect(ask.content).toContain('primary agent / write-capable');
    expect(ask.content).not.toContain('read-only');
    expect(ask.content).toContain('ツールを呼ぶと承認カードが出て許可を待つ');
    // issue #842: Workspace reads wait on a card under Ask too, so the agent is not told otherwise.
    // issue #842: an operation the person allowed for the Task (allow_task) runs without a card.
    expect(ask.content).toContain(
      'Workspaceの読み取りも含め、利用者がこのTaskで許可していない操作は承認が必要',
    );
    expect(ask.content).not.toContain('1回ごとに利用者の承認が必要');

    // A read-only agent is never told it may write, and other Turns keep their digest.
    const readOnly = compilePromptGuidance({
      ...input,
      writeScope: 'read-only',
      writeApproval: 'per-call',
    });
    expect(readOnly.context.agent).toEqual({ role: 'primary', mode: 'read-only' });
    expect(readOnly.content).not.toContain('承認が必要');
    const auto = compilePromptGuidance({ ...input, writeScope: 'workspace-write' });
    expect(auto.context.agent).toEqual({ role: 'primary', mode: 'write-capable' });
    expect(auto.content).not.toContain('承認が必要');
    expect(auto.digest).not.toBe(ask.digest);
  });

  it.each(['codex', 'claude', 'ollama'])(
    'advertises callable names for %s after applying the parent ceiling',
    (providerId) => {
      const compiled = compilePromptGuidance({
        workspace,
        toolCatalog: {
          ...catalog([
            tool('exec_command', 'command.exec', 'command', 'write'),
            tool('write_stdin', 'command.stdin', 'command', 'write'),
            tool('read_file', 'workspace.read', 'workspace', 'read'),
          ]),
          providerId,
        },
        workspaceRules: [],
        vcs: [],
        agent: {
          role: 'subagent',
          mode: 'write-capable',
          parentToolNames: ['exec_command', 'read_file'],
        },
      });
      const commandName = providerId === 'codex' ? 'sprint_exec_command' : 'exec_command';
      expect(compiled.context.tools.map(({ name }) => name).sort()).toEqual(
        [commandName, 'read_file'].sort(),
      );
      expect(compiled.content).toContain(commandName);
      expect(compiled.content).not.toContain('write_stdin');
      expect(compiled.context.tools.find(({ name }) => name === commandName)?.id).toBe(
        'command.exec',
      );
    },
  );

  it('includes only explicitly selected Skills and connected integrations', () => {
    const compiled = compilePromptGuidance({
      workspace,
      toolCatalog: catalog([]),
      workspaceRules: [],
      vcs: [],
      skills: [{ name: 'release' }, { name: 'release' }],
      teamMcpEnabled: true,
      now: new Date(2026, 7, 11, 0, 5),
    });
    expect(compiled.context.skills).toEqual(['release']);
    expect(compiled.context.integrations).toEqual(['sprint-coder-team-mcp']);
    expect(compiled.content).toContain('このTurnで明示的に選択されたSkill:');
    expect(compiled.content).toContain('このTurnで接続済みの統合:');
    expect(compiled.context.environment.currentDate).toBe('2026-08-11');
  });

  it('injects the canonical guidance once as system authority', () => {
    const compiled = compilePromptGuidance({
      workspace,
      toolCatalog: catalog([]),
      workspaceRules: [],
      vcs: [],
    });
    const fragments = injectPromptGuidance(
      [
        {
          id: 'system',
          source: 'system',
          trust: 'system',
          authority: 'system',
          content: 'base',
        },
      ],
      compiled,
    );
    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.content.match(/Sprint Coder execution context/gu)).toHaveLength(1);
    expect(fragments[0]?.content).toContain(compiled.digest);
  });

  it('keeps Workspace rule bodies out of system authority', () => {
    const compiled = compilePromptGuidance({
      workspace,
      toolCatalog: catalog([]),
      workspaceRules: [
        { path: '/work/repo/AGENTS.md', scope: '/work/repo', depth: 0, content: 'RULE_CANARY' },
      ],
      vcs: [],
    });
    const fragments = injectPromptGuidance([], compiled);

    expect(fragments).toHaveLength(2);
    expect(fragments[0]).toMatchObject({ source: 'system', authority: 'system', trust: 'system' });
    expect(fragments[0]?.content).not.toContain('RULE_CANARY');
    expect(fragments[1]).toMatchObject({ source: 'history', authority: 'user', trust: 'user' });
    expect(fragments[1]?.content).toContain('RULE_CANARY');
    expect(fragments[1]?.content).toContain('scope: "/work/repo"');
  });

  it('reinjects immutable guidance alongside a compacted conversation', () => {
    const compiled = compilePromptGuidance({
      workspace,
      toolCatalog: catalog([]),
      workspaceRules: [],
      vcs: [],
    });
    const fragments = injectPromptGuidance(
      [
        {
          id: 'system',
          source: 'system',
          trust: 'system',
          authority: 'system',
          content: 'base',
        },
        {
          id: 'summary',
          source: 'compaction',
          trust: 'assistant',
          authority: 'none',
          content: 'older conversation summary',
        },
      ],
      compiled,
    );
    expect(fragments.map(({ id }) => id)).toEqual(['system', 'summary']);
    expect(fragments[0]?.content).toContain('基本方針:');
    expect(fragments[1]?.authority).toBe('none');
  });

  // Issue #840: without each folder's rootId the agent had no way to address a secondary folder.
  it('tells the agent the rootId of every workspace folder and how to address a secondary one', () => {
    const compiled = compilePromptGuidance({
      workspace: {
        primaryRootId: 'root-a',
        digest: 'ws',
        roots: [
          { rootId: 'root-a', path: '/work/a', label: 'a', role: 'primary' },
          { rootId: 'root-b', path: '/work/b', label: 'b', role: 'secondary' },
        ],
      },
      toolCatalog: catalog([]),
      vcs: [],
      workspaceRules: [],
      platform: 'win32',
      shell: null,
    });
    expect(compiled.context.environment.workspaceRoots).toEqual([
      { rootId: 'root-a', label: 'a', path: '/work/a', role: 'primary' },
      { rootId: 'root-b', label: 'b', path: '/work/b', role: 'secondary' },
    ]);
    expect(compiled.content).toContain('"rootId":"root-b"');
    expect(compiled.content).toContain('複数のWorkspaceフォルダ');
  });

  it('keeps the multi-folder sentence out of a single-folder Turn', () => {
    const compiled = compilePromptGuidance({
      workspace,
      toolCatalog: catalog([]),
      vcs: [],
      workspaceRules: [],
      platform: 'linux',
      shell: null,
    });
    expect(compiled.context.environment.workspaceRoots).toEqual([
      { rootId: 'root', label: 'repo', path: '/work/repo', role: 'primary' },
    ]);
    expect(compiled.content).not.toContain('複数のWorkspaceフォルダ');
  });
});

function catalog(entries: ToolCatalogSnapshot['entries']): ToolCatalogSnapshot {
  return { revision: 1, providerId: 'test', workspaceId: 'root', entries, digest: 'catalog' };
}

function tool(
  providerName: string,
  toolId: string,
  kind: string,
  sideEffect: string,
): ToolCatalogSnapshot['entries'][number] {
  return { providerName, toolId, kind, sideEffect } as never;
}
