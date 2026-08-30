import { describe, expect, it } from 'vitest';
import type { EffectiveWorkspaceSet } from '@sprint-coder/contracts';
import { displayWorkspaceRootLabel, resolveWorkspaceToolRoot } from './workspace-root-resolution';

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

  it('disambiguates labels from the complete sealed Workspace, not a reported subset', () => {
    const selected = workspace(['root-a', 'root-b'], 'root-a');
    const roots = selected.roots.map((root) => ({ ...root, label: 'same' }));
    const duplicateLabels = { ...selected, roots };

    expect(displayWorkspaceRootLabel(duplicateLabels, roots[0]!)).toBe('same [01]');
    expect(displayWorkspaceRootLabel(duplicateLabels, roots[1]!)).toBe('same [02]');
    const distinctLabels = workspace(['root-a', 'root-b'], 'root-a');
    expect(displayWorkspaceRootLabel(distinctLabels, distinctLabels.roots[0]!)).toBe('Root 1 [01]');
  });

  it('keeps display labels within the FileChange contract and disambiguates truncation', () => {
    for (const length of [199, 200, 255]) {
      const selected = workspace(['root-a'], 'root-a');
      const root = { ...selected.roots[0]!, label: 'x'.repeat(length) };
      expect(displayWorkspaceRootLabel({ ...selected, roots: [root] }, root)).toBe(
        'x'.repeat(Math.min(length, 200)),
      );
    }

    const selected = workspace(['root-a', 'root-b', 'root-c'], 'root-a');
    const roots = [
      { ...selected.roots[0]!, label: 'foo' },
      { ...selected.roots[1]!, label: 'foo' },
      { ...selected.roots[2]!, label: 'foo [01]' },
    ];
    const collidingLabels = { ...selected, roots };
    const labels = roots.map((root) => displayWorkspaceRootLabel(collidingLabels, root));
    expect(labels).toEqual(['foo [01]', 'foo [02]', 'foo [01] [03]']);
    expect(new Set(labels)).toHaveLength(3);

    const longRoots = selected.roots.map((root, index) => ({
      ...root,
      label: `${'x'.repeat(200)}${index}`,
    }));
    const longLabels = longRoots.map((root) =>
      displayWorkspaceRootLabel({ ...selected, roots: longRoots }, root),
    );
    expect(longLabels.every((label) => label.length === 200)).toBe(true);
    expect(new Set(longLabels)).toHaveLength(3);
  });
});
