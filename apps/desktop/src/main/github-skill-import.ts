import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { PermissionPolicyRecord } from './persistence';
import type { CreatedSkillFile } from './skill-store';

const run = promisify(execFile);
const githubRepo =
  /https:\/\/github\.com\/([a-z\d][a-z\d-]{0,38})\/([a-z\d_.-]{1,100})(?:\/(?![a-z\d._/%?#-]))?(?![a-z\d._/%?#@:-])/giu;
const skillName = '[a-z0-9][a-z0-9._-]{0,127}';
const requestPattern = new RegExp(
  '^(?:(?:この|指定の|こちらの)?(?:GitHubの)?リポジトリ(?:から|内の|の))?' +
    '(?:から)?(?:Sprint\\s*Coderに)?(実装(?:系|用|向け)?(?:の)?|フロントエンド(?:実装)?(?:用|系|の)?|' +
    skillName +
    '(?:の)?)?' +
    '(?:skills?|スキル)(?:を)?(?:一つ|ひとつ|1つ|1件)?(?:Sprint\\s*Coderに)?(?:原文のまま)?(?:(?:取得|ダウンロード)して)?' +
    '(?:入れて|取り込んで|導入して|インストールして|登録して)(?:ください|下さい|ほしい|欲しい)?[。！!]?$',
  'iu',
);

export type GithubSkillRequest = { repo: string; selector: string };

export function githubSkillRequest(text: string): GithubSkillRequest | null {
  // Only an entire, imperative user message authorizes a persistent install. Quoted examples,
  // questions, conditions and additional instructions stay in the ordinary chat.
  const normalized = text.trim().replace(/\[(https:\/\/github\.com\/[^\s\]]+)\]\(\1\)/giu, '$1');
  const urls = [...normalized.matchAll(githubRepo)];
  const url = urls[0];
  if (urls.length !== 1 || !url) return null;
  const repository = url[2]!.replace(/\.git$/iu, '');
  if (!repository || repository === '.' || repository === '..') return null;
  const rest = normalized.replace(url[0], '').replace(/\s+/gu, '');
  const intent = requestPattern.exec(rest);
  if (!intent) return null;
  return { repo: url[1] + '/' + repository, selector: (intent[1] ?? '').replace(/の$/u, '') };
}

export class GithubSkillImportError extends Error {}

export function githubSkillImportAllowed(
  policy: Pick<PermissionPolicyRecord, 'preset' | 'policyEpoch' | 'revokedCapabilities'>,
  epoch: number,
  fullAccessAcknowledged: boolean,
) {
  return (
    policy.preset === 'full' &&
    policy.policyEpoch === epoch &&
    fullAccessAcknowledged &&
    !policy.revokedCapabilities.includes('network.fetch') &&
    !policy.revokedCapabilities.includes('skill.draft.write')
  );
}

const hash = z.string().regex(/^[a-f0-9]{40}$/u);
const treeSchema = z.object({
  truncated: z.literal(false),
  tree: z.array(
    z.object({
      path: z.string(),
      type: z.string(),
      mode: z.string(),
      sha: hash,
      size: z.number().int().nonnegative().optional(),
    }),
  ),
});
type ApiRead = (path: string, signal: AbortSignal) => Promise<unknown>;

const githubApi: ApiRead = async (path, signal) => {
  try {
    // Fixed API host and argument vector. The CLI authenticates locally; neither credentials nor
    // the repository contents go into a model prompt or subprocess command line.
    const { stdout } = await run(
      process.platform === 'win32' ? 'gh.exe' : 'gh',
      ['api', '--hostname', 'github.com', path],
      {
        cwd: homedir(),
        windowsHide: true,
        signal,
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      },
    );
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new GithubSkillImportError(
      'GitHubから取得できません。GitHub CLI（gh）のインストールと、このリポジトリを読めるアカウントでのログインを確認してください。',
    );
  }
};

function chooseSkill(paths: string[], selector: string): string {
  const candidates = paths
    .filter((path) => /(?:^|\/)SKILL\.md$/u.test(path))
    .map((path) => path.slice(0, -'SKILL.md'.length));
  const nameOf = (dir: string) => dir.split('/').at(-2) ?? '';
  const byLocation = (dir: string) => (dir.startsWith('skills/') ? 0 : 1);
  const byPurpose = (dir: string) => {
    const name = nameOf(dir);
    if (!selector) return 0;
    if (!/^(?:実装|フロントエンド)/u.test(selector))
      return name.toLowerCase() === selector.toLowerCase() ? 0 : 99;
    if (/^(?:front-?end)(?:[-_](?:design|implement(?:ation)?|development))?$/iu.test(name))
      return 0;
    if (selector.startsWith('フロントエンド')) return 99;
    return /(?:^|[-_])(?:implement(?:ation)?|fullstack|backend|coding)(?:$|[-_])/iu.test(name)
      ? 1
      : 99;
  };
  const matches = candidates
    .filter((dir) => byPurpose(dir) < 99)
    .sort(
      (a, b) =>
        byPurpose(a) - byPurpose(b) ||
        byLocation(a) - byLocation(b) ||
        a.length - b.length ||
        a.localeCompare(b, 'en'),
    );
  if (!matches.length || (!selector && matches.length > 1))
    throw new GithubSkillImportError(
      '対象のSkillを特定できません。リポジトリのURLと「frontend-design スキルを入れて」のようにSkill名を指定してください。',
    );
  return matches[0]!;
}

export async function downloadGithubSkill(
  request: GithubSkillRequest,
  signal: AbortSignal,
  read: ApiRead = githubApi,
) {
  const base = 'repos/' + request.repo;
  const revision = z.object({ sha: hash }).parse(await read(base + '/commits/HEAD', signal)).sha;
  const tree = treeSchema.safeParse(
    await read(base + '/git/trees/' + revision + '?recursive=1', signal),
  );
  if (!tree.success)
    throw new GithubSkillImportError('GitHubのファイル一覧を完全に取得できません。');
  const dir = chooseSkill(
    tree.data.tree.filter((e) => e.type === 'blob').map((e) => e.path),
    request.selector,
  );
  const entries = tree.data.tree.filter((e) => e.path.startsWith(dir) && e.type !== 'tree');
  if (
    !entries.length ||
    entries.length > 256 ||
    entries.some(
      (e) =>
        e.path.includes('\\') ||
        e.type !== 'blob' ||
        !/^100(?:644|755)$/u.test(e.mode) ||
        e.size === undefined ||
        e.size > 1024 * 1024,
    ) ||
    entries.reduce((sum, e) => sum + (e.size ?? 0), 0) > 8 * 1024 * 1024
  )
    throw new GithubSkillImportError(
      'Skillに取り込めないリンク・特殊ファイルがあるか、サイズの上限を超えています。',
    );
  const files: CreatedSkillFile[] = [];
  for (const entry of entries) {
    signal.throwIfAborted();
    const blob = z
      .object({ encoding: z.literal('base64'), content: z.string() })
      .parse(await read(base + '/git/blobs/' + entry.sha, signal));
    const bytes = Buffer.from(blob.content, 'base64');
    const digest = createHash('sha1')
      .update('blob ' + bytes.length + '\0')
      .update(bytes)
      .digest('hex');
    if (bytes.length !== entry.size || digest !== entry.sha)
      throw new GithubSkillImportError('取得したファイルがGitHubの原本と一致しません。');
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes) || content.includes('\0'))
      throw new GithubSkillImportError('バイナリファイルを含むSkillを原文のまま登録できません。');
    files.push({ path: entry.path.slice(dir.length), content });
  }
  const skillId = dir.split('/').at(-2) || request.repo.split('/')[1]!;
  return { skillId, files, revision, dir };
}
