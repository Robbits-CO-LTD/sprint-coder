import type { AccessPreset, PathClassification, PermissionRule } from '@sprint-coder/domain';

/**
 * The Access preset expansion exactly as it stood in commit 3260f08, immediately before the
 * Provider-disclosure rules were added to `expandAccessPreset` (Issue #487).
 *
 * This is a frozen historical snapshot, transcribed from
 * `git show 3260f08:packages/domain/src/permission.ts`. It exists so a database written by the
 * previous build can be recognized as *this exact* old expansion rather than as tampering, and
 * have its stored rules re-materialized without losing the user's preset.
 *
 * It must never be "kept up to date" with `expandAccessPreset`: the moment it tracks the current
 * expansion it stops distinguishing a known old database from a modified one. A later expansion
 * change adds its own snapshot beside this one; it does not edit this one.
 */

const LEGACY_PROTECTED_PATH_CLASSIFICATIONS: readonly PathClassification[] = [
  'app-private',
  'os-protected',
  'credential',
  'signing-key',
  'update-key',
  'unclassified',
];

const LEGACY_SAFE_AUTO_RULES: readonly PermissionRule[] = [
  {
    capability: 'workspace.read',
    resourceSet: { kind: 'path-classification', classifications: ['workspace'] },
    operations: ['read'],
    auditReason: 'preset_auto_safe',
  },
];

const LEGACY_FULL_RULES: readonly PermissionRule[] = [
  ...LEGACY_SAFE_AUTO_RULES,
  {
    capability: 'workspace.write',
    resourceSet: { kind: 'path-classification', classifications: ['workspace'] },
    operations: ['write'],
    auditReason: 'preset_full',
  },
  {
    capability: 'filesystem.external.read',
    resourceSet: { kind: 'path-classification', classifications: ['external'] },
    operations: ['read'],
    auditReason: 'preset_full',
  },
  {
    capability: 'filesystem.external.write',
    resourceSet: { kind: 'path-classification', classifications: ['external'] },
    operations: ['write'],
    auditReason: 'preset_full',
  },
  {
    capability: 'shell.execute',
    resourceSet: { kind: 'all' },
    operations: ['execute'],
    auditReason: 'preset_full',
  },
  {
    capability: 'network.fetch',
    resourceSet: { kind: 'all' },
    operations: ['fetch'],
    auditReason: 'preset_full',
  },
  {
    capability: 'external.open',
    resourceSet: { kind: 'all' },
    operations: ['open'],
    auditReason: 'preset_full',
  },
];

const LEGACY_IMMUTABLE_DENY_RULES: readonly PermissionRule[] = [
  ...(['workspace.read', 'filesystem.external.read'] as const).map((capability) => ({
    capability,
    resourceSet: {
      kind: 'path-classification' as const,
      classifications: LEGACY_PROTECTED_PATH_CLASSIFICATIONS,
    },
    operations: ['read'] as const,
    auditReason: 'immutable_protected_resource',
  })),
  ...(['workspace.write', 'filesystem.external.write'] as const).map((capability) => ({
    capability,
    resourceSet: {
      kind: 'path-classification' as const,
      classifications: LEGACY_PROTECTED_PATH_CLASSIFICATIONS,
    },
    operations: ['write'] as const,
    auditReason: 'immutable_protected_resource',
  })),
];

export type LegacyExpandedAccessPolicy = Readonly<{
  approvalPolicy: 'ask' | 'auto';
  approvalReason: string;
  allowRules: readonly PermissionRule[];
  immutableDeny: readonly PermissionRule[];
}>;

/** The pre-#487 `expandAccessPreset`, transcribed from commit 3260f08. */
export function legacyExpandAccessPreset(preset: AccessPreset): LegacyExpandedAccessPolicy {
  if (preset === 'ask')
    return {
      approvalPolicy: 'ask',
      approvalReason: 'approval_policy_ask',
      allowRules: [],
      immutableDeny: LEGACY_IMMUTABLE_DENY_RULES,
    };
  if (preset === 'auto')
    return {
      approvalPolicy: 'auto',
      approvalReason: 'preset_auto_unknown',
      allowRules: LEGACY_SAFE_AUTO_RULES,
      immutableDeny: LEGACY_IMMUTABLE_DENY_RULES,
    };
  return {
    approvalPolicy: 'ask',
    approvalReason: 'preset_full_unknown',
    allowRules: LEGACY_FULL_RULES,
    immutableDeny: LEGACY_IMMUTABLE_DENY_RULES,
  };
}

/*
 * ここから下は2つ目の凍結スナップショット（issue #526）。「安全時は自動」に Workspace 内の
 * ファイルの作成・編集の自動許可を足す直前の `expandAccessPreset` を、commit e0fa25c の
 * `git show e0fa25c:packages/domain/src/permission.ts` から書き写したもの。この展開は
 * 3651e99（#489、Issue #487 の Provider 開示ルール追加）から e0fa25c まで変わっていない。
 *
 * 上の 3260f08 のスナップショットと同じく、今の `expandAccessPreset` に合わせて直してはいけない。
 * 次に展開を変えるときは、これも編集せず、さらに隣へ新しいスナップショットを足す。
 */

