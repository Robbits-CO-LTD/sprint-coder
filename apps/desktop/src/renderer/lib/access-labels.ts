import type { AccessPreset, CommandSandboxCapability } from '../types/sprint-coder';

// Access is enforced by Main's common ManagedCodingHarness, independently of which Runtime chose
// the tool. CLI-native File/Shell tools are disabled; unsupported command sandboxes fail closed by
// omitting exec_command from the sealed catalog.

export const ACCESS_PRESET_LABEL: Record<AccessPreset, string> = {
  ask: '確認する',
  auto: '自動モード',
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
    return `Workspace内のファイルの読み取り・一覧も含め、許可ルールにない操作は実行前に確認します（「Task中許可」を選ぶと、このTaskでは同じ操作を確認なしで続けます）。${sandbox}`;
  if (preset === 'full')
    return `変更・コマンド・標準入力書き込みと、デスクトップ操作（ほかのアプリの窓を読む・押す・入力する・アプリの起動）を確認なしで実行しますが、credential・アプリ領域・署名鍵の保護と監査は維持されます。この保護はファイル・コマンド・ネットワークの道具に効くもので、デスクトップ操作が開いている窓を読んだり入力したりすることは止めません。${sandbox}`;
  return `禁止ルールを優先し、Workspace内のファイルの作成・編集は自動で許可します。許可ルールにない読み取りは、選択中のAIが操作の種類とリスクを審査します。未許可のコマンドは実行前に確認します。${sandbox}`;
}

export function commandSandboxDescription(capability: CommandSandboxCapability | null): string {
  if (capability === null) return ' Command sandbox: probe待ち（利用不可）。';
  const observed = new Date(capability.probedAt);
  const timestamp = Number.isNaN(observed.getTime())
    ? capability.probedAt
    : observed.toLocaleString('ja-JP');
  return capability.available
    ? ` 作業フォルダーで実行するコマンドは外部と通信できません。Command sandbox: ${capability.backend}（probe成功 ${timestamp}）。`
    : ` Command sandbox: 利用不可（${capability.backend} / ${capability.reason ?? 'unknown'} / ${timestamp}）。`;
}
