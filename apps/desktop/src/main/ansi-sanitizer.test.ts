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

  it('drops an OSC 8 hyperlink whose visible label spoofs a different destination than its href', () => {
    // Terminal hyperlink smuggling: the attacker-controlled href never reaches trusted UI at
    // all in the sanitized output — only the plain visible label text can survive, and even
    // that is indistinguishable from ordinary text once stripped of the OSC wrapper.
    const input =
      '\u001b]8;;https://evil.test/phish\u0007https://your-bank.example/login\u001b]8;;\u0007';
    const output = sanitizeTerminalOutput(input);
    expect(output).toBe('https://your-bank.example/login');
    expect(output).not.toContain('evil.test');
  });

  it('drops cursor-move/erase spoofing sequences so a hidden line cannot overwrite visible output', () => {
    const input =
      'first line\u001b[2K\u001b[1G\u001b[Ahidden overwrite\u001b[Bnext' +
      '\u001b[10;20Hrelocated\u001b[?25l\u001b[?25h';
    const output = sanitizeTerminalOutput(input);
    expect(output).toBe('first linehidden overwritenextrelocated');
    expect(output).not.toContain('\u001b');
  });

  it('does not hang or crash on an oversized run of chained SGR parameters', () => {
    const params = Array.from({ length: 20_000 }, (_, index) => index % 100).join(';');
    const input = `before\u001b[${params}mafter`;
    expect(() => sanitizeTerminalOutput(input)).not.toThrow();
    expect(sanitizeTerminalOutput(input)).toBe('beforeafter');
  });

  it('fails closed for an unterminated oversized CSI sequence at end of stream', () => {
    const sanitizer = sanitizeTerminalOutput.createStream();
    const output = sanitizer.write(`safe\u001b[${'9'.repeat(70_000)}`) + sanitizer.end();
    expect(output).toBe('safe');
  });
});
