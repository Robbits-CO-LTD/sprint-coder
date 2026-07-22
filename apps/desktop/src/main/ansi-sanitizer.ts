export type TerminalOutputSanitizer = {
  write(chunk: string): string;
  end(): string;
};

type State = 'text' | 'escape' | 'csi' | 'osc' | 'oscEscape' | 'string' | 'stringEscape';

class StreamingTerminalOutputSanitizer implements TerminalOutputSanitizer {
  private state: State = 'text';
  private controlBytes = 0;
  private readonly maxControlBytes = 64 * 1024;

  write(chunk: string): string {
    let output = '';
    for (const character of chunk) {
      switch (this.state) {
        case 'text':
          if (character === '\u001b') this.enter('escape');
          else if (character === '\u009b') this.enter('csi');
          else if (character === '\u009d') this.enter('osc');
          else if (character === '\u0090' || character === '\u009e' || character === '\u009f')
            this.enter('string');
          else if (character === '\n' || character === '\r' || character === '\t')
            output += character;
          else if (!isControl(character) && !isBidiOverride(character)) output += character;
          break;
        case 'escape':
          if (character === '[') this.enter('csi');
          else if (character === ']') this.enter('osc');
          else if (character === 'P' || character === '^' || character === '_')
            this.enter('string');
          else this.reset();
          break;
        case 'csi':
          if (isCsiFinal(character)) this.reset();
          else this.countControlByte();
          break;
        case 'osc':
          if (character === '\u0007' || character === '\u009c') this.reset();
          else if (character === '\u001b') this.state = 'oscEscape';
          else this.countControlByte();
          break;
        case 'oscEscape':
          if (character === '\\') this.reset();
          else {
            this.state = 'osc';
            this.countControlByte();
          }
          break;
        case 'string':
          if (character === '\u009c') this.reset();
          else if (character === '\u001b') this.state = 'stringEscape';
          else this.countControlByte();
          break;
        case 'stringEscape':
          if (character === '\\') this.reset();
          else {
            this.state = 'string';
            this.countControlByte();
          }
          break;
      }
    }
    return output;
  }

  end(): string {
    this.reset();
    return '';
  }

  private enter(state: State): void {
    this.state = state;
    this.controlBytes = 0;
  }

  private reset(): void {
    this.state = 'text';
    this.controlBytes = 0;
  }

  private countControlByte(): void {
    // Once a control string exceeds the inspection budget, keep discarding it
    // until its real terminator. Resetting to text here would fail open and
    // expose the tail of an unterminated OSC/DCS payload.
    if (this.controlBytes <= this.maxControlBytes) this.controlBytes += 1;
  }
}

function isControl(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

function isCsiFinal(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function isBidiOverride(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

export const sanitizeTerminalOutput = Object.assign(
  (input: string): string => {
    const sanitizer = new StreamingTerminalOutputSanitizer();
    return sanitizer.write(input) + sanitizer.end();
  },
  { createStream: (): TerminalOutputSanitizer => new StreamingTerminalOutputSanitizer() },
);
