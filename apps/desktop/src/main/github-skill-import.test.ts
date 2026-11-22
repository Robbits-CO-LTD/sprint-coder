import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  downloadGithubSkill,
  githubSkillImportAllowed,
  githubSkillRequest,
} from './github-skill-import';

const repo = 'example/skills';
const url = 'https://github.com/' + repo;
const request = { repo, selector: '実装系' };
const revision = '1'.repeat(40);
const bytes = Buffer.from('\uFEFF---\r\nname: original\r\n---\r\n原文\n');
const sha = createHash('sha1')
  .update('blob ' + bytes.length + '\0')
  .update(bytes)
  .digest('hex');
const entry = {
  type: 'blob',
  mode: '100644',
  path: 'skills/frontend-design/SKILL.md',
  sha,
  size: bytes.length,
};
const signal = new AbortController().signal;
describe('explicit GitHub Skill install', () => {
  it('requires current acknowledged full access and honors revoked capabilities', () => {
    const full = { preset: 'full' as const, policyEpoch: 3, revokedCapabilities: [] };
    expect(githubSkillImportAllowed(full, 3, true)).toBe(true);
    for (const preset of ['ask', 'auto'] as const)
      expect(githubSkillImportAllowed({ ...full, preset }, 3, true)).toBe(false);
    expect(githubSkillImportAllowed(full, 3, false)).toBe(false);
    expect(githubSkillImportAllowed(full, 2, true)).toBe(false);
    for (const capability of ['network.fetch', 'skill.draft.write'] as const)
      expect(
        githubSkillImportAllowed({ ...full, revokedCapabilities: [capability] }, 3, true),
      ).toBe(false);
  });
  it('recognizes a direct repository request with or without a named Skill', () => {
    expect(githubSkillRequest('このリポジトリから実装系skillを入れて\n' + url)).toEqual(request);
    expect(githubSkillRequest(url + 'から frontend-design スキルを原文のまま取り込んで')).toEqual({
      repo,
      selector: 'frontend-design',
    });
    for (const prefix of [
      '入れ方を教えて ',
      '「実装系skillを入れて」 ',
      'このリポジトリから実装系skillを入れていい？ ',
      '実装系skillを入れて ' + url,
    ])
      expect(githubSkillRequest(prefix + ' ' + url)).toBeNull();
    expect(githubSkillRequest('実装系skillを入れて ' + url + '/tree/main')).toBeNull();
  });
  it('resolves a follow-up only against the repository supplied by the user', () => {
    expect(githubSkillRequest('他の実装系のskillを入れて', () => url)).toEqual({
      ...request,
      another: true,
    });
    expect(githubSkillRequest('このリポジトリから実装系skillを入れて', () => url)).toEqual(request);
    expect(
      githubSkillRequest(
        '他の実装系のskillを入れて',
        () => url + ' https://github.com/example/else',
      ),
    ).toBeNull();
  });
  it('reads descriptions before choosing and excludes an installed candidate from another request', async () => {
    const text =
      '---\nname: Workbench\ndescription: Implement and test components.\n---\nUse a working example.';
    const data = Buffer.from(text);
    const id = createHash('sha1')
      .update('blob ' + data.length + '\0')
      .update(data)
      .digest('hex');
    const tree = [
      entry,
      { ...entry, path: 'skills-archive/older/SKILL.md' },
      { ...entry, path: 'skills/opaque-id/SKILL.md', sha: id, size: data.length },
    ];
    const read = vi
      .fn()
      .mockResolvedValueOnce({ sha: revision })
      .mockResolvedValueOnce({ truncated: false, tree })
      .mockResolvedValueOnce({ encoding: 'base64', content: data.toString('base64') });
    const review = vi
      .fn()
      .mockResolvedValue({ index: 1, reason: 'コンポーネントを実装・検証できるため。' });
    const result = await downloadGithubSkill({ ...request, another: true }, signal, {
      read,
      review,
      installed: ['frontend-design'],
    });
    expect(review).toHaveBeenCalledWith(
      [{ name: 'Workbench', description: 'Implement and test components.' }],
      '実装系',
    );
    expect(result.skillId).toBe('opaque-id');
    expect(result.files[0]?.content).toBe(text);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('compares remaining candidates when a complete package fails validation, but stops on a corrupt blob', async () => {
    const blob = Buffer.from('---\nname: builder\ndescription: Implement an app.\n---\nBuild it.');
    const digest = createHash('sha1')
      .update('blob ' + blob.length + '\0')
      .update(blob)
      .digest('hex');
    const first = { ...entry, path: 'skills/builder-a/SKILL.md', sha: digest, size: blob.length };
    const second = { ...first, path: 'skills/builder-b/SKILL.md' };
    const extra = { ...entry, path: 'skills/builder-a/notes.md' };
    const review = vi.fn().mockResolvedValue({ index: 1, reason: '実装に対応' });
    const accept = vi.fn(async (id: string) => id === 'builder-b');
    for (const corrupt of [false, true]) {
      review.mockClear();
      const read = async (path: string) => {
        if (path.endsWith('/HEAD')) return { sha: revision };
        if (path.includes('/trees/')) return { truncated: false, tree: [first, second, extra] };
        const file = path.endsWith(digest) || corrupt ? blob : bytes;
        return { encoding: 'base64', content: file.toString('base64') };
      };
      const download = downloadGithubSkill(request, signal, {
        read,
        review,
        acceptsPackage: accept,
      });
      if (corrupt) {
        await expect(download).rejects.toThrow('原本と一致しません');
        expect(review).toHaveBeenCalledTimes(1);
      } else {
        expect((await download).skillId).toBe('builder-b');
        expect(accept).toHaveBeenCalledWith('builder-a', [
          { path: 'SKILL.md', content: blob.toString() },
          { path: 'notes.md', content: bytes.toString() },
        ]);
        expect(review).toHaveBeenCalledTimes(2);
      }
    }
  });
  it('keeps the original bytes at one immutable revision', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ sha: revision })
      .mockResolvedValueOnce({ truncated: false, tree: [entry] })
      .mockResolvedValueOnce({ encoding: 'base64', content: bytes.toString('base64') });
    const result = await downloadGithubSkill({ repo, selector: 'frontend-design' }, signal, {
      read,
    });
    expect(result.skillId).toBe('frontend-design');
    expect(Buffer.from(result.files[0]!.content)).toEqual(bytes);
    expect(read.mock.calls.map(([path]) => path)).toEqual([
      'repos/example/skills/commits/HEAD',
      'repos/example/skills/git/trees/' + revision + '?recursive=1',
      'repos/example/skills/git/blobs/' + sha,
    ]);
  });
  it('rejects a package with a root filename reserved for revision metadata before fetching blobs', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ sha: revision })
      .mockResolvedValueOnce({
        truncated: false,
        tree: [entry, { ...entry, path: 'skills/frontend-design/Revision.JSON' }],
      });
    await expect(
      downloadGithubSkill({ repo, selector: 'frontend-design' }, signal, { read }),
    ).rejects.toThrow('予約名');
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('rejects a partial tree, a symlink and a mismatched blob', async () => {
    for (const [truncated, mode, content] of [
      [true, '100644', bytes],
      [false, '120000', bytes],
      [false, '100644', Buffer.from('other')],
    ] as const) {
      const read = vi
        .fn()
        .mockResolvedValueOnce({ sha: revision })
        .mockResolvedValueOnce({ truncated, tree: [{ ...entry, mode }] })
        .mockResolvedValueOnce({ encoding: 'base64', content: content.toString('base64') });
      await expect(
        downloadGithubSkill({ repo, selector: 'frontend-design' }, signal, { read }),
      ).rejects.toThrow();
    }
  });
});
