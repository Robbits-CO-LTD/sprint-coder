import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectPermissionTrust } from './project-permission-trust';

let root: string;
const values = new Map<string, string>();
const store = {
  readProjectPermissionTrust: (key: string) => values.get(key) ?? null,
  saveProjectPermissionTrust: (entries: readonly { root: string; value: string }[]) => {
    for (const entry of entries) values.set(entry.root, entry.value);
  },
};
const trust = new ProjectPermissionTrust(store);
const configure = (allow: string[], deny: string[]) =>
  writeFileSync(
    join(root, '.sprint-coder', 'settings.json'),
    JSON.stringify({ permissions: { allow, deny } }),
  );

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sprint-permission-trust-'));
  mkdirSync(join(root, '.sprint-coder'));
  values.clear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('enforces new denies immediately and retains confirmed denies after the files change', async () => {
  configure(['Bash(git status)'], ['Read(private/**)']);
  expect(trust.snapshot(root)).toMatchObject({ allow: [], deny: ['Read(private/**)'] });
  await trust.review(
    [root],
    async () => true,
    () => true,
  );
  expect(new ProjectPermissionTrust(store).snapshot(root).allow).toEqual(['Bash(git status)']);
  configure(['Bash'], ['Edit(src/**)']);
  expect(trust.snapshot(root)).toMatchObject({
    allow: [],
    deny: ['Edit(src/**)', 'Read(private/**)'],
  });
  await trust.review(
    [root],
    async () => false,
    () => true,
  );
  expect(trust.snapshot(root).allow).toEqual([]);
  await trust.review(
    [root],
    async () => true,
    () => true,
  );
  expect(trust.snapshot(root)).toMatchObject({ allow: ['Bash'], deny: ['Edit(src/**)'] });
});

it('rejects changes to the rules or workspace during native confirmation', async () => {
  configure(['Bash(git status)'], []);
  const replace = vi.fn(async () => {
    configure(['Bash'], []);
    return true;
  });
  await trust.review([root], replace, () => true);
  expect(replace).toHaveBeenCalledOnce();
  expect(values.size).toBe(0);
  await trust.review(
    [root],
    async () => true,
    () => false,
  );
  expect(values.size).toBe(0);
});

it('fails closed when either set of rules is unreadable and recovers by confirming valid settings', async () => {
  configure(['Read(src/**)'], []);
  values.set(root, 'broken');
  expect(trust.snapshot(root).valid).toBe(false);
  await trust.review(
    [root],
    async () => true,
    () => true,
  );
  expect(trust.snapshot(root).valid).toBe(true);
  writeFileSync(join(root, '.sprint-coder', 'settings.json'), '{');
  expect(trust.snapshot(root).valid).toBe(false);
});
