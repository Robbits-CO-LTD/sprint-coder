export type GithubIssueRequest = Readonly<{ repository: string; title: string; body: string }>;

export const GITHUB_ISSUE_INPUT_EXAMPLE = [
  'https://github.com/<所有者>/<リポジトリ> に Issue を起票して',
  'タイトル: 設定を開くと画面が固まる',
  '本文: 新しいタスクを作ってから設定を開くと、画面が応答しなくなります。',
].join('\n');

export const GITHUB_ISSUE_INPUT_HELP = [
  'GitHubに送る前に、投稿先・タイトル・本文を指定してください。タイトルは120文字以内、本文は8行・500文字以内です。',
  '',
  '```text',
  GITHUB_ISSUE_INPUT_EXAMPLE,
  '```',
].join('\n');

const requestLine =
  /^(?:(.*?)\s*(?:に|へ)\s*)?(?:(?:GitHub(?:\s+CLI)?|gh)\s*(?:の|で)?\s*)?Issue\s*を\s*(?:起票|作成)して(?:ください)?[。！!]?$/iu;
const repositoryName =
  /^(?:https:\/\/github\.com\/)?([a-z\d][a-z\d-]{0,38})\/([a-z\d_.-]{1,100})\/?$/iu;
const fields = /^タイトル[ \t]*[:：][ \t]*([^\n]+)\n本文[ \t]*[:：][ \t]*([\s\S]*)$/u;
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
export function parseGithubIssueInput(
  text: string,
): { kind: 'incomplete' } | { kind: 'create'; request: GithubIssueRequest } | null {
  const [first = '', ...other] = text.replace(/\r\n/g, '\n').trim().split('\n');
  const action = requestLine.exec(first.trim());
  if (!action) return null;
  const repository = parseGithubIssueRepository(action[1]?.trim() ?? '');
  const details = fields.exec(other.join('\n'));
  if (!repository || !details) return { kind: 'incomplete' };
  const title = details[1]!.trim();
  const body = details[2]!;
  if (
    title.length === 0 ||
    title.length > 120 ||
    body.length > 500 ||
    body.split('\n').length > 8 ||
    containsHiddenControls(title) ||
    containsHiddenControls(body)
  )
    return { kind: 'incomplete' };
  return { kind: 'create', request: { repository, title, body } };
}
