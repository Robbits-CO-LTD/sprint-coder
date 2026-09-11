import { it, expect } from 'vitest';
import { mkdtemp, realpath, stat, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { directoryCaseSensitive, directoryCanonicalUnicode } from './directory-name-rules';
import { prepareStructuredPatch } from './structured-patch';
import { FileRevisionRegistry } from './file-revision';
const hfsRoot = process.env.SPRINT_CODER_HFSX_TEST_ROOT;
it.skipIf(process.platform !== 'darwin' || !hfsRoot)(
  'preserves normalization-sensitive HFSX names during preparation',
  async () => {
    const workspace = await realpath(await mkdtemp(join(hfsRoot!, 'sc-patch-hfsx-')));
    try {
      const info = await stat(workspace, { bigint: true });
      const identity = { dev: String(info.dev), ino: String(info.ino) };
      expect(directoryCaseSensitive(workspace, identity)).toBe(true);
      expect(directoryCanonicalUnicode(workspace, identity)).toBe(false);
      const names = ['塚.txt', '塚.txt'];
      for (const name of names) await writeFile(join(workspace, name), name, { flag: 'wx' });
      for (const name of names) expect(await readFile(join(workspace, name), 'utf8')).toBe(name);
      for (const name of names) await rm(join(workspace, name));
      const patch = await prepareStructuredPatch({
        owner: { taskId: 'test', turnId: 'test' },
        workspacePath: workspace,
        policyEpoch: 0,
        registry: new FileRevisionRegistry(),
        operations: names.map((path) => ({ kind: 'add', path, content: path })),
      });
      expect(patch.operations).toHaveLength(2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
