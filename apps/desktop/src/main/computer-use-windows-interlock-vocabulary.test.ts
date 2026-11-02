import { readWindowsHostSource } from '../../../../computer-use-windows-host-source.mjs';
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
const host = readWindowsHostSource();
const classifier = read('computer_use_effect_classifier.h');
const windowsRisk = read('computer_use_windows_risk_terms.h');

function quotedTerms(text: string, from: string, prefix: string): string[] {
  const start = text.indexOf(from);
  expect(start, from).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('};', start);
  const body = text.slice(start, end);
  return [...body.matchAll(new RegExp(`${prefix}"([^"]+)"`, 'gu'))].map((match) => match[1]!);
}

// V1: windows_host.cc, the shell words of the UI Automation risk text.
const v1 = quotedTerms(windowsRisk, 'kOtherBounded =', 'u8');
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
    // V1 vocabulary is frozen independently in approval-core.test.ts.
    expect(host).toContain('ClassifyWindowsRiskText(text)');
  });

  it('keeps the V1 risk check as the union of confirmation and other', () => {
    expect(host).toMatch(
      /bool ContainsWindowsRiskText\(std::string_view text\)\s*\{\s*const auto bits = sprint_coder::computer_use::ClassifyWindowsRiskText\(text\);\s*return bits\.confirmation \|\| bits\.other;\s*\}/u,
    );
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

// E4, the installer rule (kInstallerTerms), is the same kind of difference: it makes a click on a
// control named like an installer a takeover (paused) on EVERY surface, and V1's risk text has fewer
// of those words. The owner accepted this direction (starting an installer fails closed, the same
// as the words above). Frozen: a word added to kInstallerTerms without a decision turns this red.
const v1Risk = [
  ...quotedTerms(windowsRisk, 'kConfirmationSubstring =', 'u8'),
  ...quotedTerms(windowsRisk, 'kOtherSubstring =', 'u8'),
];
const installer = quotedTerms(
  classifier,
  'inline constexpr std::u8string_view kInstallerTerms[]',
  'u8',
);
const ACCEPTED_NEW_INSTALLER_WORDS = ['install', 'インストーラ'];

describe('interlock installer words against V1 words (#500 S5-c-2 PR-5 review)', () => {
  it('reads both tables', () => {
    expect(v1Risk.length).toBe(36);
    expect(installer.length).toBeGreaterThanOrEqual(5);
  });

  it('adds exactly "install" (on a word boundary) and "インストーラ" to what V1 refuses', () => {
    const added = installer.filter((word) => !v1Risk.includes(word));
    expect([...added].sort()).toEqual([...ACCEPTED_NEW_INSTALLER_WORDS].sort());
  });

  it('shares the rest: V1 has installer, install application and インストール', () => {
    expect(installer.filter((word) => v1Risk.includes(word)).sort()).toEqual(
      ['install application', 'installer', 'インストール'].sort(),
    );
  });
});
