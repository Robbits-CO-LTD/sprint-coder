import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  symlink,
  link,
  rm,
  readdir,
  rename,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPathGuard, workspaceMutationBinding } from './path-guard';
import { directoryCaseSensitive } from './directory-name-rules';
import { prepareGraphWriteFootprint, graphWriteClaimsConflict } from './graph-write-conflicts';

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'sc-graph-claims-')));
  cleanup.push(path);
  return path;
}
async function bind(root: string, path: string | null, semanticKeys: string[] = []) {
  const binding = await workspaceMutationBinding(root);
  const parts = path?.split('/') ?? [];
  let count = 0;
  let guard;
  do {
    count++;
    guard = await createPathGuard({
      rootId: basename(root),
      workspacePath: root,
      expectedRootIdentityDigest: binding.rootIdentityDigest,
      targetPath: path === null ? '.' : parts.slice(0, count).join('/'),
      operation: 'write',
    });
  } while (guard.targetIdentity !== null && count < parts.length);
  const missingSuffix = parts.slice(count);
  return {
    stepKey: randomUUID(),
    relativePath: path,
    rootId: guard.rootId,
    rootIdentityDigest: binding.rootIdentityDigest,
    canonicalPath: join(guard.resolvedPath, ...missingSuffix),
    guard,
    missingSuffix,
    semanticKeys,
    missingNameCaseSensitive:
      guard.targetIdentity === null
        ? directoryCaseSensitive(dirname(guard.resolvedPath), guard.parentIdentity)
        : null,
  };
}
async function footprint(root: string, path: string | null, keys: string[] = []) {
  return prepareGraphWriteFootprint(await bind(root, path, keys));
}

