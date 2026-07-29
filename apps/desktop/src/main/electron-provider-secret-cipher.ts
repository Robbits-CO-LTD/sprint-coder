import { safeStorage } from 'electron';
import type { ProviderSecretCipher } from './provider-secret-storage';

export class ElectronProviderSecretCipher implements ProviderSecretCipher {
  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  encrypt(value: string): Buffer {
    return safeStorage.encryptString(value);
  }

  decrypt(value: Buffer): string {
    return safeStorage.decryptString(value);
  }
}