const PRE_526_PROTECTED_PATH_CLASSIFICATIONS: readonly PathClassification[] = [
  'app-private',
  'os-protected',
  'credential',
  'signing-key',
  'update-key',
  'unclassified',
];

const PRE_526_SAFE_AUTO_RULES: readonly PermissionRule[] = [
  {
    capability: 'workspace.read',
    resourceSet: { kind: 'path-classification', classifications: ['workspace'] },
    operations: ['read'],
    auditReason: 'preset_auto_safe',
  },
];

const PRE_526_FULL_RULES: readonly PermissionRule[] = [
  ...PRE_526_SAFE_AUTO_RULES,
  {
    capability: 'workspace.read',
    resourceSet: {
      kind: 'provider-disclosure',
      pathClassifications: ['workspace'],
      classifications: ['sensitive', 'uncertain'],
    },
    operations: ['read'],
    auditReason: 'preset_full_disclosure',
  },
  {
    capability: 'workspace.write',
    resourceSet: { kind: 'path-classification', classifications: ['workspace'] },
    operations: ['write'],
    auditReason: 'preset_full',
  },
  {
    capability: 'filesystem.external.read',
    resourceSet: { kind: 'path-classification', classifications: ['external'] },
    operations: ['read'],
    auditReason: 'preset_full',
  },
  {
    capability: 'filesystem.external.write',
    resourceSet: { kind: 'path-classification', classifications: ['external'] },
    operations: ['write'],
    auditReason: 'preset_full',
  },
  {
    capability: 'shell.execute',
    resourceSet: { kind: 'all' },
    operations: ['execute'],
    auditReason: 'preset_full',
  },
  {
    capability: 'network.fetch',
    resourceSet: { kind: 'all' },
    operations: ['fetch'],
    auditReason: 'preset_full',
  },
  {
    capability: 'external.open',
    resourceSet: { kind: 'all' },
    operations: ['open'],
    auditReason: 'preset_full',
  },
];

const PRE_526_IMMUTABLE_DENY_RULES: readonly PermissionRule[] = [
  ...(['workspace.read', 'filesystem.external.read'] as const).map((capability) => ({
    capability,
    resourceSet: {
      kind: 'path-classification' as const,
      classifications: PRE_526_PROTECTED_PATH_CLASSIFICATIONS,
    },
    operations: ['read'] as const,
    auditReason: 'immutable_protected_resource',
  })),
  ...(['workspace.write', 'filesystem.external.write'] as const).map((capability) => ({
    capability,
    resourceSet: {
      kind: 'path-classification' as const,
      classifications: PRE_526_PROTECTED_PATH_CLASSIFICATIONS,
    },
    operations: ['write'] as const,
    auditReason: 'immutable_protected_resource',
  })),
  {
    capability: 'workspace.read',
    resourceSet: {
      kind: 'provider-disclosure',
      pathClassifications: PRE_526_PROTECTED_PATH_CLASSIFICATIONS,
      classifications: ['sensitive', 'uncertain'],
    },
    operations: ['read'],
    auditReason: 'immutable_protected_resource',
  },
];

/** #526 の直前の `expandAccessPreset`。commit e0fa25c から書き写した（3651e99 以降同じ）。 */
export function legacyExpandAccessPresetBefore526(
  preset: AccessPreset,
): LegacyExpandedAccessPolicy {
  if (preset === 'ask')
    return {
      approvalPolicy: 'ask',
      approvalReason: 'approval_policy_ask',
      allowRules: [],
      immutableDeny: PRE_526_IMMUTABLE_DENY_RULES,
    };
  if (preset === 'auto')
    return {
      approvalPolicy: 'auto',
      approvalReason: 'preset_auto_unknown',
      allowRules: PRE_526_SAFE_AUTO_RULES,
      immutableDeny: PRE_526_IMMUTABLE_DENY_RULES,
    };
  return {
    approvalPolicy: 'ask',
    approvalReason: 'preset_full_unknown',
    allowRules: PRE_526_FULL_RULES,
    immutableDeny: PRE_526_IMMUTABLE_DENY_RULES,
  };
}

/**
 * 前の版が DB に書いた可能性のある展開の一覧（古い順）。保存済みの行がこのどれかと完全に一致する
 * Task だけを、開いたときに今の展開へ書き直す。展開を変えるときは、変える直前の展開の
 * スナップショットをここへ足す。
 */
export const LEGACY_ACCESS_PRESET_EXPANSIONS: readonly ((
  preset: AccessPreset,
) => LegacyExpandedAccessPolicy)[] = [legacyExpandAccessPreset, legacyExpandAccessPresetBefore526];
