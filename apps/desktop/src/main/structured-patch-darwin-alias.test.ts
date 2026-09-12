import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directoryCanonicalUnicode, directoryCaseSensitive } from './directory-name-rules';
import { FileRevisionRegistry } from './file-revision';
import { prepareStructuredPatch } from './structured-patch';

// The rules are read through the real addon from the guarded directory, so a temporary directory
// on the developer's own APFS volume cannot stand in for HFS+ or a network mount. Stub the two
// readings instead; every other part of preparation stays real.
vi.mock('./directory-name-rules', () => ({
  directoryCanonicalUnicode: vi.fn(),
  directoryCaseSensitive: vi.fn(),
  windowsCaseInsensitiveNamesEqual: vi.fn(() => true),
}));

const roots: string[] = [];
const owner = { taskId: 'task-1', turnId: 'turn-1' } as const;

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Prepares one `add` per name into a fresh workspace, so every endpoint is a missing sibling. */
async function prepareAdds(names: readonly string[]) {
  const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-darwin-alias-'));
  roots.push(workspace);
  await mkdir(join(workspace, 'src'));
  return prepareStructuredPatch({
    owner,
    workspacePath: workspace,
    policyEpoch: 1,
    registry: new FileRevisionRegistry(),
    operations: names.map((name) => ({
      kind: 'add' as const,
      path: `src/${name}`,
      content: name,
    })),
  });
}

describe.skipIf(process.platform !== 'darwin')('Darwin volumes that are not APFS', () => {
  beforeEach(() => {
    vi.mocked(directoryCanonicalUnicode).mockReturnValue(false);
    vi.mocked(directoryCaseSensitive).mockReturnValue(true);
  });

  it('rejects composed and decomposed spellings of one new name', async () => {
    await expect(prepareAdds(['é.txt', 'é.txt'])).rejects.toMatchObject({
      code: 'PATH_COLLISION',
    });
    // HFS+ normalization alone names these one file; the case rule never has to be consulted.
    expect(vi.mocked(directoryCaseSensitive)).not.toHaveBeenCalled();
  });

  it('reads the case rule and rejects non-ASCII case aliases on a case-insensitive volume', async () => {
    vi.mocked(directoryCaseSensitive).mockReturnValue(false);
    await expect(prepareAdds(['é.txt', 'É.txt'])).rejects.toMatchObject({
      code: 'PATH_COLLISION',
    });
    expect(vi.mocked(directoryCaseSensitive)).toHaveBeenCalled();
  });

  it('keeps non-ASCII case aliases apart on a case-sensitive volume', async () => {
    const patch = await prepareAdds(['é.txt', 'É.txt']);
    expect(patch.operations).toHaveLength(2);
    expect(vi.mocked(directoryCaseSensitive)).toHaveBeenCalled();
  });

  it('keeps names HFS+ leaves undecomposed apart on a case-sensitive volume', async () => {
    // U+FA10 is inside Apple's undecomposed range, so HFSX stores it separately from U+585A even
    // though plain NFD folds the two together.
    const patch = await prepareAdds(['塚.txt', '塚.txt']);
    expect(patch.operations).toHaveLength(2);
  });
});
