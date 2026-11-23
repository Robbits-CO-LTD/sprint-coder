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

export const NO_WORKSPACE_ACCESS = '作業フォルダー未設定のため、ファイルとコマンドは使えません。';

export function accessEnforcement(capability: CommandSandboxCapability | null): AccessEnforcement {
  return capability?.available === true ? 'os-sandbox' : 'command-unavailable';
}

export function accessDescription(
  preset: AccessPreset,
  capability: CommandSandboxCapability | null,
  hasWorkspace = true,
): string {
  if (!hasWorkspace) return NO_WORKSPACE_ACCESS;
  const sandbox = commandSandboxDescription(capability);
  if (preset === 'ask')
    return `作業フォルダー内のファイルの読み取り・一覧も含め、許可ルールにない操作は実行前に確認します（「Task中許可」を選ぶと、このTaskでは同じ操作を確認なしで続けます）。 ${sandbox}`;
  if (preset === 'full')
    return `作業フォルダー内のファイルの読み書きや、使えるコマンドは都度確認なしで実行します。 ${sandbox}`;
  const commandApproval = capability?.available ? '未許可のコマンドは実行前に確認します。' : '';
  return `禁止ルールを優先し、作業フォルダー内のファイルの作成・編集は自動で許可します。許可ルールにない読み取りは、選択中のAIが操作の種類とリスクを審査します。${commandApproval} ${sandbox}`;
}

export function commandSandboxDescription(capability: CommandSandboxCapability | null): string {
  if (capability?.available) return '作業フォルダーで実行するコマンドは外部と通信できません。';
  if (capability === null || capability.reason === 'not_probed')
    return '安全に実行できるか確認が済んでいないため、コマンドは使えません。';
  if (capability.reason === 'unsupported_platform')
    return 'このOSでは、コマンドの実行に対応していません。';
  return '安全に実行できることを確認できなかったため、コマンドは使えません。';
}
