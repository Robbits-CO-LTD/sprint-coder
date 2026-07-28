import { safeStorage } from 'electron';
import type { ProviderSecretCipher } from './provider-secret-storage';

export class ElectronProviderSecretCipher implements ProviderSecretCipher {
  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  encrypt(value: string): Buffer {
    if (!this.isAvailable()) throw new Error('OS secret encryption is unavailable');
    return safeStorage.encryptString(value);
  }

  decrypt(value: Buffer): string {
    if (!this.isAvailable()) throw new Error('OS secret encryption is unavailable');
    return safeStorage.decryptString(value);
  }
}
