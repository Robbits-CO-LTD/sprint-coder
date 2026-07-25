import type { AccessPreset, RuntimeKind } from '../types/sprint-coder';

// What each Access preset actually grants, per Runtime (issue #37).
//
// Before #37 the chip showed a bare 確認する/自動/フル and the answer to "so can it edit my files?"
// was "no, never" for every value. Now the preset really does decide, and the two Runtimes do not
// enforce it the same way — so the label has to carry both the capability and how it is enforced.
//
// The distinction §Managed Runtime draws, verbatim: 「単なるread-only promptやtool非公開は
// security boundaryに数えない」.
//   - Codex: `--sandbox workspace-write` is Seatbelt on macOS. The model cannot escape it, so this
//     is a real boundary and is described as one.
//   - Claude: the same scope is a tool allowlist the CLI applies to itself. Nothing outside the CLI
//     enforces it, so it is labelled trusted-unmanaged — the honest word for "this holds only as
//     long as the CLI behaves".
// Overstating the Claude case would be the more damaging error of the two: a user who believes the
// app sandboxes it would hand it a directory they would not otherwise.

export const ACCESS_PRESET_LABEL: Record<AccessPreset, string> = {
  ask: '確認する',
  auto: '自動',
  full: 'フル',
};

export type AccessEnforcement = 'none' | 'os-sandbox' | 'trusted-unmanaged';

export function accessEnforcement(preset: AccessPreset, kind: RuntimeKind): AccessEnforcement {
  if (preset === 'ask') return 'none';
  // Mock never touches the filesystem through a CLI at all; its "edits" are the app's own.
  if (kind === 'mock') return 'os-sandbox';
  return kind === 'codex' && preset === 'auto' ? 'os-sandbox' : 'trusted-unmanaged';
}

export function accessDescription(preset: AccessPreset, kind: RuntimeKind): string {
  if (preset === 'ask')
    return 'Workspaceの読み取りと提案のみです。Runtimeはファイルを書き込みません。';
  if (preset === 'full')
    return kind === 'codex'
      ? 'サンドボックスを無効化します。Workspace外も書き換えられます。'
      : 'すべてのツールを許可します。Workspace外も書き換えられます。OS的な制限はありません。';
  return kind === 'codex'
    ? 'Workspace内のみ書き込めます。macOSのSeatbeltで強制される制限です。'
    : 'Workspace内での編集を許可します。CLI自身による制限で、OSによる強制ではありません。';
}
