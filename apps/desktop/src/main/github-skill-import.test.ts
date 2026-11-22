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
  it('keeps the original bytes at one immutable revision', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ sha: revision })
      .mockResolvedValueOnce({ truncated: false, tree: [entry] })
      .mockResolvedValueOnce({ encoding: 'base64', content: bytes.toString('base64') });
    const result = await downloadGithubSkill(request, signal, read);
    expect(result.skillId).toBe('frontend-design');
    expect(Buffer.from(result.files[0]!.content)).toEqual(bytes);
    expect(read.mock.calls.map(([path]) => path)).toEqual([
      'repos/example/skills/commits/HEAD',
      'repos/example/skills/git/trees/' + revision + '?recursive=1',
      'repos/example/skills/git/blobs/' + sha,
    ]);
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
      await expect(downloadGithubSkill(request, signal, read)).rejects.toThrow();
    }
  });
});
