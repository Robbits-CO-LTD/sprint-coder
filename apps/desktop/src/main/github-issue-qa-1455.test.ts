import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { githubLoginToken, writeGithubContent } from './github-issue';
import { qa1455MarkerName } from './github-issue-qa-1455';

const state = vi.hoisted(() => ({ directory: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.directory } }));
afterEach(async () => {
  if (state.directory) await rm(state.directory, { recursive: true, force: true });
  state.directory = '';
});

it('blocks live authentication and other requests, then holds exactly the synthetic POST until Stop aborts', async () => {
  state.directory = await mkdtemp(join(tmpdir(), 'qa-1455-transport-'));
  const controller = new AbortController();
  const marker = join(state.directory, qa1455MarkerName);
  const onPostStarted = vi.fn();
  const request = {
    action: 'issue' as const,
    repository: 'sprint-coder-qa-do-not-send/stop-fixture',
    title: 'SC-QA-1455',
    body: 'Offline fixture for stopping before the synthetic response.',
  };
  const live = {
    fetch: vi.fn<typeof fetch>(),
    readToken: vi.fn<typeof githubLoginToken>(),
    onPostStarted,
  };
  await expect(githubLoginToken(controller.signal)).rejects.toThrow('QA専用');
  await expect(
    writeGithubContent(
      { ...request, repository: 'team/repo' },
      controller.signal,
      () => true,
      live,
    ),
  ).rejects.toThrow('QA専用');
  await expect(writeGithubContent(request, controller.signal, () => false, live)).rejects.toThrow(
    '権限',
  );
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  const result = writeGithubContent(request, controller.signal, () => true, live).catch(
    (error: unknown) => error,
  );
  await vi.waitFor(async () => {
    expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({
      event: 'synthetic_post_received',
      fixture: 'SC-QA-1455',
    });
  });
  expect(onPostStarted).toHaveBeenCalledOnce();
  expect(live.fetch).not.toHaveBeenCalled();
  expect(live.readToken).not.toHaveBeenCalled();
  controller.abort();
  await expect(result).resolves.toHaveProperty('message', expect.stringContaining('再送する前'));
});
