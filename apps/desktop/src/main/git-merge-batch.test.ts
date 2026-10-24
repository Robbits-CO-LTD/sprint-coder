import { describe, expect, it } from 'vitest';
import { parseGitCommitMetadata, parseGitMergeTrees } from './git-merge-batch';

const a = 'a'.repeat(40);
const b = 'b'.repeat(40);
const c = 'c'.repeat(40);
describe('Git batch records', () => {
  it('keeps history order and the first parent, including root and merge commits', () => {
    expect(parseGitCommitMetadata(`${a}\0\0${b}\n${b}\0${a} ${c}\0${c}\n`)).toEqual([
      { head: a, firstParent: null, tree: b },
      { head: b, firstParent: a, tree: c },
    ]);
    expect(parseGitCommitMetadata('')).toEqual([]);
  });
  it.each([
    `${a}\0${b}\0${c}`,
    `${a}\0${b}\0${c}\0\n`,
    `${a}\0?\0${c}\n`,
    `${a}\0${b}\0${c}\n${a}\0${b}\0${c}\n`,
    `${a}\0${b}\0${c}\nextra\n`,
  ])('rejects malformed metadata %#', (value) => {
    expect(parseGitCommitMetadata(value)).toBeNull();
  });
  it('parses every clean/conflict record, including newline-containing conflict paths', () => {
    expect(
      parseGitMergeTrees(`1\0${a}\0\0` + `0\0${b}\0a\nb.txt\0other\0\0` + `1\0${c}\0\0`, 3),
    ).toEqual([a, null, c]);
  });
  it.each([
    `1\0${a}\0`,
    `1\0${a}\0\0extra`,
    `2\0${a}\0\0`,
    `1\0?\0\0`,
    `1\0${a}\0\0` + `1\0${b}\0\0`,
  ])('rejects incomplete/extra batch output %#', (value) => {
    expect(parseGitMergeTrees(value, 1)).toBeNull();
  });
  it('does not accept an early match before a malformed later record', () => {
    expect(parseGitMergeTrees(`1\0${a}\0\0` + `1\0${b}\0`, 2)).toBeNull();
  });
  it('accepts SHA-256 object identities', () => {
    const hash = 'a'.repeat(64);
    expect(parseGitCommitMetadata(`${hash}\0${hash}\0${hash}\n`)).toHaveLength(1);
    expect(parseGitMergeTrees(`1\0${hash}\0\0`, 1)).toEqual([hash]);
  });
});
