import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { PermissionPolicyRecord } from './persistence';
import {
  containsSkillCredential,
  MAX_EXECUTABLE_SKILL_CHARACTERS,
  type CreatedSkillFile,
} from './skill-store';
import { analyzeSkillPackage } from './skill-compatibility';

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

export type GithubSkillRequest = { repo: string; selector: string; another?: boolean };

function repositoryIn(text: string) {
  const normalized = text.trim().replace(/\[(https:\/\/github\.com\/[^\s\]]+)\]\(\1\)/giu, '$1');
  const urls = [...normalized.matchAll(githubRepo)];
  const match = urls[0];
  if (urls.length !== 1 || !match) return null;
  const repository = match[2]!.replace(/\.git$/iu, '');
  if (!repository || repository === '.' || repository === '..') return null;
  return { repo: match[1] + '/' + repository, rest: normalized.replace(match[0], '') };
}

export function githubSkillRequest(
  text: string,
  previousUserMessage?: () => string | undefined,
): GithubSkillRequest | null {
  const direct = repositoryIn(text);
  const rest = (direct?.rest ?? text).replace(/\s+/gu, '');
  const another = /^(?:(?:このリポジトリ)?から)?(?:ほか|他|別)の/u.test(rest);
  const intent = requestPattern.exec(another ? rest.replace(/(?:ほか|他|別)の/u, '') : rest);
  if (!intent) return null;
  // Only a repository named by the person in this chat may resolve a follow-up.
  const source =
    direct ??
    (another || rest.startsWith('このリポジトリ')
      ? repositoryIn(previousUserMessage?.() ?? '')
      : null);
  if (!source) return null;
  return {
    repo: source.repo,
    selector: (intent[1] ?? '').replace(/の$/u, ''),
    ...(another ? { another: true } : {}),
  };
}

export class GithubSkillImportError extends Error {}
class UnsupportedPackageError extends GithubSkillImportError {}

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
    // Fixed API host and argument vector. The CLI authenticates locally; credentials and repository files
    // are never passed on a subprocess command line.
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

