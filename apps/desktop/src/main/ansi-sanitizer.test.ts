import { describe, expect, it } from 'vitest';
import { sanitizeTerminalOutput } from './ansi-sanitizer';

describe('terminal output sanitizer', () => {
  it('strips CSI, OSC hyperlinks, DCS, and unsafe control bytes while preserving text layout', () => {
    const input =
      '\u001b[31mred\u001b[0m ' +
      '\u001b]8;;https://evil.test\u0007click\u001b]8;;\u0007 ' +
      '\u001bPpayload\u001b\\ tail\u0000\u0008\nnext\tcell';

    expect(sanitizeTerminalOutput(input)).toBe('red click  tail\nnext\tcell');
  });

  it('handles escape sequences split across stream chunks without leaking control payload', () => {
    const sanitizer = sanitizeTerminalOutput.createStream();
    const output = [
      sanitizer.write('safe\u001b]8;;https://evil.'),
      sanitizer.write('test\u0007label\u001b]8;;'),
      sanitizer.write('\u0007 done'),
      sanitizer.end(),
    ].join('');

    expect(output).toBe('safelabel done');
  });

  it('drops C1 controls, bidi overrides, clipboard OSC, and an incomplete escape at EOF', () => {
    const sanitizer = sanitizeTerminalOutput.createStream();
    const output =
      sanitizer.write('a\u009b2Jb\u202Ec\u001b]52;c;secret\u0007d\u001b[31') + sanitizer.end();

    expect(output).toBe('abcd');
  });

  it('fails closed for an unterminated oversized OSC payload', () => {
    const sanitizer = sanitizeTerminalOutput.createStream();
    const output = sanitizer.write(`safe\u001b]52;c;${'x'.repeat(70_000)}LEAK`) + sanitizer.end();

    expect(output).toBe('safe');
    expect(output).not.toContain('LEAK');
  });
});
