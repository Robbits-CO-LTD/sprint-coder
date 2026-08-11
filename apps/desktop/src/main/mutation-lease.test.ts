import { describe, expect, it } from 'vitest';
import { legacyMutationWorkspaceKey, mutationWorkspaceKey } from './mutation-lease';

describe('mutation Workspace identity', () => {
  it('preserves persisted v1 digest compatibility', () => {
    const canonical = 'C:\\Users\\Alice\\Repo';
    const rootIdentity = 'a'.repeat(64);

    expect(legacyMutationWorkspaceKey(canonical)).toBe(
      'b212e5086b8330f261d89fae39663dc9b0982857a80bd1168f15034db0ffb418',
    );
    expect(mutationWorkspaceKey(canonical, rootIdentity)).toBe(
      'e3b582f34b08454e9e11e02249e38bd41d9bf00a3c33450a85e07c1bbb2f8cb0',
    );
  });
});
