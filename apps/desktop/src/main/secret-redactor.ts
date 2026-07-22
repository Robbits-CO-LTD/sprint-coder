export type StreamingSecretRedactor = {
  write(chunk: string): string;
  end(): string;
};

const CARRY_CHARACTERS = 4_096;
const PRIVATE_KEY_BEGIN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
const PRIVATE_KEY_END = /-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;

class Redactor implements StreamingSecretRedactor {
  private pending = '';
  private discardingPrivateKey = false;

  write(chunk: string): string {
    this.pending += chunk;
    if (this.discardingPrivateKey) {
      const end = PRIVATE_KEY_END.exec(this.pending);
      if (end === null) {
        this.pending = this.pending.slice(-128);
        return '';
      }
      this.discardingPrivateKey = false;
      this.pending = this.pending.slice(end.index + end[0].length);
      return `[REDACTED_PRIVATE_KEY]${this.write('')}`;
    }
    const begin = PRIVATE_KEY_BEGIN.exec(this.pending);
    const privateKeyOpen = begin !== null;
    const privateKeyClosed = PRIVATE_KEY_END.test(this.pending);
    if (privateKeyOpen && !privateKeyClosed && this.pending.length > CARRY_CHARACTERS) {
      const safePrefix = redactSecrets(this.pending.slice(0, begin.index));
      this.pending = this.pending.slice(-128);
      this.discardingPrivateKey = true;
      return safePrefix;
    }
    if (!privateKeyOpen || privateKeyClosed) {
      const newline = Math.max(this.pending.lastIndexOf('\n'), this.pending.lastIndexOf('\r'));
      if (newline >= 0) {
        const output = redactSecrets(this.pending.slice(0, newline + 1));
        this.pending = this.pending.slice(newline + 1);
        return output;
      }
    }
    if (this.pending.length <= CARRY_CHARACTERS) return '';
    const redacted = redactSecrets(this.pending);
    const emitLength = Math.max(0, redacted.length - CARRY_CHARACTERS);
    const output = redacted.slice(0, emitLength);
    this.pending = redacted.slice(emitLength);
    return output;
  }

  end(): string {
    if (
      this.discardingPrivateKey ||
      (PRIVATE_KEY_BEGIN.test(this.pending) && !PRIVATE_KEY_END.test(this.pending))
    ) {
      this.pending = '';
      this.discardingPrivateKey = false;
      return '[REDACTED_PRIVATE_KEY]';
    }
    const output = redactSecrets(this.pending);
    this.pending = '';
    return output;
  }
}

export function redactSecrets(input: string): string {
  return input
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
      '[REDACTED_PRIVATE_KEY]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)\s*([:=])\s*([^\s,;]{4,})/gi,
      '$1$2[REDACTED]',
    );
}

export function createStreamingSecretRedactor(): StreamingSecretRedactor {
  return new Redactor();
}
