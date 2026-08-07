import { describe, expect, it } from 'vitest';
import type { EffectiveWorkspaceSet } from '@sprint-coder/contracts';
import { resolveWorkspaceToolRoot } from './workspace-root-resolution';

function workspace(
  rootIds: readonly string[],
  primaryRootId: string | null,
): EffectiveWorkspaceSet {
  return {
    source: 'project',
    projectId: 'project-1',
    primaryRootId,
    roots: rootIds.map((rootId, index) => ({
      rootId,
      path: `/tmp/root-${index}`,
      label: `Root ${index + 1}`,
      role: index === 0 ? 'primary' : 'secondary',
      status: 'available',
    })),
    digest: 'a'.repeat(64),
  };
}

describe('resolveWorkspaceToolRoot', () => {
  it('uses an exact rootId and the primary root when the field is omitted', () => {
    const selected = workspace(['root-a', 'root-b'], 'root-a');
    expect(resolveWorkspaceToolRoot(selected, 'root-b')?.rootId).toBe('root-b');
    expect(resolveWorkspaceToolRoot(selected, undefined)?.rootId).toBe('root-a');
    expect(resolveWorkspaceToolRoot(selected, 'legacy-primary')?.rootId).toBe('root-a');
  });

  it('canonicalizes an invented optional rootId only when the Turn has one root', () => {
    expect(resolveWorkspaceToolRoot(workspace(['root-a'], 'root-a'), 'workspace')?.rootId).toBe(
      'root-a',
    );
    expect(resolveWorkspaceToolRoot(workspace(['root-a', 'root-b'], 'root-a'), 'workspace')).toBe(
      null,
    );
  });

  it('fails closed when no root can be selected', () => {
    expect(resolveWorkspaceToolRoot(workspace([], null), undefined)).toBe(null);
  });
});
