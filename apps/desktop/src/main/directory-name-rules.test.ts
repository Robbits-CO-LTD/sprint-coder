import {
  mkdtemp,
  realpath,
  stat,
  writeFile,
  access,
  readdir,
  rename,
  mkdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { directoryCaseSensitive, windowsCaseInsensitiveNamesEqual } from './directory-name-rules';

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'sc-directory-rules-')));
  cleanup.push(path);
  const info = await stat(path, { bigint: true });
  return { path, identity: { dev: String(info.dev), ino: String(info.ino) } };
}
describe('directory name rules', () => {
  it.skipIf(process.platform !== 'win32')(
    'uses ordinal Windows casing without Unicode expansion',
    () => {
      expect(windowsCaseInsensitiveNamesEqual('New.txt', 'new.txt')).toBe(true);
      expect(windowsCaseInsensitiveNamesEqual('straße.txt', 'strasse.txt')).toBe(false);
      expect(windowsCaseInsensitiveNamesEqual('é.txt', 'e\u0301.txt')).toBe(false);
    },
  );
  it.skipIf(process.platform !== 'linux')('reads tmpfs directory rules', async () => {
    const path = await realpath(await mkdtemp('/dev/shm/sc-directory-rules-'));
    cleanup.push(path);
    const info = await stat(path, { bigint: true });
    const rules = directoryCaseSensitive(path, { dev: String(info.dev), ino: String(info.ino) });
    await writeFile(join(path, 'CaseWitness'), 'witness');
    expect(rules).toBe(
      !(await access(join(path, 'casewitness')).then(
        () => true,
        () => false,
      )),
    );
  });
  it('observes the actual directory rules without creating a probe file', async () => {
    const f = await fixture();
    const rules = directoryCaseSensitive(f.path, f.identity);
    expect(await readdir(f.path)).toEqual([]);
    // Only this test writes a witness, after the production query completed.
    await writeFile(join(f.path, 'CaseWitness'), 'witness');
    const lowerExists = await access(join(f.path, 'casewitness')).then(
      () => true,
      () => false,
    );
    expect(rules).toBe(!lowerExists);
  });
  it('rejects an identity replaced between path guarding and the native query', async () => {
    const f = await fixture();
    const previous = `${f.path}-previous`;
    cleanup.push(previous);
    await rename(f.path, previous);
    await mkdir(f.path);
    expect(() => directoryCaseSensitive(f.path, f.identity)).toThrow('Directory identity changed');
    expect(() => directoryCaseSensitive('../relative', f.identity)).toThrow(
      'Invalid directory identity',
    );
  });
});
