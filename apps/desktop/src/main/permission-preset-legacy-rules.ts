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
