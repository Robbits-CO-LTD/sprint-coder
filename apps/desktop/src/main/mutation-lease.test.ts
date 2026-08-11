import { describe, expect, it } from 'vitest';
import { legacyMutationWorkspaceKey, mutationWorkspaceKey } from './mutation-lease';

describe('mutation Workspace identity', () => {
  it('uses one lease identity for Windows path casing variants', () => {
    const canonical = 'C:\\Users\\Alice\\Repo';
    const variant = 'c:\\users\\alice\\repo';
    const rootIdentity = 'a'.repeat(64);

    expect(legacyMutationWorkspaceKey(canonical, 'win32')).toBe(
      legacyMutationWorkspaceKey(variant, 'win32'),
    );
    expect(mutationWorkspaceKey(canonical, rootIdentity, 'win32')).toBe(
      mutationWorkspaceKey(variant, rootIdentity, 'win32'),
    );
  });
});
