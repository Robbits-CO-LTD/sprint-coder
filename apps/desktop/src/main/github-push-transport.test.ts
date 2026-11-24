import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pushApprovedGithubCommit, GithubPushResultUnknown } from './github-push-transport';
import { readLocalGithubPush } from './local-github-push';
import { workspaceMutationBinding } from './path-guard';
import { parseGithubPushInput } from '../github-issue-request';

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  // Use a real, unprotected workspace even when Windows TEMP is under AppData.
  const base = await mkdtemp(join(process.cwd(), '.sc-push-protocol-'));
  temporary.push(base);
  const local = join(base, 'local');
  const remote = join(base, 'remote');
  await mkdir(local);
  const noHooks = join(base, 'empty-hooks');
  await mkdir(noHooks);
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
    ),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(base, 'missing-gitconfig'),
    GIT_AUTHOR_DATE: '1700000000 +0900',
    GIT_COMMITTER_DATE: '1700000010 +0000',
  };
  const git = (cwd: string, args: readonly string[], input?: Buffer) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=' + noHooks,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...args,
      ],
      { cwd, env, input, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  const tip = (cwd: string) => git(cwd, ['rev-parse', 'refs/heads/main']).toString().trim();
  const commit = async (text: string) => {
    await writeFile(join(local, 'readme.md'), text);
    git(local, ['add', '--', 'readme.md']);
    git(local, ['commit', '-m', text]);
    return tip(local);
  };
  git(local, ['init', '--object-format=sha1', '-b', 'main']);
  const older = await commit('initial');
  const parent = await commit('existing remote parent');
  git(base, [
    '-c',
    'protocol.file.allow=always',
    'clone',
    '--bare',
    '--no-hardlinks',
    local,
    remote,
  ]);
  git(remote, ['config', 'receive.denyNonFastForwards', 'true']);
  git(remote, ['update-ref', 'refs/heads/sibling', older]);
  const selected = await commit('approved content');
  const controller = new AbortController();
  const { canonicalPath, rootIdentityDigest } = await workspaceMutationBinding(local);
  const prepared = await readLocalGithubPush({
    workspacePath: canonicalPath,
    expectedRootIdentity: rootIdentityDigest,
    commitOid: selected,
    allowsPath: () => true,
    isCurrent: () => true,
    signal: controller.signal,
  });
  const methods: string[] = [];
  let beforeWrite = () => {};
  let afterWrite = () => {};
  const request = vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.redirect).toBe('error');
    const method = init?.method ?? '';
    methods.push(method);
    if (url === 'https://api.github.com/repos/team/repo') {
      expect(method).toBe('GET');
      return Response.json({ full_name: 'Team/Repo' });
    }
    if (url === 'https://github.com/team/repo.git/info/refs?service=git-receive-pack') {
      expect(method).toBe('GET');
      const wire = Buffer.concat([
        Buffer.from('001f# service=git-receive-pack\n0000'),
        git(remote, ['receive-pack', '--stateless-rpc', '--advertise-refs', '.']),
      ]);
      return new Response(Uint8Array.from(wire), {
        headers: { 'content-type': 'application/x-git-receive-pack-advertisement' },
      });
    }
    expect(url).toBe('https://github.com/team/repo.git/git-receive-pack');
    expect(method).toBe('POST');
    expect(init?.body).toBeInstanceOf(Uint8Array);
    if (!(init?.body instanceof Uint8Array)) throw new Error('Invalid body');
    beforeWrite();
    const body = git(remote, ['receive-pack', '--stateless-rpc', '.'], Buffer.from(init.body));
    afterWrite();
    return new Response(Uint8Array.from(body), {
      headers: { 'content-type': 'application/x-git-receive-pack-result' },
    });
  });
  const login = vi.fn(async () => 'local_test_credential');
  const onPostStarted = vi.fn();
  const push = (canSend = () => true) =>
    pushApprovedGithubCommit(
      {
        repository: 'team/repo',
        branch: 'main',
        prepared,
        canSend,
        signal: controller.signal,
        onPostStarted,
      },
      { readToken: login, fetch: request },
    );
  return {
    push,
    request,
    login,
    methods,
    older,
    parent,
    selected,
    controller,
    onPostStarted,
    head: () => tip(remote),
    sibling: () => git(remote, ['rev-parse', 'refs/heads/sibling']).toString().trim(),
    rewind: () => git(remote, ['update-ref', 'refs/heads/main', older, parent]),
    beforeWrite: (fn: () => void) => {
      beforeWrite = fn;
    },
    afterWrite: (fn: () => void) => {
      afterWrite = fn;
    },
  };
}

