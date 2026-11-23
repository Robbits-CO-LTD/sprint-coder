export type GithubAction = 'issue' | 'comment' | 'pull';
export type GithubWriteRequest = Readonly<{ repository: string; body: string }> &
  (
    | Readonly<{ action: 'issue'; title: string }>
    | Readonly<{ action: 'comment'; issueNumber: number }>
    | Readonly<{ action: 'pull'; title: string; head: string; base: string }>
  );

export const GITHUB_ISSUE_INPUT_EXAMPLE = [
  'https://github.com/<所有者>/<リポジトリ> に Issue を起票して',
  'タイトル: 設定を開くと画面が固まる',
  '本文: 新しいタスクを作ってから設定を開くと、画面が応答しなくなります。',
].join('\n');

export const GITHUB_INPUT_EXAMPLES: Record<GithubAction, string> = {
  issue: GITHUB_ISSUE_INPUT_EXAMPLE,
  comment:
    'https://github.com/<所有者>/<リポジトリ>/issues/42 にコメントして\n本文: Windowsでも再現しました。',
  pull: 'https://github.com/<所有者>/<リポジトリ> に PR を作成して\n元ブランチ: fix-settings\n先ブランチ: main\nタイトル: 設定画面の修正\n本文: 設定を開くと固まる不具合を直しました。',
};

export function githubInputHelp(action: GithubAction): string {
  return [
    'GitHubへの送信先と本文を入力してください。タイトルは120文字以内、本文は8行・500文字以内です。',
    ...(action === 'pull'
      ? ['元と先は、同じリポジトリのGitHub上にある別々のブランチを指定してください。']
      : []),
    '',
    '```text',
    GITHUB_INPUT_EXAMPLES[action],
    '```',
  ].join('\n');
}

const issueLine =
  /^(?:(.*?)\s*(?:に|へ)\s*)?(?:(?:GitHub(?:\s+CLI)?|gh)\s*(?:の|で)?\s*)?Issue\s*を\s*(?:起票|作成)して(?:ください)?[。！!]?$/iu;
const repositoryName =
  /^(?:https:\/\/github\.com\/)?([a-z\d][a-z\d-]{0,38})\/([a-z\d_.-]{1,100})\/?$/iu;
const fields = /^タイトル[ \t]*[:：][ \t]*([^\n]+)\n本文[ \t]*[:：][ \t]*([\s\S]*)$/u;
const commentLine =
  /^(?:(.+?)\s*(?:に|へ)\s*)?(?:GitHub\s*(?:の|で)?\s*)?(?:Issue\s*に\s*)?コメント\s*(?:を\s*投稿)?して(?:ください)?[。！!]?$/iu;
const explicitCommentLine =
  /^(?:(?:GitHub\s*(?:の|で)?\s*)?Issue\s*に|GitHub\s*(?:に|で))\s*コメント\s*(?:を\s*投稿)?して(?:ください)?[。！!]?$/iu;
const issueTargetPattern =
  /^(https:\/\/github\.com\/[^/\s]+\/[^/\s]+)\/issues\/([1-9]\d{0,9})\/?$/iu;
const pullLine =
  /^(?:(.*?)\s*(?:に|へ)\s*)?(?:GitHub\s*(?:の|で)?\s*)?(?:PR|Pull Request|プルリクエスト)\s*を\s*作成して(?:ください)?[。！!]?$/iu;
const commentFields = /^本文[ \t]*[:：][ \t]*([\s\S]*)$/u;
const pullFields =
  /^元ブランチ[ \t]*[:：][ \t]*([^\n]+)\n先ブランチ[ \t]*[:：][ \t]*([^\n]+)\n([\s\S]*)$/u;
function containsHiddenControls(value: string): boolean {
  return (
    /[\u202A-\u202E\u2066-\u2069]/u.test(value) ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && character !== '\n' && character !== '\t') || code === 127;
    })
  );
}

export function parseGithubIssueRepository(value: string): string | null {
  const repo = repositoryName.exec(value);
  return repo && repo[2] !== '.' && repo[2] !== '..' ? repo[1] + '/' + repo[2] : null;
}

/** Exact first-line intent only. Examples and questions may discuss Issues without asking to post. */
export function isGithubBranchName(value: string): boolean {
  return (
    /^[a-z\d_][a-z\d_./-]{0,119}$/iu.test(value) &&
    !value.includes('..') &&
    !value.startsWith('refs/') &&
    value
      .split('/')
      .every(
        (part) =>
          part.length > 0 &&
          !part.startsWith('.') &&
          !part.endsWith('.') &&
          !part.endsWith('.lock'),
      )
  );
}

export function parseGithubActionInput(
  text: string,
):
  | { kind: 'incomplete'; action: GithubAction }
  | { kind: 'create'; request: GithubWriteRequest }
  | null {
  const [first = '', ...other] = text.replace(/\r\n/g, '\n').trim().split('\n');
  const namedLine = first.trim();
  const issue = issueLine.exec(namedLine);
  const pull = pullLine.exec(namedLine);
  const comment = commentLine.exec(namedLine);
  // A copied GitHub link can point at a comment or carry query parameters on the same Issue.
  const issuePath = comment?.[1]?.trim().split(/[?#]/u, 1)[0] ?? '';
  const issueTarget = issueTargetPattern.exec(issuePath);
  // File paths may include “github” or “issue”; only an Issue URL or explicit intent opts in.
  if (!issue && !pull && (!comment || (!issueTarget && !explicitCommentLine.test(namedLine))))
    return null;
  const action = issue ? 'issue' : pull ? 'pull' : 'comment';
  const incomplete = { kind: 'incomplete', action } as const;
  const content = other.join('\n');
  if (action === 'comment') {
    const repository = parseGithubIssueRepository(issueTarget?.[1] ?? '');
    const body = commentFields.exec(content)?.[1];
    if (!repository || !validBody(body)) return incomplete;
    return {
      kind: 'create',
      request: { action, repository, issueNumber: Number(issueTarget?.[2]), body },
    };
  }
  const repository = parseGithubIssueRepository((issue ?? pull)?.[1]?.trim() ?? '');
  const branches = action === 'pull' ? pullFields.exec(content) : null;
  const details = fields.exec(action === 'pull' ? (branches?.[3] ?? '') : content);
  const title = details?.[1]?.trim();
  const body = details?.[2];
  if (
    !repository ||
    !title ||
    title.length > 120 ||
    containsHiddenControls(title) ||
    !validBody(body)
  )
    return incomplete;
  if (action === 'issue') return { kind: 'create', request: { action, repository, title, body } };
  const head = branches?.[1]?.trim() ?? '';
  const base = branches?.[2]?.trim() ?? '';
  if (head === base || !isGithubBranchName(head) || !isGithubBranchName(base)) return incomplete;
  return { kind: 'create', request: { action, repository, title, body, head, base } };
}

function validBody(body: string | undefined): body is string {
  return (
    body !== undefined &&
    body.trim().length > 0 &&
    body.length <= 500 &&
    body.split('\n').length <= 8 &&
    !containsHiddenControls(body)
  );
}
