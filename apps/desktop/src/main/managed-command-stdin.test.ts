import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configureApprovalDigestKey, resetApprovalDigestKeyForTest } from './approval-digest-key';
import {
  createManagedStdinRequest,
  managedStdinApprovalExecution,
  managedStdinEphemeralExecution,
  managedStdinContentMac,
  visibleStdinText,
  MANAGED_STDIN_MAX_CHARACTERS,
} from './managed-command-stdin';
import { APPROVAL_EPHEMERAL_EXECUTION_MAX_CHARACTERS } from '@sprint-coder/contracts';

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  resetApprovalDigestKeyForTest();
});

/** Runs `read` against a fresh install key, so two calls cannot share one. */
function withKeyDirectory<T>(read: () => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-approval-key-'));
  directories.push(directory);
  resetApprovalDigestKeyForTest();
  configureApprovalDigestKey(directory);
  try {
    return read();
  } finally {
    resetApprovalDigestKeyForTest();
  }
}

const command = {
  sessionId: 'session-1',
  executable: '/usr/bin/tee',
  argv: ['notes.txt'],
  cwd: '/workspace',
};

describe('stdin approval text', () => {
  it.each([
    ['ARABIC LETTER MARK', '\u{61C}', '\\x{61C}'],
    ['INHIBIT SYMMETRIC SWAPPING', '\u{206A}', '\\x{206A}'],
    ['NOMINAL DIGIT SHAPES', '\u{206F}', '\\x{206F}'],
    ['LEFT-TO-RIGHT ISOLATE', '\u{2066}', '\\x{2066}'],
    ['POP DIRECTIONAL ISOLATE', '\u{2069}', '\\x{2069}'],
    ['ZERO WIDTH NO-BREAK SPACE', '\u{FEFF}', '\\x{FEFF}'],
    ['LINE SEPARATOR', '\u{2028}', '\\x{2028}'],
    ['PARAGRAPH SEPARATOR', '\u{2029}', '\\x{2029}'],
    ['ESCAPE', '\u{1B}', '\\x{1B}'],
    ['CARRIAGE RETURN', '\u{D}', '\\x{0D}'],
    ['SINGLE SHIFT THREE', '\u{8F}', '\\x{8F}'],
    ['PRIVATE USE', '\u{E000}', '\\x{E000}'],
  ])('escapes %s so it cannot hide inside an approved value', (_name, character, escaped) => {
    // Category-driven, not a hand-listed range: anything a font or the bidi algorithm could use to
    // make the card disagree with what runs has to be written out.
    expect(visibleStdinText(`before${character}after`)).toBe(`before${escaped}after`);
  });

  it('leaves newline and tab alone so the card can render them', () => {
    expect(visibleStdinText('one\ntwo\tthree')).toBe('one\ntwo\tthree');
  });

  it('keeps no stdin content in the durable projection', () => {
    const request = createManagedStdinRequest({ chars: 'hunter2\n', close: true, command });
    const execution = managedStdinApprovalExecution(request);

    expect(execution).toMatchObject({ charsBytes: 8, tool: 'write_stdin' });
    expect(execution['charsMac']).toMatch(/^[a-f0-9]{64}$/);
    expect(execution).not.toHaveProperty('charsSha256');
    expect(JSON.stringify(execution)).not.toContain('hunter2');
    // A plain hash beside a byte count is a verifier for a guessed password; the stored value
    // must not be one.
    expect(JSON.stringify(execution)).not.toContain(
      createHash('sha256').update('hunter2\n', 'utf8').digest('hex'),
    );
  });

  it('renders two different inputs differently, including a literal backslash', () => {
    // Without doubling the backslash these two draw the same thing, and a reader could not tell a
    // real escape sequence from the six characters spelling one.
    const realEscape = '\u001b[2J';
    const typedText = '\\x{1B}[2J';

    expect(visibleStdinText(realEscape)).not.toBe(visibleStdinText(typedText));
    expect(visibleStdinText(typedText)).toBe('\\\\x{1B}[2J');
    expect(visibleStdinText(realEscape)).toBe('\\x{1B}[2J');
  });

  it('keys the content identity to the install, so a stored value confirms no guess', () => {
    const chars = 'hunter2\n';
    const first = withKeyDirectory(() => managedStdinContentMac(chars));
    const second = withKeyDirectory(() => managedStdinContentMac(chars));

    // Same characters, different install key: a candidate cannot be tested against a stored value.
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(first).not.toBe(createHash('sha256').update(chars, 'utf8').digest('hex'));
  });

  it('reuses one 0600 key file per install so a repeat of the same bytes still matches', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-approval-key-'));
    directories.push(directory);
    const chars = 'same bytes';

    resetApprovalDigestKeyForTest();
    configureApprovalDigestKey(directory);
    const first = managedStdinContentMac(chars);
    // A restart re-reads the file rather than minting a new key, which is what lets an
    // allow_task grant recognise the identical write again.
    resetApprovalDigestKeyForTest();
    configureApprovalDigestKey(directory);
    const afterRestart = managedStdinContentMac(chars);
    resetApprovalDigestKeyForTest();

    expect(afterRestart).toBe(first);
    const keyPath = join(directory, 'approval-digest', 'content-mac.key');
    const stats = statSync(keyPath);
    expect(stats.size).toBe(32);
    if (process.platform !== 'win32') expect(stats.mode & 0o777).toBe(0o600);
  });

  it('bounds the card even when the approved command line is enormous', () => {
    // An already-approved command with a huge argv must not make every later stdin write
    // impossible, so the header is clipped rather than the write refused.
    const request = createManagedStdinRequest({
      chars: '\u202e'.repeat(MANAGED_STDIN_MAX_CHARACTERS),
      close: false,
      command: { ...command, argv: ['x'.repeat(50_000)], cwd: `/${'deep/'.repeat(5_000)}` },
    });

    expect(managedStdinEphemeralExecution(request).length).toBeLessThanOrEqual(
      APPROVAL_EPHEMERAL_EXECUTION_MAX_CHARACTERS,
    );
  });
});
