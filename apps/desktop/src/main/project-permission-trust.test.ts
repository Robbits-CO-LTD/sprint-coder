import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { matchProjectPermissionRules } from './project-permission-settings';
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

it('shares only confirmed global allows across projects, with deny taking precedence across layers', async () => {
  const projectRoot = join(root, 'project');
  mkdirSync(join(projectRoot, '.sprint-coder'), { recursive: true });
  const otherRoot = join(root, 'other');
  mkdirSync(otherRoot);
  writeFileSync(
    join(projectRoot, '.sprint-coder', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Read(private/a)'], deny: ['Read(src/b)'] } }),
  );
  configure(['Read(src/**)'], ['Read(private/**)']);
  const withGlobal = new ProjectPermissionTrust(store, root);
  expect(withGlobal.snapshot(projectRoot)).toMatchObject({
    allow: [],
    deny: ['Read(private/**)', 'Read(src/b)'],
  });
  const confirm = vi.fn(async () => true);
  await withGlobal.review([projectRoot], confirm, () => true);
  expect(confirm.mock.calls).toHaveLength(2);
  const snapshot = withGlobal.snapshot(projectRoot);
  expect(snapshot.allow).toEqual(['Read(src/**)', 'Read(private/a)']);
  expect(matchProjectPermissionRules(snapshot, { tool: 'Read', relativePath: 'private/a' })).toBe(
    'deny',
  );
  expect(matchProjectPermissionRules(snapshot, { tool: 'Read', relativePath: 'src/b' })).toBe(
    'deny',
  );
  expect(withGlobal.snapshot(otherRoot).allow).toEqual(['Read(src/**)']);
  confirm.mockClear();
  await withGlobal.review([otherRoot], confirm, () => true);
  expect(confirm).not.toHaveBeenCalled();
});

it('cannot gain global allows by replacing settings from a workspace that contains home', async () => {
  const home = join(root, 'home');
  const homeConfig = join(home, '.sprint-coder');
  mkdirSync(homeConfig, { recursive: true });
  const settings = join(homeConfig, 'settings.json');
  writeFileSync(
    settings,
    JSON.stringify({ permissions: { allow: ['Read(src/a)'], deny: ['Bash'] } }),
  );
  writeFileSync(
    join(homeConfig, 'settings.local.json'),
    JSON.stringify({ permissions: { allow: ['Edit'] } }),
  );
  const withGlobal = new ProjectPermissionTrust(store, home);
  const confirm = vi.fn(async (_path: string, _rules: unknown, _scope: string) => true);
  await withGlobal.review([home], confirm, () => true);
  expect(confirm.mock.calls.map((call) => call[2])).toEqual(['global', 'project']);
  expect(withGlobal.snapshot(home).allow).toEqual(['Read(src/a)', 'Edit']);
  expect(withGlobal.snapshot(root).allow).toEqual(['Read(src/a)']);
  writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash'] } }));
  expect(withGlobal.snapshot(root)).toMatchObject({ allow: [], deny: ['Bash'] });
  expect(withGlobal.snapshot(home)).toMatchObject({ allow: ['Edit'], deny: ['Bash'] });
  rmSync(settings);
  expect(withGlobal.snapshot(root)).toMatchObject({ allow: [], deny: ['Bash'] });
  writeFileSync(settings, '{');
  expect(withGlobal.snapshot(root).valid).toBe(false);
});
