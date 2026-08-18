import type { AccessPreset, RuntimeKind } from '../types/sprint-coder';

// Access is enforced by Main's common ManagedCodingHarness, independently of which Runtime chose
// the tool. CLI-native File/Shell tools are disabled; unsupported command sandboxes fail closed by
// omitting exec_command from the sealed catalog.

export const ACCESS_PRESET_LABEL: Record<AccessPreset, string> = {
  ask: '確認する',
  auto: '自動',
  full: 'フル',
};

export type AccessEnforcement = 'none' | 'os-sandbox' | 'trusted-unmanaged';

export function accessEnforcement(preset: AccessPreset, kind: RuntimeKind): AccessEnforcement {
  void preset;
  void kind;
  return 'os-sandbox';
}

export function accessDescription(preset: AccessPreset, kind: RuntimeKind): string {
  void kind;
  if (preset === 'ask')
    return '読み取りは共通Harnessで実行し、変更とコマンドは実行前に確認します。';
  if (preset === 'full')
    return '広い操作を許可しますが、credential・アプリ領域・署名鍵の保護と監査は維持されます。';
  return 'Workspace内の編集とprobe済みcommand sandboxだけを自動実行します。';
}
