import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dialog, type BrowserWindow } from 'electron';
import { confirmProjectFolderRelink } from './ipc';

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

const parent = {} as BrowserWindow;
const folder = {
  id: 'root',
  path: '/workspace',
  canonicalPath: '/workspace',
  label: 'root',
  role: 'primary' as const,
  workspaceKey: 'b'.repeat(64),
  rootIdentityDigest: 'b'.repeat(64),
};

describe('Project root identity replacement consent', () => {
  it('does not prompt for unchanged identities or newly added roots', async () => {
    await confirmProjectFolderRelink(
      parent,
      [folder],
      new Map([['root', folder.rootIdentityDigest]]),
    );
    await confirmProjectFolderRelink(parent, [folder], new Map());
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it.each([0, 1])('requires the explicit native confirmation response (%s)', async (response) => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response, checkboxChecked: false });
    const result = confirmProjectFolderRelink(
      parent,
      [folder],
      new Map([['root', 'a'.repeat(64)]]),
    );
    if (response === 0) await expect(result).rejects.toThrow('relink was canceled');
    else await expect(result).resolves.toBeUndefined();
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      parent,
      expect.objectContaining({ defaultId: 0, cancelId: 0 }),
    );
  });
});
