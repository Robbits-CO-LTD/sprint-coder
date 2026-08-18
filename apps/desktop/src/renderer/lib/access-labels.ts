import type { AccessPreset, CommandSandboxCapability } from '../types/sprint-coder';

// Access is enforced by Main's common ManagedCodingHarness, independently of which Runtime chose
// the tool. CLI-native File/Shell tools are disabled; unsupported command sandboxes fail closed by
// omitting exec_command from the sealed catalog.

export const ACCESS_PRESET_LABEL: Record<AccessPreset, string> = {
  ask: '確認する',
  auto: '自動',
  full: 'フル',
};

export type AccessEnforcement = 'os-sandbox' | 'command-unavailable';

export function accessEnforcement(capability: CommandSandboxCapability | null): AccessEnforcement {
  return capability?.available === true ? 'os-sandbox' : 'command-unavailable';
}

export function accessDescription(
  preset: AccessPreset,
  capability: CommandSandboxCapability | null,
): string {
  const sandbox = commandSandboxDescription(capability);
  if (preset === 'ask')
    return `読み取りは共通Harnessで実行し、変更とコマンドは実行前に確認します。${sandbox}`;
  if (preset === 'full')
    return `広い操作を許可しますが、credential・アプリ領域・署名鍵の保護と監査は維持されます。${sandbox}`;
  return `Workspace内の編集とprobe済みcommand sandboxだけを自動実行します。${sandbox}`;
}

export function commandSandboxDescription(capability: CommandSandboxCapability | null): string {
  if (capability === null) return ' Command sandbox: probe待ち（利用不可）。';
  const observed = new Date(capability.probedAt);
  const timestamp = Number.isNaN(observed.getTime())
    ? capability.probedAt
    : observed.toLocaleString('ja-JP');
  return capability.available
    ? ` Command sandbox: ${capability.backend}（probe成功 ${timestamp}）。`
    : ` Command sandbox: 利用不可（${capability.backend} / ${capability.reason ?? 'unknown'} / ${timestamp}）。`;
}
