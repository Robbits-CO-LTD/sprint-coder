import type * as ChildProcess from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { githubLoginToken, writeGithubContent } from './github-issue';
import type * as CommandRunner from './command-runner';

const { search, execute } = vi.hoisted(() => ({
  search: vi.fn<() => string>(),
  execute: vi.fn(),
}));
vi.mock('./command-runner', async (importOriginal) => {
  const original = await importOriginal<typeof CommandRunner>();
  return {
    ...original,
    resolveBareExecutable: (name: string) =>
      original.resolveBareExecutable(name, { PATH: search() }),
  };
});
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  execFile: execute,
}));

const cleanup: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const lookupDirectory = await mkdtemp(join(tmpdir(), 'sc-github-cli-lookup-'));
  cleanup.push(lookupDirectory);
  search.mockReturnValue(lookupDirectory);
  const request = vi.fn<typeof fetch>();
  return {
    candidate: join(lookupDirectory, process.platform === 'win32' ? 'gh.exe' : 'gh'),
    request,
    submit: () =>
      writeGithubContent(
        { action: 'issue', repository: 'team/repo', title: 'fixture', body: 'fixture' },
        new AbortController().signal,
        () => true,
        { fetch: request },
      ),
  };
}

it('shows setup and login steps when GitHub CLI is missing from the actual executable search', async () => {
  const f = await fixture();
  const message =
    /GitHub CLI（gh）が見つかりません[\s\S]*https:\/\/cli\.github\.com\/[\s\S]*gh auth login --hostname github\.com[\s\S]*再起動/u;
  await expect(f.submit()).rejects.toThrow(message);
  await expect(githubLoginToken(new AbortController().signal)).rejects.toThrow(message);
  expect(execute).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
});

it('keeps the login guidance for a CLI candidate that cannot be used', async () => {
  const f = await fixture();
  await mkdir(f.candidate);
  await expect(f.submit()).rejects.toThrow('GitHubのログインを確認できませんでした');
  expect(execute).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
});

it.each([1, 'ENOENT'])(
  'keeps the login guidance and redacts process details after CLI lookup (%s)',
  async (code) => {
    const f = await fixture();
    await writeFile(f.candidate, '', { mode: 0o700 });
    execute.mockImplementation((_file, _args, _options, callback) => {
      callback(
        Object.assign(new Error('private fixture diagnostic'), {
          code,
          stderr: 'private fixture output',
        }),
      );
    });
    const error: unknown = await f.submit().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty(
      'message',
      expect.stringContaining('GitHubのログインを確認できませんでした'),
    );
    expect(error).toHaveProperty('message', expect.not.stringContaining('private fixture'));
    expect(error).not.toHaveProperty('cause');
    expect(execute).toHaveBeenCalledOnce();
    expect(f.request).not.toHaveBeenCalled();
  },
);
