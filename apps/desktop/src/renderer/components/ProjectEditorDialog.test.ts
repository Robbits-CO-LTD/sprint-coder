import { describe, expect, it } from 'vitest';
import {
  draftFoldersFromPicker,
  folderInputs,
  normalizePrimary,
  type DraftProjectFolder,
} from './ProjectEditorDialog';

const draft = (path: string, role: 'primary' | 'secondary', id?: string): DraftProjectFolder => ({
  ...(id === undefined ? {} : { id }),
  path,
  label: path.split('/').at(-1) ?? path,
  role,
  status: 'available',
});

describe('Project folder editor projection', () => {
  it('makes the first picked folder Primary and retains IDs only for matching paths', () => {
    const result = draftFoldersFromPicker(
      [draft('/workspace/one', 'primary', 'root-1')],
      [
        { path: '/workspace/two', label: 'two' },
        { path: '/workspace/one', label: 'one' },
      ],
    );

    expect(result).toMatchObject([
      { path: '/workspace/two', role: 'primary' },
      { id: 'root-1', path: '/workspace/one', role: 'secondary' },
    ]);
    expect(result[0]).not.toHaveProperty('id');
  });

  it('promotes the first remaining folder when Primary is removed', () => {
    expect(
      normalizePrimary([
        draft('/workspace/two', 'secondary'),
        draft('/workspace/three', 'secondary'),
      ]).map(({ role }) => role),
    ).toEqual(['primary', 'secondary']);
    expect(normalizePrimary([])).toEqual([]);
  });

  it('omits absent optional IDs from the strict IPC input', () => {
    const inputs = folderInputs([draft('/workspace/one', 'primary')]);
    expect(inputs).toEqual([{ path: '/workspace/one', label: 'one', role: 'primary' }]);
    expect(inputs[0]).not.toHaveProperty('id');
  });
});
