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
  return (
    input
      .replace(
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
        '[REDACTED_PRIVATE_KEY]',
      )
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]')
      // AWS long-term/temporary access key IDs are self-identifying by prefix and fixed length,
      // so this catches one embedded inline in output with no surrounding `KEY=` label at all.
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
      // Provider secret-key prefixes. The separator is `[_-]` (not just `_`) so this also catches
      // Anthropic (`sk-ant-...`) and OpenAI (`sk-proj-...`) hyphenated key shapes, not only the
      // underscore-separated GitHub/legacy OpenAI shape.
      .replace(/\b(?:sk|gh[pousr]|github_pat)[_-][A-Za-z0-9_-]{12,}\b/g, '[REDACTED_TOKEN]')
      .replace(
        // The lookbehind (rather than `\b`) is deliberate: `\b` treats `_`/`-` as word characters,
        // so it cannot see a keyword boundary inside `DB_PASSWORD` or `AWS_SECRET_ACCESS_KEY` — the
        // overwhelmingly common .env/CI naming convention. Requiring "not directly preceded by an
        // alnum" still rejects an unrelated compound word like `mypasswordfield`.
        /(?<![a-z0-9])(api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|aws[_-]?access[_-]?key[_-]?id|access[_-]?key[_-]?id|aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key)\s*([:=])\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]{4,})/gi,
        '$1$2[REDACTED]',
      )
      // A bare JWT (three dot-separated base64url segments, header starting `eyJ`) can appear
      // without any `token=`/`Authorization:` label at all (e.g. a cookie value, a URL fragment).
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]')
      .replace(/\bglpat-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_GITLAB_TOKEN]')
      .replace(
        /\b([a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^\s/@:]{1,256})(?::[^\s/@]{0,256})?@/gi,
        '$1[REDACTED]@',
      )
  );
}

export function createStreamingSecretRedactor(): StreamingSecretRedactor {
  return new Redactor();
}