describe.skipIf(!gitAvailable)('offline conditional GitHub push', () => {
  it('sends one ref update, preserves the exact commit and reads it back', async () => {
    const f = await fixture();
    expect(f.head()).toBe(f.parent);
    await expect(f.push()).resolves.toBe('https://github.com/team/repo/tree/main');
    expect(f.head()).toBe(f.selected);
    expect(f.sibling()).toBe(f.older);
    expect(f.methods).toEqual(['GET', 'GET', 'POST', 'GET']);
    expect(f.onPostStarted).toHaveBeenCalledOnce();
    await f.push();
    expect(f.methods).toEqual(['GET', 'GET', 'POST', 'GET', 'GET', 'GET']);
  });

  it('makes no request without permission and no write when the advertised parent differs', async () => {
    const f = await fixture();
    await expect(f.push(() => false)).rejects.toThrow('権限');
    expect(f.login).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    f.rewind();
    await expect(f.push()).rejects.toThrow('親と一致しません');
    expect(f.methods).toEqual(['GET', 'GET']);
    expect(f.onPostStarted).not.toHaveBeenCalled();
  });

  it('refuses a ref changed to an earlier ancestor between discovery and POST', async () => {
    const f = await fixture();
    f.beforeWrite(f.rewind);
    await expect(f.push()).rejects.toThrow('ブランチを更新しませんでした');
    expect(f.methods).toEqual(['GET', 'GET', 'POST']);
    expect(f.head()).toBe(f.older);
  });

  it('marks the result unknown if the connection is lost after update, with no retry', async () => {
    const f = await fixture();
    f.afterWrite(() => {
      throw new Error('fixture disconnected');
    });
    await expect(f.push()).rejects.toBeInstanceOf(GithubPushResultUnknown);
    expect(f.methods).toEqual(['GET', 'GET', 'POST']);
    expect(f.head()).toBe(f.selected);
  });
});

it('recognizes only an explicit request for one repository, branch and full commit SHA', () => {
  const first = 'https://github.com/team/repo に push して';
  const oid = 'a'.repeat(40);
  const input = first + '\nブランチ: release/latest\nコミット: ' + oid;
  expect(parseGithubPushInput(input)).toEqual({
    kind: 'push',
    repository: 'team/repo',
    branch: 'release/latest',
    commitOid: oid,
  });
  expect(parseGithubPushInput(first)).toEqual({ kind: 'incomplete' });
  expect(parseGithubPushInput(input + '\n--force')).toEqual({ kind: 'incomplete' });
  expect(parseGithubPushInput(input.replace('release/latest', 'K'))).toEqual({
    kind: 'incomplete',
  });
  expect(parseGithubPushInput(input.replace('release/latest', '日本語'))).toEqual({
    kind: 'incomplete',
  });
  expect(parseGithubPushInput(input.replace('team/repo', 'team/K'))).toEqual({
    kind: 'incomplete',
  });
  expect(parseGithubPushInput('GitHub pushの使い方を教えて')).toBeNull();
  expect(parseGithubPushInput('push して')).toEqual({ kind: 'incomplete' });
  expect(parseGithubPushInput('GitHubにpushして')).toEqual({ kind: 'incomplete' });
  expect(parseGithubPushInput('「push して」')).toBeNull();
  expect(parseGithubPushInput('> GitHubにpushして')).toBeNull();
  expect(parseGithubPushInput('push して\nこの文を英訳して')).toBeNull();
  expect(parseGithubPushInput('push してと言われました')).toBeNull();
});
