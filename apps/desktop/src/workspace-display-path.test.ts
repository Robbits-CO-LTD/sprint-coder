import { describe, expect, it } from 'vitest';
import { TURN_DIFF_DISPLAY_PATH_MAX_LENGTH, turnDiffEntrySchema } from '@sprint-coder/contracts';
import {
  canonicalizeWorkspaceFileChangePath,
  formatWorkspaceDisplayPath,
  normalizeWorkspaceDisplayRelativePath,
} from './workspace-display-path';

describe('formatWorkspaceDisplayPath', () => {
  it('keeps the root/path separator unambiguous when components contain chevrons', () => {
    expect(formatWorkspaceDisplayPath('project', 'project › src/a.ts')).toBe(
      'project › project ›› src/a.ts',
    );
    expect(formatWorkspaceDisplayPath('foo [01]', 'bar › x')).not.toBe(
      formatWorkspaceDisplayPath('foo [01] › bar [02]', 'x'),
    );
  });

  it('preserves a legal POSIX backslash while normalizing Windows separators', () => {
    expect(normalizeWorkspaceDisplayRelativePath('foo\\bar', 'darwin')).toBe('foo\\bar');
    expect(normalizeWorkspaceDisplayRelativePath('foo/bar', 'darwin')).toBe('foo/bar');
    expect(normalizeWorkspaceDisplayRelativePath('foo\\bar', 'win32')).toBe('foo/bar');
  });

  it('canonicalizes persisted FileChange paths for the Main platform', () => {
    expect(canonicalizeWorkspaceFileChangePath('src\\nested\\file.ts', 'win32')).toBe(
      'src/nested/file.ts',
    );
    expect(canonicalizeWorkspaceFileChangePath('src\\literal.ts', 'darwin')).toBe(
      'src\\literal.ts',
    );
  });

  it('preserves the maximum raw label and path within the bounded display contract', () => {
    const path = formatWorkspaceDisplayPath('›'.repeat(200), '›'.repeat(4_096));
    expect(path).toHaveLength(8_595);
    expect(path.length).toBeLessThanOrEqual(TURN_DIFF_DISPLAY_PATH_MAX_LENGTH);
    expect(() =>
      turnDiffEntrySchema.parse({
        ordinal: 1,
        kind: 'update',
        path,
        destination: path,
        preHash: null,
        postHash: null,
        provenance: 'agent_edit',
        status: 'applied',
        actualHash: null,
      }),
    ).not.toThrow();
  });
});
