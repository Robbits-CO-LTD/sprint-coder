import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  isGithubBranchName,
  parseGithubIssueRepository,
  type GithubWriteRequest,
} from '../github-issue-request';
import { environmentValue } from '../runtime-host/cli-command-resolution';
import { buildControlledEnvironment, resolveBareExecutable } from './command-runner';

const run = promisify(execFile);
const issueResult = z.object({
  number: z.number().int().positive(),
  repository_url: z.string(),
});
const commentResult = z.object({ id: z.number().int().positive(), issue_url: z.string() });
const pullBranch = z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) });
const pullResult = z.object({
  number: z.number().int().positive(),
  head: pullBranch,
  base: pullBranch,
});

export class GithubIssueError extends Error {}

export function githubLoginEnvironment(
  platform: NodeJS.Platform = process.platform,
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  if (platform !== 'win32') env.PATH = buildControlledEnvironment(platform, {}).PATH;
  const loginKeys = [
    'HOME',
    'GH_CONFIG_DIR',
    'XDG_CONFIG_HOME',
    ...(platform === 'win32'
      ? ['SYSTEMROOT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']
      : []),
    ...(platform === 'linux' ? ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'] : []),
  ];
  for (const key of loginKeys) {
    const value = environmentValue(source, key, platform);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function githubLoginToken(signal: AbortSignal): Promise<string> {
  const env = githubLoginEnvironment();
  const paths = [
    environmentValue(process.env, 'PATH') ?? '',
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []),
  ];
  // Win32's bare-executable lookup tries the working directory before PATH.
  const executable = await resolveBareExecutable(process.platform === 'win32' ? 'gh.exe' : 'gh', {
    PATH: paths.join(delimiter),
  });
  signal.throwIfAborted();
  const { stdout } = await run(executable, ['auth', 'token', '--hostname', 'github.com'], {
    cwd: homedir(),
    env,
    signal,
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 4096,
  });
  const token = stdout.trim();
  if (!/^[a-z\d_]{1,512}$/iu.test(token)) throw new Error('Unexpected GitHub credential');
  return token;
}

export async function writeGithubContent(
  request: GithubWriteRequest,
  signal: AbortSignal,
  canPost: () => boolean,
  options: {
    readToken?: typeof githubLoginToken;
    fetch?: typeof fetch;
    onPostStarted?: (stopNotice: string) => void;
  } = {},
): Promise<string> {
  const { readToken = githubLoginToken, fetch: fetchRequest = fetch, onPostStarted } = options;
  if (parseGithubIssueRepository(request.repository) !== request.repository)
    throw new GithubIssueError(
      'GitHubのリポジトリ名を確認してください。GitHubには送信していません。',
    );
  if (
    (request.action === 'comment' &&
      (!Number.isSafeInteger(request.issueNumber) || request.issueNumber < 1)) ||
    (request.action === 'pull' &&
      (request.head === request.base ||
        !isGithubBranchName(request.head) ||
        !isGithubBranchName(request.base)))
  )
    throw new GithubIssueError('GitHubへの送信先を確認してください。投稿は行っていません。');
  let token: string;
  try {
    token = await readToken(signal);
    signal.throwIfAborted();
  } catch {
    throw new GithubIssueError(
      'GitHubのログインを確認できませんでした。GitHub CLI（gh）でログイン済みか確認してください。投稿は行っていません。',
    );
  }

  if (!canPost())
    throw new GithubIssueError('タスクの状態や権限が変わりました。GitHubには送信していません。');
  const repository = `https://api.github.com/repos/${request.repository}`;
  const webRepository = `https://github.com/${request.repository}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'Sprint-Coder',
  };
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const issueUrl =
    request.action === 'comment' ? `${repository}/issues/${request.issueNumber}` : null;
  if (issueUrl !== null && request.action === 'comment') {
    const issueResponse = await fetchRequest(issueUrl, {
      method: 'GET',
      redirect: 'error',
      headers,
      signal: requestSignal,
    }).catch(() => null);
    const issue = z
      .object({
        number: z.number(),
        repository_url: z.string(),
        pull_request: z.unknown().optional(),
      })
      .safeParse(await issueResponse?.json().catch(() => null));
    if (
      !issueResponse?.ok ||
      !issue.success ||
      issue.data.number !== request.issueNumber ||
      issue.data.repository_url.toLowerCase() !== repository.toLowerCase() ||
      issue.data.pull_request !== undefined
    )
      throw new GithubIssueError(
        '送信先のIssueを確認できませんでした。コメントは投稿していません。',
      );
  }
  const endpoint =
    request.action === 'comment'
      ? `${issueUrl}/comments`
      : `${repository}/${request.action === 'pull' ? 'pulls' : 'issues'}`;
  const payload =
    request.action === 'comment'
      ? { body: request.body }
      : request.action === 'issue'
        ? { title: request.title, body: request.body }
        : { title: request.title, body: request.body, head: request.head, base: request.base };
  const location =
    request.action === 'comment'
      ? '送信先Issueのコメント欄'
      : request.action === 'pull'
        ? 'リポジトリのPR一覧'
        : 'リポジトリのIssue一覧';
  requestSignal.throwIfAborted();
  if (!canPost())
    throw new GithubIssueError(
      request.action === 'comment'
        ? 'タスクの状態や権限が変わりました。コメントは投稿していません。'
        : 'タスクの状態や権限が変わりました。GitHubには送信していません。',
    );
  const unknownResult = `GitHubから結果を確認できませんでした。二重投稿を避けるため、再送する前に${location}を確認してください。`;
  // The approval and abort checks above must stay in the same synchronous step as dispatch.
  onPostStarted?.(unknownResult);
  const response = await fetchRequest(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers,
    body: JSON.stringify(payload),
    signal: requestSignal,
  }).catch(() => {
    throw new GithubIssueError(unknownResult);
  });
  if (response.status !== 201) {
    await response.body?.cancel().catch(() => undefined);
    throw new GithubIssueError(
      response.status >= 500
        ? `GitHubから結果を確認できませんでした。再送する前に${location}を確認してください。`
        : 'GitHubが投稿を受け付けませんでした。宛先・アクセス権・リポジトリの設定を確認してください。',
    );
  }
  const returned: unknown = await response.json().catch(() => null);
  if (request.action === 'issue') {
    const result = issueResult.safeParse(returned);
    if (result.success && result.data.repository_url.toLowerCase() === repository.toLowerCase())
      return `${webRepository}/issues/${result.data.number}`;
  } else if (request.action === 'comment') {
    const result = commentResult.safeParse(returned);
    if (result.success && result.data.issue_url.toLowerCase() === issueUrl?.toLowerCase())
      return `${webRepository}/issues/${request.issueNumber}#issuecomment-${result.data.id}`;
  } else {
    const result = pullResult.safeParse(returned);
    if (
      result.success &&
      result.data.head.ref === request.head &&
      result.data.base.ref === request.base &&
      [result.data.head, result.data.base].every(
        ({ repo }) => repo.full_name.toLowerCase() === request.repository.toLowerCase(),
      )
    )
      return `${webRepository}/pull/${result.data.number}`;
  }
  throw new GithubIssueError(
    `GitHubから送信結果を確認できませんでした。再送する前に${location}を確認してください。`,
  );
}
