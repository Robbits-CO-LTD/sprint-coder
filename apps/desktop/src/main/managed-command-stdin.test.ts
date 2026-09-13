import { describe, expect, it } from 'vitest';
import {
  createManagedStdinRequest,
  managedStdinApprovalExecution,
  managedStdinEphemeralExecution,
  visibleStdinText,
  MANAGED_STDIN_MAX_CHARACTERS,
} from './managed-command-stdin';
import { APPROVAL_EPHEMERAL_EXECUTION_MAX_CHARACTERS } from '@sprint-coder/contracts';

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
    expect(execution['charsSha256']).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(execution)).not.toContain('hunter2');
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
