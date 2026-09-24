import { describe, expect, it } from 'vitest';
import {
  leaderWriteLimitNote,
  workerWriteLimitNotice,
  workspaceWriteLimitsFromTools,
  workspaceWriteLimitsOf,
  type WorkspaceWriteLimits,
} from './workspace-write-limits';

describe('workspaceWriteLimitsFromTools', () => {
  it('is null when create_file is absent, since that is a different write-not-attempted state', () => {
    expect(workspaceWriteLimitsFromTools([])).toBeNull();
    expect(workspaceWriteLimitsFromTools(['list_workspace', 'read_file'])).toBeNull();
  });

  it('reports both operations as available when apply_patch and create_directory are present', () => {
    expect(
      workspaceWriteLimitsFromTools(['create_file', 'apply_patch', 'create_directory']),
    ).toEqual({ editExisting: true, createDirectory: true });
  });

  it('reports the Windows add-only limit when only create_file is present', () => {
    expect(workspaceWriteLimitsFromTools(['create_file'])).toEqual({
      editExisting: false,
      createDirectory: false,
    });
  });

  it('derives editExisting/createDirectory independently', () => {
    expect(workspaceWriteLimitsFromTools(['create_file', 'apply_patch'])).toEqual({
      editExisting: true,
      createDirectory: false,
    });
    expect(workspaceWriteLimitsFromTools(['create_file', 'create_directory'])).toEqual({
      editExisting: false,
      createDirectory: true,
    });
  });
});

describe('workspaceWriteLimitsOf', () => {
  it('is null for undefined WorkspacePatchDeps', () => {
    expect(workspaceWriteLimitsOf(undefined)).toBeNull();
  });

  it('matches provider-workspace-tools.ts registration: supportsPatch !== false, createDirectory !== undefined', () => {
    expect(workspaceWriteLimitsOf({})).toEqual({ editExisting: true, createDirectory: false });
    expect(workspaceWriteLimitsOf({ supportsPatch: true })).toEqual({
      editExisting: true,
      createDirectory: false,
    });
    expect(workspaceWriteLimitsOf({ supportsPatch: false })).toEqual({
      editExisting: false,
      createDirectory: false,
    });
    expect(workspaceWriteLimitsOf({ createDirectory: async () => undefined })).toEqual({
      editExisting: true,
      createDirectory: true,
    });
    expect(
      workspaceWriteLimitsOf({ supportsPatch: false, createDirectory: async () => undefined }),
    ).toEqual({ editExisting: false, createDirectory: true });
  });
});

const noLimits: WorkspaceWriteLimits = { editExisting: true, createDirectory: true };
const addOnly: WorkspaceWriteLimits = { editExisting: false, createDirectory: false };
const editOnlyLimited: WorkspaceWriteLimits = { editExisting: true, createDirectory: false };
const dirOnlyLimited: WorkspaceWriteLimits = { editExisting: false, createDirectory: true };

describe('workerWriteLimitNotice', () => {
  it('is empty when there is no limit at all', () => {
    expect(workerWriteLimitNotice(null)).toBe('');
    expect(workerWriteLimitNotice(noLimits)).toBe('');
  });

  it('names what cannot be done, what can, and tells the Worker to report instead of renaming', () => {
    const notice = workerWriteLimitNotice(addOnly, 'win32');
    expect(notice).toContain('既存ファイルの編集・削除');
    expect(notice).toContain('フォルダの作成');
    expect(notice).toContain('新しいファイルの作成はできます');
    expect(notice).toContain('別名のファイルを作って代わりにせず');
    expect(notice).toContain('必要な変更内容を報告してください');
  });

  it('differs between win32 and other platforms only in the stated reason', () => {
    const win = workerWriteLimitNotice(addOnly, 'win32');
    const linux = workerWriteLimitNotice(addOnly, 'linux');
    expect(win).toContain(
      'Windows では、安全に書き込める操作が今は新しいファイルの作成に限られるため',
    );
    expect(linux).toContain('この環境の安全な書き込みの制限のため');
    expect(win).not.toContain('この環境の安全な書き込みの制限のため');
    expect(linux).not.toContain('Windows では');
  });

  it('names only the missing capability when just one is limited', () => {
    // editExisting: true, createDirectory: false — only directory creation is missing.
    const editOk = workerWriteLimitNotice(editOnlyLimited, 'win32');
    expect(editOk).not.toContain('既存ファイルの編集・削除');
    expect(editOk).toContain('フォルダの作成');
    // Still notes that new files only land inside existing folders when directories cannot be made.
    expect(editOk).toContain('既にあるフォルダの中だけ');

    // editExisting: false, createDirectory: true — only editing is missing, folders can be made.
    const dirOk = workerWriteLimitNotice(dirOnlyLimited, 'win32');
    expect(dirOk).toContain('既存ファイルの編集・削除');
    expect(dirOk).not.toContain('フォルダの作成はできません');
    expect(dirOk).not.toContain('既にあるフォルダの中だけ');
  });
});

describe('leaderWriteLimitNote', () => {
  it('is empty when there is no limit at all', () => {
    expect(leaderWriteLimitNote(null)).toBe('');
    expect(leaderWriteLimitNote(noLimits)).toBe('');
  });

  it('tells the Leader/Manager what the Worker cannot do, why, and to ask for a report instead', () => {
    const note = leaderWriteLimitNote(addOnly, 'win32');
    expect(note).toContain('既存ファイルの編集・削除');
    expect(note).toContain('フォルダの作成');
    expect(note).toContain(
      'Windows では、安全に書き込める操作が今は新しいファイルの作成に限られるため',
    );
    expect(note).toContain('Workerに変更内容の報告を頼んでください');
  });

  it('states only the non-Windows reason off Windows', () => {
    const note = leaderWriteLimitNote(addOnly, 'darwin');
    expect(note).toContain('この環境の安全な書き込みの制限のため');
    expect(note).not.toContain('Windows では');
  });
});