type TreeEntry = z.infer<typeof treeSchema>['tree'][number];
export type SkillCandidate = { name: string; description: string };
export type SkillComparison = { index: number; reason: string };
export type SkillReviewer = (
  candidates: SkillCandidate[],
  purpose: string,
) => Promise<SkillComparison>;
function packageEntries(tree: TreeEntry[], dir: string) {
  return tree.filter((e) => e.path.startsWith(dir) && e.type !== 'tree');
}
function supported(entries: TreeEntry[], dir: string) {
  return (
    entries.length > 0 &&
    entries.length <= 256 &&
    entries.every(
      (e) =>
        !e.path.includes('\\') &&
        !/^(?:manifest|revision)\.json(?:\/|$)/iu.test(e.path.slice(dir.length)) &&
        e.type === 'blob' &&
        /^100(?:644|755)$/u.test(e.mode) &&
        e.size !== undefined &&
        e.size <= 1024 * 1024,
    ) &&
    entries.reduce((sum, e) => sum + (e.size ?? 0), 0) <= 8 * 1024 * 1024
  );
}
async function readOriginal(base: string, entry: TreeEntry, signal: AbortSignal, read: ApiRead) {
  signal.throwIfAborted();
  const blob = z
    .object({ encoding: z.literal('base64'), content: z.string() })
    .parse(await read(base + '/git/blobs/' + entry.sha, signal));
  const bytes = Buffer.from(blob.content, 'base64');
  if (
    bytes.length !== entry.size ||
    createHash('sha1')
      .update('blob ' + bytes.length + '\0')
      .update(bytes)
      .digest('hex') !== entry.sha
  )
    throw new GithubSkillImportError('取得したファイルがGitHubの原本と一致しません。');
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes) || content.includes('\0'))
    throw new UnsupportedPackageError('バイナリファイルを含むSkillを原文のまま登録できません。');
  return content;
}
export async function downloadGithubSkill(
  request: GithubSkillRequest,
  signal: AbortSignal,
  options: {
    read?: ApiRead;
    review?: SkillReviewer;
    progress?: (text: string) => void;
    acceptsPackage?: (skillId: string, files: readonly CreatedSkillFile[]) => Promise<boolean>;
    installed?: readonly string[];
    checkPermission?: () => void;
  } = {},
) {
  const { review, progress, installed = [] } = options;
  const read: ApiRead = (path, signal) => {
    signal.throwIfAborted();
    options.checkPermission?.();
    return (options.read ?? githubApi)(path, signal);
  };
  const base = 'repos/' + request.repo;
  const revision = z.object({ sha: hash }).parse(await read(base + '/commits/HEAD', signal)).sha;
  const tree = treeSchema.safeParse(
    await read(base + '/git/trees/' + revision + '?recursive=1', signal),
  );
  if (!tree.success)
    throw new GithubSkillImportError('GitHubのファイル一覧を完全に取得できません。');
  const entries = tree.data.tree;
  const manifests = entries.filter((e) => /(?:^|\/)SKILL\.md$/u.test(e.path) && e.type === 'blob');
  const directory = (entry: TreeEntry) => entry.path.slice(0, -'SKILL.md'.length);
  const folderName = (entry: TreeEntry) =>
    directory(entry).split('/').at(-2) || request.repo.split('/')[1]!;
  const canonical = new Map<string, TreeEntry>();
  for (const entry of manifests.sort(
    (a, b) =>
      Number(!a.path.startsWith('skills/')) - Number(!b.path.startsWith('skills/')) ||
      a.path.length - b.path.length,
  )) {
    const id = folderName(entry).toLowerCase();
    if (!canonical.has(id)) canonical.set(id, entry);
  }
  const materials = new Map<string, string>();
  async function downloadPackage(chosen: TreeEntry, reason: string, compared: number) {
    const dir = directory(chosen);
    const selected = packageEntries(entries, dir);
    if (!supported(selected, dir))
      throw new UnsupportedPackageError(
        'Skillに管理用の予約名・リンク・特殊ファイルがあるか、サイズの上限を超えています。',
      );
    const skillId = folderName(chosen);
    progress?.('「' + skillId + '」の全ファイルを原本と照合します。');
    const files: CreatedSkillFile[] = [];
    for (const e of selected)
      files.push({
        path: e.path.slice(dir.length),
        content: materials.get(e.sha) ?? (await readOriginal(base, e, signal, read)),
      });
    if (
      files.some((f) => f.path === 'SKILL.md' && f.content.length > MAX_EXECUTABLE_SKILL_CHARACTERS)
    )
      throw new UnsupportedPackageError('SKILL.mdがSprint Coderで実行できる文字数を超えています。');
    return { skillId, files, revision, dir, reason, compared };
  }
  if (/^(?:実装|フロントエンド)/u.test(request.selector)) {
    if (!review) throw new GithubSkillImportError('候補の説明を比較するモデルを利用できません。');
    const available = [...canonical.values()];
    const published = available.filter((e) => /(?:^|\/)skills\/[^/]+\/SKILL\.md$/u.test(e.path));
    const inventory = (
      published.length
        ? published
        : available.filter((e) => !/(?:^|[/_-])archive(?:d|s)?(?:[/_-]|$)/iu.test(e.path))
    ).filter((e) => !request.another || !installed.includes(folderName(e)));
    if (
      inventory.length > 512 ||
      inventory.reduce((sum, e) => sum + (e.size ?? 0), 0) > 32 * 1024 * 1024
    )
      throw new GithubSkillImportError(
        '候補が調査の上限を超えています。Skill名を指定してください。',
      );
    progress?.(
      inventory.length + '件のSkill候補を見つけました。SKILL.mdの説明と対応形式を調べます。',
    );
    const candidates: { entry: TreeEntry; metadata: SkillCandidate }[] = [];
    for (let offset = 0; offset < inventory.length; offset += 5) {
      const batch = await Promise.all(
        inventory.slice(offset, offset + 5).map(async (entry) => {
          const dir = directory(entry);
          const files = packageEntries(entries, dir);
          if (
            !supported(files, dir) ||
            files.some((e) => e.path.slice(dir.length) === 'team/blueprint.json')
          )
            return;
          let content: string;
          try {
            content = await readOriginal(base, entry, signal, read);
          } catch (error) {
            if (error instanceof UnsupportedPackageError) return;
            throw error;
          }
          try {
            const parsed = analyzeSkillPackage(Buffer.from(content));
            if (
              content.length > MAX_EXECUTABLE_SKILL_CHARACTERS ||
              parsed.compatibility.requiresConversion ||
              containsSkillCredential(content) ||
              containsSkillCredential(parsed.name + '\n' + parsed.description)
            )
              return;
            const relevant = request.selector.startsWith('フロントエンド')
              ? /front.?end|user interface|web (?:app|page)|フロントエンド|画面(?:設計|実装)/iu
              : /実装|コーディング|開発|アプリ.{0,8}(?:構築|作成)|implement|coding|front.?end|build.{0,40}(?:apps?|interfaces?|websites?)/iu;
            if (!relevant.test(parsed.description)) return;
            materials.set(entry.sha, content);
            return { entry, metadata: { name: parsed.name, description: parsed.description } };
          } catch {
            return;
          }
        }),
      );
      for (const candidate of batch) if (candidate) candidates.push(candidate);
    }
    if (!candidates.length)
      throw new GithubSkillImportError('原文のまま取り込めるChat Skillが見つかりません。');
    const compared = candidates.length;
    progress?.(compared + '件の名前と説明を、選択中のモデルで比較します。');
    while (candidates.length) {
      const decision = await review(
        candidates.map((c) => c.metadata),
        request.selector,
      );
      const chosen = candidates[decision.index - 1];
      if (!chosen) break;
      try {
        const candidate = await downloadPackage(chosen.entry, decision.reason, compared);
        if (
          !options.acceptsPackage ||
          (await options.acceptsPackage(candidate.skillId, candidate.files))
        )
          return candidate;
      } catch (error) {
        if (!(error instanceof UnsupportedPackageError)) throw error;
      }
      candidates.splice(decision.index - 1, 1);
      progress?.(
        '「' + folderName(chosen.entry) + '」は原文のまま登録できないため、候補から除きました。',
      );
    }
    throw new GithubSkillImportError('依頼に合う登録可能な候補が見つかりませんでした。');
  }
  const chosen = request.selector
    ? canonical.get(request.selector.toLowerCase())
    : canonical.size === 1
      ? [...canonical.values()][0]
      : undefined;
  if (!chosen)
    throw new GithubSkillImportError(
      '対象を特定できません。リポジトリのURLとSkill名を指定してください。',
    );
  return downloadPackage(chosen, '', 0);
}
