import { writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import type { GithubWriteRequest } from '../github-issue-request';

const repository = 'sprint-coder-qa-do-not-send/stop-fixture';
const title = 'SC-QA-1455';
const body = 'Offline fixture for stopping before the synthetic response.';
export const qa1455ProfileName = 'sc-qa-1455-profile';
export const qa1455MarkerName = 'sc-qa-1455-post-started.json';

export function isQa1455Request(request: GithubWriteRequest): boolean {
  return (
    request.action === 'issue' &&
    request.repository === repository &&
    request.title === title &&
    request.body === body
  );
}

export async function receiveQa1455Post(
  markerDirectory: string,
  url: unknown,
  init?: RequestInit,
): Promise<Response> {
  if (
    url !== 'https://api.github.com/repos/' + repository + '/issues' ||
    init?.method !== 'POST' ||
    init.body !== JSON.stringify({ title, body }) ||
    !init.signal
  )
    throw new Error('The offline QA receiver rejected a non-fixture request');
  const { signal } = init;
  signal.throwIfAborted();
  await writeFile(
    join(markerDirectory, qa1455MarkerName),
    JSON.stringify({ event: 'synthetic_post_received', fixture: 'SC-QA-1455' }) + '\n',
    { flag: 'wx' },
  );
  await setTimeout(240_000, undefined, { signal });
  // Even if the operator does not stop, this fixture can never report a posted Issue.
  throw new Error('The offline QA receiver never acknowledges a write');
}
