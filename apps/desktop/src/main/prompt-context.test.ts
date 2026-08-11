import { describe, expect, it } from 'vitest';
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
    const root = process.cwd();
    const rules = discoverWorkspaceRules({
      primaryRootId: 'repo',
      digest: 'repo',
      roots: [{ rootId: 'repo', path: root, label: 'repo', role: 'primary' }],
    });
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: `${root}/AGENTS.md`, scope: root, depth: 0 }),
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