describe('graph write conflicts', () => {
  it('recognizes physical aliases, hard links and directory containment while allowing sibling files', async () => {
    const root = await fixture();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/a.ts'), 'a');
    await writeFile(join(root, 'src/b.ts'), 'b');
    await symlink(
      join(root, 'src'),
      join(root, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await link(join(root, 'src/a.ts'), join(root, 'hard.ts'));
    const a = await footprint(root, 'src/a.ts');
    expect(graphWriteClaimsConflict(a, await footprint(root, 'alias/a.ts'))).toBe(true);
    expect(graphWriteClaimsConflict(a, await footprint(root, 'hard.ts'))).toBe(true);
    expect(graphWriteClaimsConflict(a, await footprint(root, 'src'))).toBe(true);
    expect(graphWriteClaimsConflict(a, await footprint(root, null))).toBe(true);
    expect(graphWriteClaimsConflict(a, await footprint(root, 'src/b.ts'))).toBe(false);
    const upper = await footprint(root, 'SRC/a.ts');
    expect(graphWriteClaimsConflict(a, upper)).toBe(upper.suffix.length === 0);
  });

  it('compares missing suffixes using observed name rules without creating their directories', async () => {
    const root = await fixture();
    const a = await footprint(root, 'new/Feature.ts');
    const lower = await footprint(root, 'new/feature.ts');
    expect(graphWriteClaimsConflict(a, lower)).toBe(!a.caseSensitive);
    expect(graphWriteClaimsConflict(a, await footprint(root, 'new/Feature.ts/child'))).toBe(true);
    expect(graphWriteClaimsConflict(a, await footprint(root, 'new/other.ts'))).toBe(false);
    expect(graphWriteClaimsConflict(a, await footprint(root, 'newer/Feature.ts'))).toBe(false);
    const composed = await footprint(root, 'Caf\u00e9.ts');
    const decomposed = await footprint(root, 'Cafe\u0301.ts');
    expect(graphWriteClaimsConflict(composed, decomposed)).toBe(
      process.platform === 'darwin' ||
        (process.platform === 'linux' && composed.caseSensitive === false),
    );
    const expanded = await footprint(root, '\u00df.ts');
    expect(graphWriteClaimsConflict(expanded, await footprint(root, '\u1e9e.ts'))).toBe(
      !expanded.caseSensitive,
    );
    expect(await readdir(root)).toEqual([]);
  });

  it('scopes semantic keys to overlapping physical roots, independently of declared root IDs', async () => {
    const root = await fixture();
    const other = await fixture();
    await mkdir(join(root, 'nested'));
    await symlink(
      join(root, 'nested'),
      join(root, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const a = await footprint(root, 'a.ts', ['shared-api']);
    const nested = await footprint(join(root, 'nested'), 'b.ts', ['shared-api']);
    expect(graphWriteClaimsConflict(a, nested)).toBe(true);
    expect(
      graphWriteClaimsConflict(
        nested,
        await footprint(join(root, 'alias'), 'c.ts', ['shared-api']),
      ),
    ).toBe(true);
    expect(graphWriteClaimsConflict(a, await footprint(other, 'b.ts', ['shared-api']))).toBe(false);
    expect(graphWriteClaimsConflict(a, await footprint(join(root, 'nested'), 'b.ts'))).toBe(false);
    expect(graphWriteClaimsConflict(await footprint(root, null), nested)).toBe(true);
  });

  it('keeps Unicode spellings together whenever actual filesystem creation finds an alias', async () => {
    for (const [a, b] of [
      ['Caf\u00e9.ts', 'Cafe\u0301.ts'],
      ['\u00df.ts', '\u1e9e.ts'],
      ['\u03a3.ts', '\u03c2.ts'],
      ['\u212a.ts', 'K.ts'],
    ] as const) {
      const root = await fixture();
      const predicted = graphWriteClaimsConflict(
        await footprint(root, a),
        await footprint(root, b),
      );
      await writeFile(join(root, a), 'first', { flag: 'wx' });
      const alias = await writeFile(join(root, b), 'second', { flag: 'wx' }).then(
        () => false,
        (error: unknown) => {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'EEXIST'
          )
            return true;
          throw error;
        },
      );
      if (alias) expect(predicted).toBe(true);
    }
  });

  it('rejects stale or fabricated preparation instead of treating it as independent work', async () => {
    const root = await fixture();
    const claim = await bind(root, 'missing/sub.ts');
    const prepared = await prepareGraphWriteFootprint(claim);
    expect(() => graphWriteClaimsConflict({ ...prepared }, prepared)).toThrow('Unissued');
    await mkdir(join(root, 'missing'));
    await expect(prepareGraphWriteFootprint(claim)).rejects.toThrow('Path identity changed');
    const fresh = await bind(root, 'missing/sub.ts');
    await expect(prepareGraphWriteFootprint({ ...fresh, missingSuffix: ['..'] })).rejects.toThrow(
      'binding mismatch',
    );
  });

  it('retains the claimed address across creation and replacement until its owner releases it', async () => {
    const root = await fixture();
    const missing = await footprint(root, 'new/a.ts');
    await mkdir(join(root, 'new'));
    await writeFile(join(root, 'new/a.ts'), 'first');
    const first = await footprint(root, 'new/a.ts');
    expect(graphWriteClaimsConflict(missing, first)).toBe(true);
    expect(graphWriteClaimsConflict(missing, await footprint(root, 'new/b.ts'))).toBe(false);
    await rename(join(root, 'new/a.ts'), join(root, 'new/previous.ts'));
    await writeFile(join(root, 'new/a.ts'), 'replacement');
    const replacement = await footprint(root, 'new/a.ts');
    expect(replacement.objectKey).not.toBe(first.objectKey);
    expect(graphWriteClaimsConflict(first, replacement)).toBe(true);
  });

  it('retains a declared alias address when the alias is redirected', async () => {
    const root = await fixture();
    for (const dir of ['first', 'second']) {
      await mkdir(join(root, dir));
      await writeFile(join(root, dir, 'a.ts'), dir);
    }
    const kind = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(join(root, 'first'), join(root, 'alias'), kind);
    const first = await footprint(root, 'alias/a.ts');
    await rm(join(root, 'alias'));
    await symlink(join(root, 'second'), join(root, 'alias'), kind);
    const second = await footprint(root, 'alias/a.ts');
    expect(second.objectKey).not.toBe(first.objectKey);
    expect(second.canonicalPath).not.toBe(first.canonicalPath);
    expect(graphWriteClaimsConflict(first, second)).toBe(true);
  });

  it.runIf(process.platform === 'win32')(
    'holds possible future short-name aliases together',
    async () => {
      const root = await fixture();
      expect(
        graphWriteClaimsConflict(
          await footprint(root, 'NewLongFilename.txt'),
          await footprint(root, 'NEWLON~1.TXT'),
        ),
      ).toBe(true);
    },
  );
});
