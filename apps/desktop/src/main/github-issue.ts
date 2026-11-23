import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { parseGithubIssueRepository, type GithubIssueRequest } from '../github-issue-request';
import { environmentValue } from '../runtime-host/cli-command-resolution';
import { buildControlledEnvironment, resolveBareExecutable } from './command-runner';

const run = promisify(execFile);
const issueResult = z.object({
  number: z.number().int().positive(),
  repository_url: z.string(),
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

export async function createGithubIssue(
  request: GithubIssueRequest,
  signal: AbortSignal,
  canPost: () => boolean,
  deps: { readToken: typeof githubLoginToken; fetch: typeof fetch } = {
    readToken: githubLoginToken,
    fetch,
  },
): Promise<string> {
  if (parseGithubIssueRepository(request.repository) !== request.repository)
    throw new GithubIssueError('GitHubのリポジトリ名を確認してください。Issueは送信していません。');
  let token: string;
  try {
    token = await deps.readToken(signal);
    signal.throwIfAborted();
  } catch {
    throw new GithubIssueError(
      'GitHubのログインを確認できませんでした。GitHub CLI（gh）でログイン済みか確認してください。Issueは送信していません。',
    );
  }

  if (!canPost())
    throw new GithubIssueError('タスクの状態や権限が変わりました。Issueは送信していません。');
  const repository = `https://api.github.com/repos/${request.repository}`;
  const response = await deps
    .fetch(`${repository}/issues`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Sprint-Coder',
      },
      body: JSON.stringify({ title: request.title, body: request.body }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
    .catch(() => {
      throw new GithubIssueError(
        'GitHubから起票結果を確認できませんでした。二重投稿を避けるため、再送する前にリポジトリのIssue一覧を確認してください。',
      );
    });
  if (response.status !== 201) {
    await response.body?.cancel().catch(() => undefined);
    throw new GithubIssueError(
      response.status >= 500
        ? 'GitHubから起票結果を確認できませんでした。再送する前にIssue一覧を確認してください。'
        : 'GitHubがIssueを受け付けませんでした。リポジトリ名・アクセス権・Issueの設定を確認してください。',
    );
  }
  const result = issueResult.safeParse(await response.json().catch(() => null));
  if (!result.success || result.data.repository_url.toLowerCase() !== repository.toLowerCase())
    throw new GithubIssueError(
      'GitHubから起票先を確認できませんでした。再送する前にIssue一覧を確認してください。',
    );
  return `https://github.com/${request.repository}/issues/${result.data.number}`;
}
