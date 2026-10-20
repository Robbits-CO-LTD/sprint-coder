import { describe, expect, it } from 'vitest';
import { describeFileChanges, workerActivityEntry } from './worker-activity-log';

const AT = '2026-10-20T10:00:00.000Z';

describe('workerActivityEntry', () => {
  it('reads a tool-call activity by its label', () => {
    expect(
      workerActivityEntry(
        'activity',
        { type: 'activity', phase: 'executing', label: ' read_file ' },
        AT,
      ),
    ).toEqual({ kind: 'activity', label: 'read_file', at: AT });
  });

  it('names a file change by its first path and counts the rest', () => {
    expect(
      workerActivityEntry(
        'fileChange',
        {
          type: 'fileChange',
          changes: [
            { path: 'src/login.ts', kind: 'update' },
            { path: 'src/login.test.ts', kind: 'add' },
          ],
        },
        AT,
      ),
    ).toEqual({ kind: 'fileChange', label: '編集 src/login.ts ほか1件', at: AT });
  });

  it('leaves out event types the work log does not show, and unreadable payloads', () => {
    expect(workerActivityEntry('accepted', { type: 'accepted' }, AT)).toBeNull();
    expect(workerActivityEntry('completed', { type: 'completed' }, AT)).toBeNull();
    expect(workerActivityEntry('activity', { label: '' }, AT)).toBeNull();
    expect(workerActivityEntry('activity', null, AT)).toBeNull();
    expect(
      workerActivityEntry('fileChange', { changes: [{ path: 1, kind: 'add' }] }, AT),
    ).toBeNull();
  });

  it('clips an oversized label to the contract limit', () => {
    const entry = workerActivityEntry('activity', { label: 'x'.repeat(900) }, AT);
    expect(entry?.label.length).toBe(500);
    expect(entry?.label.endsWith('…')).toBe(true);
  });
});

describe('describeFileChanges', () => {
  it('uses one verb per change kind', () => {
    expect(describeFileChanges([{ path: 'a.ts', kind: 'add' }])).toBe('作成 a.ts');
    expect(describeFileChanges([{ path: 'b.ts', kind: 'delete' }])).toBe('削除 b.ts');
    expect(describeFileChanges([])).toBe('ファイル変更');
  });
});
