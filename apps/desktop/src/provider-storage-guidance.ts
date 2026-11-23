const prefix = 'OSの安全な保管領域を利用できません。';

export const providerStorageGuidance = {
  win32:
    prefix +
    'Windowsに普段のユーザーでサインインしていることを確認し、アプリを再起動してください。',
  darwin: prefix + 'macOSのログインキーチェーンを確認してから再試行してください。',
  linux:
    prefix + 'デスクトップのキーリングが利用可能で、ロックが解除されていることを確認してください。',
  other: prefix + 'OSにサインインし直してから再試行してください。',
};

export function storageGuidanceForPlatform(platform: string): string {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux')
    return providerStorageGuidance[platform];
  return providerStorageGuidance.other;
}
