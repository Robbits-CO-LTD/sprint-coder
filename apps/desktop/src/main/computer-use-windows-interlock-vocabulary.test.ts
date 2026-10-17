import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The words that make the v2 interlocks refuse a command surface, against the words V1's own risk
// check already refuses (#500 S5-c-2 PR-5, plan section 3-2). The interlock is wired into the V1
// path, so a word that only the interlock knows is a refusal V1 users get NEWLY. The owner accepted
// exactly the list below (terminals and consoles in Japanese, xterm, running a script, and the full
// width spellings the classifier folds to ASCII). The list is frozen: a word added to the classifier's
// table without a decision turns this test red.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const read = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const host = read('computer_use_windows_host.cc');
const classifier = read('computer_use_effect_classifier.h');

function quotedTerms(text: string, from: string, prefix: string): string[] {
  const start = text.indexOf(from);
  expect(start, from).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('};', start);
  const body = text.slice(start, end);
  return [...body.matchAll(new RegExp(`${prefix}"([^"]+)"`, 'gu'))].map((match) => match[1]!);
}

// V1: windows_host.cc, the shell words of the UI Automation risk text.
const v1 = quotedTerms(host, 'static constexpr std::array<std::string_view, 9> shell_terms', '');
// The classifier: kSurfaceTerms.
const v2 = quotedTerms(classifier, 'inline constexpr std::u8string_view kSurfaceTerms[]', 'u8');

// What only the interlock refuses. Accepted by the owner (#500). "shell script" and "script console"
// contain a V1 word on a word boundary ("shell", "console") and were refused already; they are
// listed because they are in the table. The full width forms are folded to ASCII before matching
// (NFKC), so the same words in full width are refused as well; that is the spelling difference the
// owner accepted.
const ACCEPTED_NEW_WORDS = [
  'xterm',
  'run script',
  'shell script',
  'script console',
  'ターミナル',
  'コンソール',
  'コマンドプロンプト',
  'スクリプトを実行',
];
// What only V1 refuses (the interlock does not, and V1 still does at the dispatch).
const V1_ONLY_WORDS = ['pwsh', 'wsl'];

describe('interlock surface words against V1 words (#500 S5-c-2 PR-5)', () => {
  it('reads both tables', () => {
    expect(v1.length).toBe(9);
    expect(v2.length).toBeGreaterThanOrEqual(15);
  });

  it('adds exactly the words the owner accepted to what V1 refuses', () => {
    const added = v2.filter((word) => !v1.includes(word));
    expect([...added].sort()).toEqual([...ACCEPTED_NEW_WORDS].sort());
  });

  it('keeps every V1 word that the interlock does not know a V1 refusal (nothing is lost)', () => {
    const onlyV1 = v1.filter((word) => !v2.includes(word));
    expect([...onlyV1].sort()).toEqual([...V1_ONLY_WORDS].sort());
    // They are still refused by V1's own guard at the dispatch, which is unchanged.
    for (const word of onlyV1) expect(host).toContain(`"${word}"`);
  });

  it('shares every other word', () => {
    for (const word of v1.filter((item) => v2.includes(item))) {
      expect(v2).toContain(word);
      expect(v1).toContain(word);
    }
    expect(v1.filter((word) => v2.includes(word)).sort()).toEqual(
      [
        'cmd.exe',
        'command prompt',
        'console',
        'integrated terminal',
        'powershell',
        'shell',
        'terminal',
      ].sort(),
    );
  });
});
