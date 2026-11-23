import { describe, expect, it } from 'vitest';
import {
  hasEffectiveWorkspaceRoot,
  taskHasEffectiveWorkspaceRoot,
} from './effective-workspace-root';

describe('effective Workspace root availability', () => {
  it('disables file editing for loaded and loading rootless tasks', () => {
    expect(hasEffectiveWorkspaceRoot(null, null, 0)).toBe(false);
    expect(hasEffectiveWorkspaceRoot(undefined, null, undefined)).toBe(false);
  });

  it('accepts a selected legacy Workspace or its task-summary fallback', () => {
    expect(hasEffectiveWorkspaceRoot({ path: 'C:\\work' }, null, 0)).toBe(true);
    expect(hasEffectiveWorkspaceRoot(undefined, 'C:\\legacy', 0)).toBe(true);
  });

  it('accepts a Project with configured folders even without a legacy Workspace', () => {
    expect(hasEffectiveWorkspaceRoot(null, null, 2)).toBe(true);
  });

  it('does not use a legacy Task path when Main reports no applicable legacy root', () => {
    const state = {
      tasks: [{ id: 'task', projectId: 'project', workspacePath: '/legacy' }],
      projects: [{ id: 'project', folderCount: 0 }],
      workspaceByTask: { task: null },
    };
    expect(taskHasEffectiveWorkspaceRoot('task', state)).toBe(false);
    expect(
      taskHasEffectiveWorkspaceRoot('task', {
        ...state,
        projects: [{ id: 'project', folderCount: 1 }],
      }),
    ).toBe(true);
  });
});
