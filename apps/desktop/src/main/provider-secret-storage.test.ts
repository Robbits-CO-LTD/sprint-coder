import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderSecretStorage, type ProviderSecretCipher } from './provider-secret-storage';

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

class FakeCipher implements ProviderSecretCipher {
  isAvailable(): boolean {
    return true;
  }

  encrypt(value: string): Buffer {
    return Buffer.from([...value].reverse().join(''), 'utf8');
  }

  decrypt(value: Buffer): string {
    return [...value.toString('utf8')].reverse().join('');
  }
}

describe('ProviderSecretStorage', () => {
  it('stores only an opaque reference and round-trips through the cipher', () => {
    const root = mkdtempSync(join(tmpdir(), 'provider-secrets-'));
    cleanup.push(root);
    const store = new ProviderSecretStorage(root, new FakeCipher());
    const secret = 'SPRINT_CODER_SECRET_CANARY_7f91c';

    const reference = store.put(secret);
    expect(reference).toMatch(/^provider-secret:/);
    expect(store.get(reference)).toBe(secret);
    expect(
      readFileSync(join(root, `${reference.slice('provider-secret:'.length)}.bin`), 'utf8'),
    ).not.toContain(secret);

    store.delete(reference);
    expect(() => store.get(reference)).toThrow();
  });
});
