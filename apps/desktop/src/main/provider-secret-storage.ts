import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface ProviderSecretCipher {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

const REFERENCE_PATTERN =
  /^provider-secret:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const MAX_SECRET_BYTES = 64 * 1024;

export class ProviderSecretStorage {
  constructor(
    private readonly rootPath: string,
    private readonly cipher: ProviderSecretCipher,
  ) {}

  put(secret: string): string {
    if (!this.cipher.isAvailable()) throw new Error('OS secret encryption is unavailable');
    const byteLength = Buffer.byteLength(secret);
    if (byteLength < 1 || byteLength > MAX_SECRET_BYTES)
      throw new Error('Provider secret has an invalid size');
    mkdirSync(this.rootPath, { recursive: true, mode: 0o700 });
    const reference = `provider-secret:${randomUUID()}`;
    const encrypted = this.cipher.encrypt(secret);
    const descriptor = openSync(
      this.pathForReference(reference),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeFileSync(descriptor, encrypted);
    } finally {
      closeSync(descriptor);
      encrypted.fill(0);
    }
    return reference;
  }

  get(reference: string): string {
    if (!this.cipher.isAvailable()) throw new Error('OS secret encryption is unavailable');
    const descriptor = openSync(
      this.pathForReference(reference),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_SECRET_BYTES * 4)
        throw new Error('Provider secret blob is invalid');
      const encrypted = readFileSync(descriptor);
      try {
        return this.cipher.decrypt(encrypted);
      } finally {
        encrypted.fill(0);
      }
    } finally {
      closeSync(descriptor);
    }
  }

  delete(reference: string): void {
    unlinkSync(this.pathForReference(reference));
  }

  private pathForReference(reference: string): string {
    const match = REFERENCE_PATTERN.exec(reference);
    if (match === null) throw new Error('Invalid Provider secret reference');
    return join(this.rootPath, `${match[1]}.bin`);
  }
}
