import { createHash } from 'node:crypto';

export const capabilities = [
  'workspace.read',
  'workspace.write',
  'filesystem.external.read',
  'filesystem.external.write',
  'shell.execute',
  'network.fetch',
  'external.open',
  'secret.use',
  'provider.egress',
  'computer.observe',
  'computer.control',
] as const;

export type Capability = (typeof capabilities)[number];
export type PermissionOperation =
  'read' | 'write' | 'execute' | 'fetch' | 'open' | 'use' | 'egress' | 'observe' | 'control';
export type ProviderEgress = 'none' | 'trusted-local' | 'trusted-remote' | 'untrusted-remote';
export type SandboxProfile = 'read-only' | 'workspace-write' | 'full';
export type AccessPreset = 'ask' | 'auto' | 'full';

export type PathClassification =
  | 'workspace'
  | 'external'
  | 'app-private'
  | 'os-protected'
  | 'credential'
  | 'signing-key'
  | 'update-key'
  | 'unclassified';

export type PermissionResource =
  | {
      kind: 'workspace-path';
      workspaceId: string;
      canonicalPath: string;
      identityDigest: string;
      classification: PathClassification;
    }
  | {
      kind: 'external-path';
      canonicalPath: string;
      identityDigest: string;
      classification: Exclude<PathClassification, 'workspace'>;
    }
  | { kind: 'network'; origin: string }
  | {
      kind: 'provider';
      providerId: string;
      fragmentKind: string;
      byteCount: number;
      providerTrust: Exclude<ProviderEgress, 'none'>;
      dataResidency: string;
      provenanceTrust: 'system' | 'user' | 'workspace' | 'untrusted';
      secretScan: 'clean' | 'blocked';
      /**
       * Digest of the Main-issued Workspace roots the secret scan was allowed to treat as
       * structure, or null when none were declared. A `clean` scan means nothing else; without
       * this, an audit cannot tell which bytes the scan was told to ignore.
       */
      knownRootsDigest: string | null;
      localOnlyTask: boolean;
      attachmentManifestDigest: string | null;
      attachmentByteCount: number;
    }
  | {
      kind: 'provider-disclosure';
      providerId: string;
      canonicalPath: string;
      sourceDigest: string;
      disclosedDigest: string;
      classification: 'sensitive' | 'uncertain';
      /**
       * Classification of the path the bytes came from, carried so the immutable protected-path
       * deny applies to the disclosure lane too. Without it a protected file could be disclosed
       * by asking about its redacted content instead of about its path.
       */
      pathClassification: PathClassification;
      reasons: readonly string[];
      classifierVersion: string;
    }
  | { kind: 'secret'; secretId: string }
  | { kind: 'external'; target: string }
  /** Stable app identity only; never use a process id or window handle as authority. */
  | {
      kind: 'computer-app';
      platform: 'darwin' | 'win32';
      appIdentityDigest: string;
    }
  | {
      kind: 'computer-window';
      platform: 'darwin' | 'win32';
      appIdentityDigest: string;
      windowIdentityDigest: string;
    }
  | {
      kind: 'computer-session';
      platform: 'darwin' | 'win32';
      appIdentityDigest: string;
      windowIdentityDigest: string;
      sessionId: string;
      taskId: string;
    }
  | {
      kind: 'computer-revision';
      platform: 'darwin' | 'win32';
      appIdentityDigest: string;
      windowIdentityDigest: string;
      sessionId: string;
      revision: number;
    }
  /**
   * The set of drivable targets one Task may be told about, before any of them is chosen.
   *
   * Every other computer resource names an app, a window, a session, or an observation — things that
   * only exist once a target has been picked. Enumeration is what happens before that, so it has no
   * app identity to bind to; what it does have is a Task, which is the boundary that matters (one
   * Task must not learn what another Task's desktop contains). It is observe-only by construction:
   * nothing can be driven through it.
   */
  | { kind: 'computer-target-list'; taskId: string }
  /**
   * The two control-bearing things a Task may do before a session exists: ask the user for
   * permission to drive an application, and begin driving one it already has permission for.
   *
   * It carries `computer.control` and never `computer.observe`, which is the opposite of the list
   * above and the reason it is a separate kind rather than a flag on it: neither of these reads a
   * screen, and pairing control with an enumeration resource would let a control decision be made
   * against the binding that exists purely to be read.
   *
   * Like the list, it binds only the Task, because there is no app identity yet — the token that
   * names one is spent inside the tool, after this decision. What this resource governs is "may
   * this Task reach for the desktop at all", and the specific application is decided by the human
   * click on the approval card and by the stored grant, neither of which is a permission rule.
   */
  | { kind: 'computer-target-access'; taskId: string };

export type ResourceSet =
  | { kind: 'workspace'; workspaceId?: string }
  | { kind: 'path-exact'; canonicalPath: string; workspaceId?: string }
  | { kind: 'path-prefix'; canonicalPath: string; workspaceId?: string }
  | { kind: 'path-classification'; classifications: readonly PathClassification[] }
  | { kind: 'network-origin'; origin: string }
  | {
      kind: 'provider-egress';
      providerIds: readonly string[];
      fragmentKinds: readonly string[];
      maxBytes: number;
      allowedProviderTrust: readonly Exclude<ProviderEgress, 'none'>[];
      allowedResidencies: readonly string[];
      allowedProvenance: readonly ('system' | 'user' | 'workspace' | 'untrusted')[];
      requireSecretScanClean: boolean;
      allowLocalOnlyTaskRemote: boolean;
      attachmentManifestDigest: string | null;
      attachmentByteCount: number;
    }
  | {
      kind: 'provider-disclosure-exact';
      providerId: string;
      canonicalPath: string;
      sourceDigest: string;
      disclosedDigest: string;
      classifierVersion: string;
    }
  /**
   * Bounded by both axes a disclosure decision turns on: where the bytes came from, and how the
   * classifier rated them. It never contains a path or egress resource.
   */
  | {
      kind: 'provider-disclosure';
      pathClassifications: readonly PathClassification[];
      classifications: readonly ('sensitive' | 'uncertain')[];
    }
  | { kind: 'secret-exact'; secretId: string }
  | { kind: 'external-exact'; target: string }
  | {
      kind: 'computer-app' | 'computer-app-exact';
      platform?: 'darwin' | 'win32';
      appIdentityDigest: string;
    }
  | {
      kind: 'computer-window' | 'computer-window-exact';
      platform?: 'darwin' | 'win32';
      appIdentityDigest: string;
      windowIdentityDigest: string;
    }
  | {
      kind: 'computer-session' | 'computer-session-exact';
      platform?: 'darwin' | 'win32';
      appIdentityDigest: string;
      windowIdentityDigest?: string;
      sessionId: string;
    }
  | {
      kind: 'computer-revision' | 'computer-revision-exact';
      platform?: 'darwin' | 'win32';
      appIdentityDigest?: string;
      windowIdentityDigest?: string;
      sessionId: string;
      revision: number;
    }
  | { kind: 'computer-target-list' | 'computer-target-list-exact'; taskId?: string }
  | { kind: 'computer-target-access' | 'computer-target-access-exact'; taskId?: string }
  | { kind: 'all' };

export type PermissionRule = {
  capability: Capability;
  resourceSet: ResourceSet;
  operations: readonly PermissionOperation[];
  auditReason?: string;
};

export type CapabilityCeiling = {
  entries: readonly CapabilityCeilingEntry[];
  maxWorkerDepth: number;
  maxConcurrentWorkers: number;
};

export type CapabilityCeilingEntry = {
  capability: Capability;
  resourceSet: ResourceSet;
  operations: readonly PermissionOperation[];
  expiresAt: string;
  providerEgress: readonly ProviderEgress[];
  sandboxProfiles: readonly SandboxProfile[];
};

export type PermissionRequest = {
  taskId: string;
  subjectId: string;
  capability: Capability;
  resource: PermissionResource;
  operation: PermissionOperation;
  providerEgress: ProviderEgress;
  sandboxProfile: SandboxProfile;
  executionSpecDigest: string;
  reviewerInputDigest: string;
  risk: 'low' | 'medium' | 'high';
};

export type SessionGrant = {
  id: string;
  subjectId: string;
  capability: Capability;
  resourceSet: ResourceSet;
  operations: readonly PermissionOperation[];
  scope: 'once' | 'task';
  expiresAt: string;
  policyEpoch: number;
  providerEgress: readonly ProviderEgress[];
  sandboxProfiles: readonly SandboxProfile[];
  executionSpecDigest?: string;
  revokedAt?: string;
  consumedAt?: string;
};

/** The type-level shape exposed to callers that can issue Computer control grants. */
export type EphemeralComputerControlGrant = Omit<SessionGrant, 'capability' | 'scope'> & {
  capability: 'computer.control';
  scope: 'once';
};
export type ComputerUseGrant = EphemeralComputerControlGrant;

type ReviewerDecisionFacts = {
  reviewRequestId: string;
  turnId: string;
  callId: string;
  requestFingerprint: string;
  executionSpecDigest: string;
  policyEpoch: number;
  model: string;
  templateVersion: string;
  inputDigest: string;
};

export type ReviewerDecision = ReviewerDecisionFacts &
  (
    | {
        decision: 'allow_once';
        reason: string;
        decisionNonce: string;
      }
    | { decision: 'deny'; reason: string }
    | { decision: 'timeout' | 'schema_failure' | 'model_failure'; reason?: string }
  );

export type PermissionPolicy = {
  managedDeny: readonly PermissionRule[];
  projectDeny: readonly PermissionRule[];
  immutableDeny?: readonly PermissionRule[];
  parentCeiling: CapabilityCeiling;
  modeCeiling: CapabilityCeiling;
  sandbox: { feasible: boolean; profile: SandboxProfile };
  rememberedGrants: readonly SessionGrant[];
  allowRules: readonly PermissionRule[];
  approvalPolicy: 'ask' | 'auto';
  approvalReason?: string;
  reviewerDecision?: ReviewerDecision;
  policyEpoch: number;
};

export type EvaluationStage =
  | 'managed-deny'
  | 'project-deny'
  | 'parent-ceiling'
  | 'mode-ceiling'
  | 'sandbox'
  | 'remembered-grant'
  | 'narrow-allow'
  | 'approval-policy'
  | 'reviewer'
  | 'execution-revalidation';

export type PermissionDecision = 'deny' | 'approval_required' | 'allow' | 'allow_once';
export type PermissionEvaluation = {
  decision: PermissionDecision;
  reason: string;
  policyEpoch: number;
  evaluationTrace: EvaluationStage[];
  permit?: ExecutionPermit;
  reviewerAudit?: {
    reviewRequestId: string;
    turnId: string;
    callId: string;
    requestFingerprint: string;
    executionSpecDigest: string;
    policyEpoch: number;
    model: string;
    templateVersion: string;
    inputDigest: string;
    decision: ReviewerDecision['decision'];
  };
};

export type ExecutionPermit = {
  taskId: string;
  subjectId: string;
  capability: Capability;
  operation: PermissionOperation;
  resourceIdentity: string;
  executionSpecDigest: string;
  policyEpoch: number;
  expiresAt: string;
  source: 'remembered_grant' | 'narrow_allow' | 'reviewer_allow_once';
  sourceGrantId?: string;
  oneTimeToken?: string;
  reviewRequestId?: string;
  turnId?: string;
  callId?: string;
};

export type ExpandedAccessPolicy = Pick<
  PermissionPolicy,
  'approvalPolicy' | 'approvalReason' | 'allowRules' | 'immutableDeny'
>;

const SAFE_AUTO_RULES: readonly PermissionRule[] = [
  {
    capability: 'workspace.read',
    resourceSet: { kind: 'path-classification', classifications: ['workspace'] },
    operations: ['read'],
    auditReason: 'preset_auto_safe',
  },
];

/**
 * 「安全時は自動」で Workspace 内のファイルの作成・編集を自動許可した監査理由（issue #526）。
 * Main はこれで、その許可がプリセットの限定許可ルールから来たことを見分ける。
 */
export const AUTO_PRESET_WORKSPACE_EDIT_AUDIT_REASON = 'preset_auto_safe_edit';

/**
 * 「安全時は自動」だけが持つ、Workspace 内のファイルの作成・編集の自動許可（issue #526）。
 *
 * - `workspace.write` を要求するツールは Edit Saga の3つ（apply_patch / create_file /
 *   create_directory）だけなので、自動になるのはそれらによる Workspace 内のファイル変更だけ。
 * - 対象は Workspace に分類されたパスだけ。credential・アプリ領域・署名鍵などの保護パスは、
 *   評価順で先に来る IMMUTABLE_DENY_RULES が拒否したまま。
 * - コマンド（shell.execute）、Workspace 外への書き込み、ネットワーク、外部で開く操作は
 *   ここに含めず、これまでどおり自動レビューが判定する。
 *
 * FULL_RULES が SAFE_AUTO_RULES を展開しているので、SAFE_AUTO_RULES には入れない。入れると
 * フルアクセスの展開が変わり、保存済みの規則がすべて改ざん扱いになる。
 */
const AUTO_WORKSPACE_EDIT_RULES: readonly PermissionRule[] = [
  {
    capability: 'workspace.write',
    resourceSet: { kind: 'path-classification', classifications: ['workspace'] },
    operations: ['write'],
    auditReason: AUTO_PRESET_WORKSPACE_EDIT_AUDIT_REASON,
  },
];

/**
 * Audit reason for the Full preset's Workspace-file disclosure allow. Exported so Main can tell
 * "the user already allowed this lane" apart from any other allow without matching a bare string.
 */
export const FULL_PRESET_DISCLOSURE_AUDIT_REASON = 'preset_full_disclosure';

const FULL_RULES: readonly PermissionRule[] = [
  ...SAFE_AUTO_RULES,
  // Full access means the user already accepted that this Task's Workspace files reach the
  // Provider, so a per-file disclosure prompt asks a question they have answered. The content
  // is redacted either way; only the prompt is removed, and only for Workspace-classified
  // paths — a protected path stays with the immutable deny below.
  {
    capability: 'workspace.read',
    resourceSet: {
      kind: 'provider-disclosure',
      pathClassifications: ['workspace'],
      classifications: ['sensitive', 'uncertain'],
    },
    operations: ['read'],
    auditReason: FULL_PRESET_DISCLOSURE_AUDIT_REASON,
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

const PATH_CLASSIFICATIONS: readonly PathClassification[] = [
  'workspace',
  'external',
  'app-private',
  'os-protected',
  'credential',
  'signing-key',
  'update-key',
  'unclassified',
];

const PROTECTED_PATH_CLASSIFICATIONS: readonly PathClassification[] = [
  'app-private',
  'os-protected',
  'credential',
  'signing-key',
  'update-key',
  'unclassified',
];

const IMMUTABLE_DENY_RULES: readonly PermissionRule[] = [
  ...(['workspace.read', 'filesystem.external.read'] as const).map((capability) => ({
    capability,
    resourceSet: {
      kind: 'path-classification' as const,
      classifications: PROTECTED_PATH_CLASSIFICATIONS,
    },
    operations: ['read'] as const,
    auditReason: 'immutable_protected_resource',
  })),
  ...(['workspace.write', 'filesystem.external.write'] as const).map((capability) => ({
    capability,
    resourceSet: {
      kind: 'path-classification' as const,
      classifications: PROTECTED_PATH_CLASSIFICATIONS,
    },
    operations: ['write'] as const,
    auditReason: 'immutable_protected_resource',
  })),
  // The same protected paths, denied on the lane that asks about disclosed bytes rather than
  // about the path. A `path-classification` set only matches path resources, so without this the
  // protected-path deny would be bypassable by reading the file through a Provider disclosure.
  {
    capability: 'workspace.read',
    resourceSet: {
      kind: 'provider-disclosure',
      pathClassifications: PROTECTED_PATH_CLASSIFICATIONS,
      classifications: ['sensitive', 'uncertain'],
    },
    operations: ['read'],
    auditReason: 'immutable_protected_resource',
  },
];

export function expandAccessPreset(preset: AccessPreset): ExpandedAccessPolicy {
  if (preset === 'ask')
    return Object.freeze({
      approvalPolicy: 'ask',
      approvalReason: 'approval_policy_ask',
      allowRules: [],
      immutableDeny: cloneRules(IMMUTABLE_DENY_RULES),
    });
  if (preset === 'auto')
    return Object.freeze({
      approvalPolicy: 'auto',
      approvalReason: 'preset_auto_unknown',
      allowRules: cloneRules([...SAFE_AUTO_RULES, ...AUTO_WORKSPACE_EDIT_RULES]),
      immutableDeny: cloneRules(IMMUTABLE_DENY_RULES),
    });
  return Object.freeze({
    approvalPolicy: 'ask',
    approvalReason: 'preset_full_unknown',
    allowRules: cloneRules(FULL_RULES),
    immutableDeny: cloneRules(IMMUTABLE_DENY_RULES),
  });
}

function cloneRules(rules: readonly PermissionRule[]): readonly PermissionRule[] {
  return Object.freeze(
    rules.map((rule) =>
      Object.freeze({
        ...rule,
        resourceSet: cloneResourceSet(rule.resourceSet),
        operations: Object.freeze([...rule.operations]),
      }),
    ),
  );
}

export function createSessionGrant(grant: SessionGrant): SessionGrant {
  if (grant.id.length === 0 || grant.subjectId.length === 0)
    throw new Error('Invalid grant identity');
  if (!Number.isInteger(grant.policyEpoch) || grant.policyEpoch < 0)
    throw new Error('Invalid policy epoch');
  if (!Number.isFinite(Date.parse(grant.expiresAt))) throw new Error('Invalid grant expiry');
  if (grant.operations.length === 0 || new Set(grant.operations).size !== grant.operations.length)
    throw new Error('Invalid grant operations');
  if (grant.providerEgress.length === 0 || grant.sandboxProfiles.length === 0)
    throw new Error('Grant egress and sandbox bounds are required');
  // Computer control is intentionally ephemeral.  A task/persistent grant could outlive the
  // foreground window, user takeover, or the policy epoch that established the app binding.
  if (grant.capability === 'computer.control' && grant.scope !== 'once')
    throw new Error('Computer control grants must be ephemeral');
  // Enumeration is observe-only, so a control grant must never be able to name a target list.
  if (
    grant.capability === 'computer.control' &&
    (grant.resourceSet.kind === 'computer-target-list' ||
      grant.resourceSet.kind === 'computer-target-list-exact')
  )
    throw new Error('Computer control grants cannot bind a target list');
  // And the mirror: pre-session access is control-only, so an observe grant must never name it.
  // Without this, "may read the desktop" could be written down as authority over the two calls
  // that ask for permission and start driving.
  if (
    grant.capability === 'computer.observe' &&
    (grant.resourceSet.kind === 'computer-target-access' ||
      grant.resourceSet.kind === 'computer-target-access-exact')
  )
    throw new Error('Computer observe grants cannot bind pre-session access');
  if (
    (grant.capability === 'computer.observe' || grant.capability === 'computer.control') &&
    !isComputerResourceSet(grant.resourceSet)
  )
    throw new Error('Computer grants require an app, window, session, or revision binding');
  if (grant.capability === 'shell.execute' && grant.executionSpecDigest === undefined)
    throw new Error('Shell grants require an exact execution digest');
  return Object.freeze({
    ...grant,
    resourceSet: cloneResourceSet(grant.resourceSet),
    operations: Object.freeze([...grant.operations]),
    providerEgress: Object.freeze([...grant.providerEgress]),
    sandboxProfiles: Object.freeze([...grant.sandboxProfiles]),
  });
}

function cloneResourceSet(resourceSet: ResourceSet): ResourceSet {
  if (resourceSet.kind === 'provider-egress')
    return Object.freeze({
      ...resourceSet,
      providerIds: Object.freeze([...resourceSet.providerIds]),
      fragmentKinds: Object.freeze([...resourceSet.fragmentKinds]),
      allowedProviderTrust: Object.freeze([...resourceSet.allowedProviderTrust]),
      allowedResidencies: Object.freeze([...resourceSet.allowedResidencies]),
      allowedProvenance: Object.freeze([...resourceSet.allowedProvenance]),
    });
  if (resourceSet.kind === 'path-classification')
    return Object.freeze({
      ...resourceSet,
      classifications: Object.freeze([...resourceSet.classifications]),
    });
  if (resourceSet.kind === 'provider-disclosure')
    return Object.freeze({
      ...resourceSet,
      pathClassifications: Object.freeze([...resourceSet.pathClassifications]),
      classifications: Object.freeze([...resourceSet.classifications]),
    });
  return Object.freeze({ ...resourceSet });
}

export function evaluatePermissionPolicy(input: {
  request: PermissionRequest;
  policy: PermissionPolicy;
  now: string;
}): PermissionEvaluation {
  const { request, policy, now } = input;
  const trace: EvaluationStage[] = [];
  trace.push('managed-deny');
  if (!requestFactsValid(request))
    return evaluation('deny', 'invalid_request_facts', policy.policyEpoch, trace);
  const managedDeny = [
    ...IMMUTABLE_DENY_RULES,
    ...(policy.immutableDeny ?? []),
    ...policy.managedDeny,
  ].find((rule) => ruleMatches(rule, request));
  if (managedDeny !== undefined)
    return evaluation('deny', managedDeny.auditReason ?? 'managed_deny', policy.policyEpoch, trace);

  trace.push('project-deny');
  const projectDeny = policy.projectDeny.find((rule) => ruleMatches(rule, request));
  if (projectDeny !== undefined)
    return evaluation('deny', projectDeny.auditReason ?? 'project_deny', policy.policyEpoch, trace);

  trace.push('parent-ceiling');
  const parentEntry = findCeilingEntry(policy.parentCeiling, request, now);
  if (parentEntry === undefined)
    return evaluation('deny', 'parent_ceiling', policy.policyEpoch, trace);

  trace.push('mode-ceiling');
  const modeEntry = findCeilingEntry(policy.modeCeiling, request, now);
  if (modeEntry === undefined) return evaluation('deny', 'mode_ceiling', policy.policyEpoch, trace);

  trace.push('sandbox');
  if (
    !policy.sandbox.feasible ||
    sandboxRank(policy.sandbox.profile) < sandboxRank(request.sandboxProfile)
  )
    return evaluation('deny', 'sandbox_infeasible', policy.policyEpoch, trace);

  trace.push('remembered-grant');
  const rememberedGrant = policy.rememberedGrants.find((grant) =>
    sessionGrantMatchesPermissionRequest(grant, request, policy.policyEpoch, now),
  );
  if (rememberedGrant !== undefined)
    return evaluation(
      'allow',
      'remembered_grant',
      policy.policyEpoch,
      trace,
      createPermit(
        request,
        policy,
        'remembered_grant',
        [parentEntry.expiresAt, modeEntry.expiresAt, rememberedGrant.expiresAt],
        rememberedGrant.id,
      ),
    );

  trace.push('narrow-allow');
  const allow = policy.allowRules.find((rule) => ruleMatches(rule, request));
  if (allow !== undefined)
    return evaluation(
      'allow',
      allow.auditReason ?? 'narrow_allow',
      policy.policyEpoch,
      trace,
      createPermit(request, policy, 'narrow_allow', [parentEntry.expiresAt, modeEntry.expiresAt]),
    );

  trace.push('approval-policy');
  if (policy.approvalPolicy === 'ask')
    return evaluation(
      'approval_required',
      policy.approvalReason ?? 'approval_policy_ask',
      policy.policyEpoch,
      trace,
    );

  trace.push('reviewer');
  if (
    policy.reviewerDecision?.decision === 'allow_once' &&
    policy.reviewerDecision.requestFingerprint === permissionRequestFingerprint(request) &&
    policy.reviewerDecision.executionSpecDigest === request.executionSpecDigest &&
    policy.reviewerDecision.inputDigest === request.reviewerInputDigest &&
    /^[a-f0-9]{64}$/.test(policy.reviewerDecision.inputDigest) &&
    policy.reviewerDecision.reviewRequestId.length >= 8 &&
    policy.reviewerDecision.turnId.length > 0 &&
    policy.reviewerDecision.callId.length > 0 &&
    policy.reviewerDecision.decisionNonce.length >= 16 &&
    policy.reviewerDecision.policyEpoch === policy.policyEpoch &&
    policy.reviewerDecision.model.length > 0 &&
    policy.reviewerDecision.templateVersion.length > 0 &&
    request.risk !== 'high'
  )
    return withReviewerAudit(
      evaluation(
        'allow_once',
        policy.reviewerDecision.reason,
        policy.policyEpoch,
        trace,
        createPermit(
          request,
          policy,
          'reviewer_allow_once',
          [parentEntry.expiresAt, modeEntry.expiresAt],
          undefined,
          policy.reviewerDecision.decisionNonce,
        ),
      ),
      policy.reviewerDecision,
    );
  if (policy.reviewerDecision?.decision === 'allow_once')
    return withReviewerAudit(
      evaluation('deny', 'reviewer_binding_invalid_or_high_risk', policy.policyEpoch, trace),
      policy.reviewerDecision,
    );
  if (policy.reviewerDecision?.decision === 'deny')
    return withReviewerAudit(
      evaluation('deny', policy.reviewerDecision.reason, policy.policyEpoch, trace),
      policy.reviewerDecision,
    );
  if (policy.reviewerDecision !== undefined)
    return withReviewerAudit(
      evaluation('deny', `reviewer_${policy.reviewerDecision.decision}`, policy.policyEpoch, trace),
      policy.reviewerDecision,
    );
  return evaluation(
    'approval_required',
    policy.approvalReason ?? 'auto_reviewer_required',
    policy.policyEpoch,
    trace,
  );
}

function withReviewerAudit(
  evaluationResult: PermissionEvaluation,
  reviewer: ReviewerDecision,
): PermissionEvaluation {
  return {
    ...evaluationResult,
    reviewerAudit: {
      reviewRequestId: reviewer.reviewRequestId,
      turnId: reviewer.turnId,
      callId: reviewer.callId,
      requestFingerprint: reviewer.requestFingerprint,
      executionSpecDigest: reviewer.executionSpecDigest,
      policyEpoch: reviewer.policyEpoch,
      model: reviewer.model,
      templateVersion: reviewer.templateVersion,
      inputDigest: reviewer.inputDigest,
      decision: reviewer.decision,
    },
  };
}

function requestFactsValid(request: PermissionRequest): boolean {
  if (
    typeof request.taskId !== 'string' ||
    request.taskId.length === 0 ||
    typeof request.subjectId !== 'string' ||
    request.subjectId.length === 0 ||
    typeof request.executionSpecDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(request.executionSpecDigest) ||
    typeof request.reviewerInputDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(request.reviewerInputDigest) ||
    !(['low', 'medium', 'high'] as const).includes(request.risk)
  )
    return false;
  const expectedOperation: Record<Capability, PermissionOperation> = {
    'workspace.read': 'read',
    'workspace.write': 'write',
    'filesystem.external.read': 'read',
    'filesystem.external.write': 'write',
    'shell.execute': 'execute',
    'network.fetch': 'fetch',
    'external.open': 'open',
    'secret.use': 'use',
    'provider.egress': 'egress',
    'computer.observe': 'observe',
    'computer.control': 'control',
  };
  if (request.operation !== expectedOperation[request.capability]) return false;
  if (request.capability !== 'provider.egress' && request.providerEgress !== 'none') return false;
  if (request.resource.kind === 'provider') {
    if (
      request.resource.providerId.length === 0 ||
      request.resource.fragmentKind.length === 0 ||
      request.resource.dataResidency.length === 0 ||
      !Number.isSafeInteger(request.resource.byteCount) ||
      request.resource.byteCount < 0 ||
      !(['trusted-local', 'trusted-remote', 'untrusted-remote'] as const).includes(
        request.resource.providerTrust,
      ) ||
      !(['system', 'user', 'workspace', 'untrusted'] as const).includes(
        request.resource.provenanceTrust,
      ) ||
      !(['clean', 'blocked'] as const).includes(request.resource.secretScan)
    )
      return false;
    if (request.providerEgress !== request.resource.providerTrust) return false;
  }
  if (request.resource.kind === 'provider-disclosure') {
    const segments = request.resource.canonicalPath.split(/[\\/]+/);
    if (
      request.resource.providerId.length === 0 ||
      request.resource.canonicalPath.length === 0 ||
      request.resource.canonicalPath.includes('\0') ||
      segments.includes('.') ||
      segments.includes('..') ||
      !/^[a-f0-9]{64}$/.test(request.resource.sourceDigest) ||
      !/^[a-f0-9]{64}$/.test(request.resource.disclosedDigest) ||
      !(['sensitive', 'uncertain'] as const).includes(request.resource.classification) ||
      !PATH_CLASSIFICATIONS.includes(request.resource.pathClassification) ||
      !Array.isArray(request.resource.reasons) ||
      request.resource.reasons.length === 0 ||
      request.resource.reasons.some(
        (reason) => typeof reason !== 'string' || reason.length === 0 || reason.length > 128,
      ) ||
      request.resource.classifierVersion.length === 0
    )
      return false;
  }
  if (request.resource.kind === 'workspace-path' || request.resource.kind === 'external-path') {
    const segments = request.resource.canonicalPath.split(/[\\/]+/);
    if (
      request.resource.canonicalPath.length === 0 ||
      request.resource.canonicalPath.includes('\0') ||
      segments.includes('.') ||
      segments.includes('..') ||
      !/^[a-f0-9]{64}$/.test(request.resource.identityDigest) ||
      !PATH_CLASSIFICATIONS.includes(request.resource.classification)
    )
      return false;
    if (request.resource.kind === 'workspace-path' && request.resource.workspaceId.length === 0)
      return false;
  }
  if (request.resource.kind === 'network') {
    try {
      const url = new URL(request.resource.origin);
      if (
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.origin !== request.resource.origin ||
        (url.protocol !== 'https:' && url.protocol !== 'http:')
      )
        return false;
    } catch {
      return false;
    }
  }
  if (
    request.resource.kind === 'computer-app' ||
    request.resource.kind === 'computer-window' ||
    request.resource.kind === 'computer-session' ||
    request.resource.kind === 'computer-revision'
  ) {
    const computer = request.resource;
    if (
      !(['darwin', 'win32'] as const).includes(computer.platform) ||
      !/^[a-f0-9]{64}$/.test(computer.appIdentityDigest)
    )
      return false;
    if (computer.kind !== 'computer-app' && !/^[a-f0-9]{64}$/.test(computer.windowIdentityDigest))
      return false;
    if (
      (computer.kind === 'computer-session' || computer.kind === 'computer-revision') &&
      computer.sessionId.length === 0
    )
      return false;
    if (computer.kind === 'computer-session' && computer.taskId.length === 0) return false;
    if (
      computer.kind === 'computer-revision' &&
      (!Number.isSafeInteger(computer.revision) || computer.revision < 0)
    )
      return false;
  }
  if (
    request.resource.kind === 'computer-target-list' ||
    request.resource.kind === 'computer-target-access'
  ) {
    // The Task is the whole binding: there is no app identity yet, and the request must not be able
    // to enumerate, or reach for the desktop, on behalf of a Task other than the one being
    // evaluated.
    if (request.resource.taskId.length === 0 || request.resource.taskId !== request.taskId)
      return false;
  }
  const resourceMatchesCapability =
    request.capability === 'workspace.read' || request.capability === 'workspace.write'
      ? request.resource.kind === 'workspace-path' ||
        (request.capability === 'workspace.read' && request.resource.kind === 'provider-disclosure')
      : request.capability === 'filesystem.external.read' ||
          request.capability === 'filesystem.external.write'
        ? request.resource.kind === 'external-path'
        : request.capability === 'network.fetch'
          ? request.resource.kind === 'network'
          : request.capability === 'secret.use'
            ? request.resource.kind === 'secret'
            : request.capability === 'provider.egress'
              ? request.resource.kind === 'provider'
              : request.capability === 'external.open'
                ? request.resource.kind === 'external'
                : request.capability === 'shell.execute'
                  ? request.resource.kind === 'external' ||
                    request.resource.kind === 'workspace-path' ||
                    request.resource.kind === 'external-path'
                  : request.capability === 'computer.observe' ||
                      request.capability === 'computer.control'
                    ? request.resource.kind === 'computer-app' ||
                      request.resource.kind === 'computer-window' ||
                      request.resource.kind === 'computer-session' ||
                      request.resource.kind === 'computer-revision' ||
                      // Enumeration is observe-only: there is nothing to drive through a list, so
                      // `computer.control` must never accept it. Pre-session access is the mirror
                      // image — it is how a Task asks to drive something and how it begins, so
                      // `computer.observe` must never accept that.
                      (request.capability === 'computer.observe' &&
                        request.resource.kind === 'computer-target-list') ||
                      (request.capability === 'computer.control' &&
                        request.resource.kind === 'computer-target-access')
                    : request.resource.kind === 'workspace-path' ||
                      request.resource.kind === 'external-path';
  return resourceMatchesCapability;
}

function evaluation(
  decision: PermissionDecision,
  reason: string,
  policyEpoch: number,
  evaluationTrace: EvaluationStage[],
  permit?: ExecutionPermit,
): PermissionEvaluation {
  return permit === undefined
    ? { decision, reason, policyEpoch, evaluationTrace }
    : { decision, reason, policyEpoch, evaluationTrace, permit };
}

function createPermit(
  request: PermissionRequest,
  policy: PermissionPolicy,
  source: ExecutionPermit['source'],
  expiryCandidates: readonly string[],
  sourceGrantId?: string,
  oneTimeToken?: string,
): ExecutionPermit {
  return Object.freeze({
    taskId: request.taskId,
    subjectId: request.subjectId,
    capability: request.capability,
    operation: request.operation,
    resourceIdentity: permissionResourceIdentity(request.resource),
    executionSpecDigest: request.executionSpecDigest,
    policyEpoch: policy.policyEpoch,
    expiresAt: [...expiryCandidates].sort(
      (left, right) => Date.parse(left) - Date.parse(right),
    )[0]!,
    source,
    ...(sourceGrantId === undefined ? {} : { sourceGrantId }),
    ...(oneTimeToken === undefined ? {} : { oneTimeToken }),
    ...(source !== 'reviewer_allow_once' || policy.reviewerDecision === undefined
      ? {}
      : {
          reviewRequestId: policy.reviewerDecision.reviewRequestId,
          turnId: policy.reviewerDecision.turnId,
          callId: policy.reviewerDecision.callId,
        }),
  });
}

export function revalidateExecutionPermit(input: {
  permit: ExecutionPermit;
  request: PermissionRequest;
  policyEpoch: number;
  now: string;
  consumeOneTimeToken?: (token: string) => boolean;
}): { valid: true } | { valid: false; reason: string } {
  if (!Number.isFinite(Date.parse(input.now))) return { valid: false, reason: 'invalid_time' };
  if (input.permit.policyEpoch !== input.policyEpoch)
    return { valid: false, reason: 'policy_epoch_changed' };
  if (Date.parse(input.permit.expiresAt) <= Date.parse(input.now))
    return { valid: false, reason: 'permit_expired' };
  if (input.permit.executionSpecDigest !== input.request.executionSpecDigest)
    return { valid: false, reason: 'execution_spec_changed' };
  if (
    input.permit.taskId !== input.request.taskId ||
    input.permit.subjectId !== input.request.subjectId ||
    input.permit.capability !== input.request.capability ||
    input.permit.operation !== input.request.operation ||
    input.permit.resourceIdentity !== permissionResourceIdentity(input.request.resource)
  )
    return { valid: false, reason: 'permission_facts_changed' };
  if (input.permit.source === 'reviewer_allow_once') {
    if (
      input.permit.oneTimeToken === undefined ||
      input.consumeOneTimeToken === undefined ||
      !input.consumeOneTimeToken(input.permit.oneTimeToken)
    )
      return { valid: false, reason: 'one_time_permit_unavailable_or_consumed' };
  }
  return { valid: true };
}

/**
 * Stable, path-free identity used by permits and reviewer bindings.  Computer Use identities are
 * represented only by their app/window/session digests; titles, paths, handles, and screen text
 * never enter this value.
 */
export function permissionResourceIdentity(resource: PermissionResource): string {
  if (resource.kind === 'workspace-path')
    return JSON.stringify([
      resource.kind,
      resource.workspaceId,
      resource.canonicalPath,
      resource.identityDigest,
      resource.classification,
    ]);
  if (resource.kind === 'external-path')
    return JSON.stringify([
      resource.kind,
      resource.canonicalPath,
      resource.identityDigest,
      resource.classification,
    ]);
  if (resource.kind === 'network') return JSON.stringify([resource.kind, resource.origin]);
  if (resource.kind === 'secret') return JSON.stringify([resource.kind, resource.secretId]);
  if (resource.kind === 'external') return JSON.stringify([resource.kind, resource.target]);
  if (resource.kind === 'computer-app')
    return JSON.stringify([resource.kind, resource.platform, resource.appIdentityDigest]);
  if (resource.kind === 'computer-window')
    return JSON.stringify([
      resource.kind,
      resource.platform,
      resource.appIdentityDigest,
      resource.windowIdentityDigest,
    ]);
  if (resource.kind === 'computer-session')
    return JSON.stringify([
      resource.kind,
      resource.platform,
      resource.appIdentityDigest,
      resource.windowIdentityDigest,
      resource.sessionId,
      resource.taskId,
    ]);
  if (resource.kind === 'computer-revision')
    return JSON.stringify([
      resource.kind,
      resource.platform,
      resource.appIdentityDigest,
      resource.windowIdentityDigest,
      resource.sessionId,
      resource.revision,
    ]);
  if (resource.kind === 'computer-target-list' || resource.kind === 'computer-target-access')
    return JSON.stringify([resource.kind, resource.taskId]);
  if (resource.kind === 'provider-disclosure')
    return JSON.stringify([
      resource.kind,
      resource.providerId,
      resource.canonicalPath,
      resource.sourceDigest,
      resource.disclosedDigest,
      resource.classification,
      resource.reasons,
      resource.classifierVersion,
    ]);
  return JSON.stringify([
    resource.kind,
    resource.providerId,
    resource.fragmentKind,
    resource.byteCount,
    resource.providerTrust,
    resource.dataResidency,
    resource.provenanceTrust,
    resource.secretScan,
    resource.localOnlyTask,
    resource.attachmentManifestDigest,
    resource.attachmentByteCount,
  ]);
}

export const permissionResourceFingerprint = permissionResourceIdentity;

export function permissionRequestFingerprint(request: PermissionRequest): string {
  const resourceFacts =
    request.resource.kind === 'workspace-path'
      ? [
          request.resource.kind,
          request.resource.workspaceId,
          request.resource.identityDigest,
          request.resource.classification,
        ]
      : request.resource.kind === 'external-path'
        ? [request.resource.kind, request.resource.identityDigest, request.resource.classification]
        : request.resource.kind === 'computer-app' ||
            request.resource.kind === 'computer-window' ||
            request.resource.kind === 'computer-session' ||
            request.resource.kind === 'computer-revision' ||
            request.resource.kind === 'computer-target-list' ||
            request.resource.kind === 'computer-target-access'
          ? permissionResourceIdentity(request.resource)
          : request.resource;
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.taskId,
        request.subjectId,
        request.capability,
        request.operation,
        resourceFacts,
        request.providerEgress,
        request.sandboxProfile,
        request.executionSpecDigest,
        request.reviewerInputDigest,
        request.risk,
      ]),
    )
    .digest('hex');
}

function findCeilingEntry(
  ceiling: CapabilityCeiling,
  request: PermissionRequest,
  now: string,
): CapabilityCeilingEntry | undefined {
  return ceiling.entries.find(
    (entry) =>
      entry.capability === request.capability &&
      resourceContains(entry.resourceSet, request.resource) &&
      entry.operations.includes(request.operation) &&
      Date.parse(entry.expiresAt) > Date.parse(now) &&
      entry.providerEgress.includes(request.providerEgress) &&
      entry.sandboxProfiles.includes(request.sandboxProfile),
  );
}

function ruleMatches(rule: PermissionRule, request: PermissionRequest): boolean {
  return (
    rule.capability === request.capability &&
    rule.operations.includes(request.operation) &&
    resourceContains(rule.resourceSet, request.resource)
  );
}

export function sessionGrantMatchesPermissionRequest(
  grant: SessionGrant,
  request: PermissionRequest,
  policyEpoch: number,
  now: string,
): boolean {
  return (
    grant.subjectId === request.subjectId &&
    grant.capability === request.capability &&
    grant.policyEpoch === policyEpoch &&
    grant.revokedAt === undefined &&
    grant.consumedAt === undefined &&
    grant.scope === 'task' &&
    Date.parse(grant.expiresAt) > Date.parse(now) &&
    grant.operations.includes(request.operation) &&
    grant.providerEgress.includes(request.providerEgress) &&
    grant.sandboxProfiles.includes(request.sandboxProfile) &&
    resourceContains(grant.resourceSet, request.resource) &&
    (request.capability === 'shell.execute'
      ? grant.executionSpecDigest === request.executionSpecDigest
      : grant.executionSpecDigest === undefined ||
        grant.executionSpecDigest === request.executionSpecDigest)
  );
}

/** Returns true only when a permission resource is inside the exact bounded resource set. */
export function resourceContains(set: ResourceSet, resource: PermissionResource): boolean {
  if (set.kind === 'all') return true;
  if (set.kind === 'workspace')
    return (
      resource.kind === 'workspace-path' &&
      (set.workspaceId === undefined || set.workspaceId === resource.workspaceId)
    );
  if (set.kind === 'path-exact')
    return (
      (resource.kind === 'workspace-path' || resource.kind === 'external-path') &&
      resource.canonicalPath === set.canonicalPath &&
      (set.workspaceId === undefined ||
        (resource.kind === 'workspace-path' && resource.workspaceId === set.workspaceId))
    );
  if (set.kind === 'path-prefix')
    return (
      (resource.kind === 'workspace-path' || resource.kind === 'external-path') &&
      pathIsWithin(resource.canonicalPath, set.canonicalPath) &&
      (set.workspaceId === undefined ||
        (resource.kind === 'workspace-path' && resource.workspaceId === set.workspaceId))
    );
  if (set.kind === 'path-classification')
    return (
      (resource.kind === 'workspace-path' || resource.kind === 'external-path') &&
      set.classifications.includes(resource.classification)
    );
  if (set.kind === 'network-origin')
    return resource.kind === 'network' && resource.origin === set.origin;
  if (set.kind === 'provider-egress')
    return (
      resource.kind === 'provider' &&
      set.providerIds.includes(resource.providerId) &&
      set.fragmentKinds.includes(resource.fragmentKind) &&
      Number.isSafeInteger(resource.byteCount) &&
      resource.byteCount >= 0 &&
      resource.byteCount <= set.maxBytes &&
      Number.isSafeInteger(resource.attachmentByteCount) &&
      resource.attachmentByteCount >= 0 &&
      attachmentEgressFactsValid(resource.attachmentManifestDigest, resource.attachmentByteCount) &&
      attachmentEgressFactsValid(set.attachmentManifestDigest, set.attachmentByteCount) &&
      resource.attachmentManifestDigest === set.attachmentManifestDigest &&
      resource.attachmentByteCount === set.attachmentByteCount &&
      set.allowedProviderTrust.includes(resource.providerTrust) &&
      set.allowedResidencies.includes(resource.dataResidency) &&
      set.allowedProvenance.includes(resource.provenanceTrust) &&
      (!set.requireSecretScanClean || resource.secretScan === 'clean') &&
      (!resource.localOnlyTask || resource.providerTrust === 'trusted-local')
    );
  if (set.kind === 'provider-disclosure')
    return (
      resource.kind === 'provider-disclosure' &&
      set.pathClassifications.includes(resource.pathClassification) &&
      set.classifications.includes(resource.classification)
    );
  if (set.kind === 'provider-disclosure-exact')
    return (
      resource.kind === 'provider-disclosure' &&
      resource.providerId === set.providerId &&
      resource.canonicalPath === set.canonicalPath &&
      resource.sourceDigest === set.sourceDigest &&
      resource.disclosedDigest === set.disclosedDigest &&
      resource.classifierVersion === set.classifierVersion
    );
  if (set.kind === 'secret-exact')
    return resource.kind === 'secret' && resource.secretId === set.secretId;
  if (set.kind === 'computer-app' || set.kind === 'computer-app-exact')
    return (
      isComputerResource(resource) &&
      resource.appIdentityDigest === set.appIdentityDigest &&
      (set.platform === undefined || resource.platform === set.platform)
    );
  if (set.kind === 'computer-window' || set.kind === 'computer-window-exact')
    return (
      isComputerResource(resource) &&
      resource.kind !== 'computer-app' &&
      resource.appIdentityDigest === set.appIdentityDigest &&
      resource.windowIdentityDigest === set.windowIdentityDigest &&
      (set.platform === undefined || resource.platform === set.platform)
    );
  if (set.kind === 'computer-session' || set.kind === 'computer-session-exact')
    return (
      (resource.kind === 'computer-session' || resource.kind === 'computer-revision') &&
      resource.sessionId === set.sessionId &&
      resource.appIdentityDigest === set.appIdentityDigest &&
      (set.windowIdentityDigest === undefined ||
        resource.windowIdentityDigest === set.windowIdentityDigest) &&
      (set.platform === undefined || resource.platform === set.platform)
    );
  if (set.kind === 'computer-revision' || set.kind === 'computer-revision-exact')
    return (
      resource.kind === 'computer-revision' &&
      resource.sessionId === set.sessionId &&
      resource.revision === set.revision &&
      (set.appIdentityDigest === undefined ||
        resource.appIdentityDigest === set.appIdentityDigest) &&
      (set.windowIdentityDigest === undefined ||
        resource.windowIdentityDigest === set.windowIdentityDigest) &&
      (set.platform === undefined || resource.platform === set.platform)
    );
  if (set.kind === 'computer-target-list' || set.kind === 'computer-target-list-exact')
    return (
      resource.kind === 'computer-target-list' &&
      (set.taskId === undefined || resource.taskId === set.taskId)
    );
  if (set.kind === 'computer-target-access' || set.kind === 'computer-target-access-exact')
    return (
      resource.kind === 'computer-target-access' &&
      (set.taskId === undefined || resource.taskId === set.taskId)
    );
  if (set.kind === 'external-exact')
    return resource.kind === 'external' && resource.target === set.target;
  return false;
}

export const permissionResourceContains = resourceContains;

function isComputerResource(
  resource: PermissionResource,
): resource is Extract<
  PermissionResource,
  { kind: 'computer-app' | 'computer-window' | 'computer-session' | 'computer-revision' }
> {
  return (
    resource.kind === 'computer-app' ||
    resource.kind === 'computer-window' ||
    resource.kind === 'computer-session' ||
    resource.kind === 'computer-revision'
  );
}

function isComputerResourceSet(resourceSet: ResourceSet): boolean {
  return (
    resourceSet.kind === 'computer-app' ||
    resourceSet.kind === 'computer-app-exact' ||
    resourceSet.kind === 'computer-window' ||
    resourceSet.kind === 'computer-window-exact' ||
    resourceSet.kind === 'computer-session' ||
    resourceSet.kind === 'computer-session-exact' ||
    resourceSet.kind === 'computer-revision' ||
    resourceSet.kind === 'computer-revision-exact' ||
    resourceSet.kind === 'computer-target-list' ||
    resourceSet.kind === 'computer-target-list-exact' ||
    resourceSet.kind === 'computer-target-access' ||
    resourceSet.kind === 'computer-target-access-exact'
  );
}

function pathIsWithin(candidate: string, root: string): boolean {
  const windowsPath = /^[a-z]:[\\/]/i.test(candidate) || /^[a-z]:[\\/]/i.test(root);
  const normalize = (value: string) => {
    const normalized = value.normalize('NFC').replaceAll('\\', '/');
    return windowsPath ? normalized.toLocaleLowerCase('en-US') : normalized;
  };
  const normalizedCandidate = normalize(candidate);
  const normalizedRoot = normalize(root).replace(/\/+$/, '') || '/';
  if (normalizedRoot === '/') return normalizedCandidate.startsWith('/');
  return (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

function sandboxRank(profile: SandboxProfile): number {
  return profile === 'read-only' ? 0 : profile === 'workspace-write' ? 1 : 2;
}

export type PermissionActivity = {
  id: string;
  kind: 'child' | 'background' | 'outbox';
  requiredCapabilities: readonly Capability[];
};

export function revokeCapability(input: {
  state: {
    policyEpoch: number;
    grants: readonly SessionGrant[];
    activities: readonly PermissionActivity[];
  };
  selector: { capability: Capability };
  now: string;
}): {
  policyEpoch: number;
  grants: SessionGrant[];
  stopActivityIds: string[];
  reevaluateActivityIds: string[];
} {
  const affected = input.state.activities.filter((activity) =>
    activity.requiredCapabilities.includes(input.selector.capability),
  );
  return {
    policyEpoch: input.state.policyEpoch + 1,
    grants: input.state.grants.filter(
      (grant) =>
        grant.capability !== input.selector.capability &&
        Date.parse(grant.expiresAt) > Date.parse(input.now),
    ),
    stopActivityIds: affected
      .filter((activity) => activity.kind !== 'outbox')
      .map((activity) => activity.id),
    reevaluateActivityIds: affected
      .filter((activity) => activity.kind === 'outbox')
      .map((activity) => activity.id),
  };
}

export class PermissionBroker {
  private readonly rememberedGrants: SessionGrant[];
  private readonly now: () => string;
  private readonly policy: PermissionPolicy;

  constructor(input: { subjectId: string; policy: PermissionPolicy; now: () => string }) {
    this.subjectId = input.subjectId;
    this.policy = deepFreeze(structuredClone(input.policy));
    this.now = input.now;
    this.rememberedGrants = input.policy.rememberedGrants.map(createSessionGrant);
  }

  private readonly subjectId: string;

  rememberGrant(grant: SessionGrant): void {
    this.rememberedGrants.push(createSessionGrant(grant));
  }

  evaluate(request: PermissionRequest): PermissionEvaluation {
    if (request.subjectId !== this.subjectId)
      return evaluation('deny', 'subject_mismatch', this.policy.policyEpoch, []);
    return evaluatePermissionPolicy({
      request,
      policy: { ...this.policy, rememberedGrants: this.rememberedGrants },
      now: this.now(),
    });
  }

  spawnChild(input: {
    subjectId: string;
    parentSubjectId: string;
    parentCeiling: CapabilityCeiling;
    policyEpoch: number;
  }): { evaluate: (request: PermissionRequest) => PermissionEvaluation } {
    if (input.parentSubjectId !== this.subjectId)
      throw new Error('Parent subject does not own this broker');
    if (input.policyEpoch !== this.policy.policyEpoch)
      throw new Error('Child policy epoch must match the current parent policy epoch');
    if (!ceilingIsSubset(input.parentCeiling, this.policy.parentCeiling))
      throw new Error('Child ceiling exceeds parent ceiling');
    const childPolicy: PermissionPolicy = deepFreeze({
      ...this.policy,
      parentCeiling: structuredClone(input.parentCeiling),
      rememberedGrants: [],
      policyEpoch: input.policyEpoch,
    });
    return {
      evaluate: (request) =>
        request.subjectId === input.subjectId
          ? evaluatePermissionPolicy({ request, policy: childPolicy, now: this.now() })
          : evaluation('deny', 'subject_mismatch', childPolicy.policyEpoch, []),
    };
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function ceilingIsSubset(candidate: CapabilityCeiling, parent: CapabilityCeiling): boolean {
  return (
    candidate.maxWorkerDepth <= parent.maxWorkerDepth &&
    candidate.maxConcurrentWorkers <= parent.maxConcurrentWorkers &&
    candidate.entries.every((entry) =>
      parent.entries.some(
        (parentEntry) =>
          entry.capability === parentEntry.capability &&
          resourceSetIsSubset(entry.resourceSet, parentEntry.resourceSet) &&
          entry.operations.every((operation) => parentEntry.operations.includes(operation)) &&
          Date.parse(entry.expiresAt) <= Date.parse(parentEntry.expiresAt) &&
          entry.providerEgress.every((egress) => parentEntry.providerEgress.includes(egress)) &&
          entry.sandboxProfiles.every((profile) => parentEntry.sandboxProfiles.includes(profile)),
      ),
    )
  );
}

/**
 * Checks the permission lattice without resolving a resource.  This is used when spawning a
 * worker, and is intentionally conservative for Computer Use: an app/window/session/revision
 * binding can only narrow to the same identity (or to a child revision), never to `all`.
 */
export function resourceSetIsSubset(candidate: ResourceSet, parent: ResourceSet): boolean {
  if (parent.kind === 'all') return true;
  if (candidate.kind === 'all') return false;
  if (candidate.kind === 'workspace' && parent.kind === 'workspace')
    return parent.workspaceId === undefined || candidate.workspaceId === parent.workspaceId;
  if (candidate.kind === 'path-exact') return resourceSetContainsPath(parent, candidate);
  if (candidate.kind === 'path-prefix' && parent.kind === 'path-prefix')
    return (
      pathIsWithin(candidate.canonicalPath, parent.canonicalPath) &&
      (parent.workspaceId === undefined || candidate.workspaceId === parent.workspaceId)
    );
  if (candidate.kind === 'path-classification' && parent.kind === 'path-classification')
    return candidate.classifications.every((value) => parent.classifications.includes(value));
  if (candidate.kind === 'network-origin' && parent.kind === 'network-origin')
    return candidate.origin === parent.origin;
  if (candidate.kind === 'secret-exact' && parent.kind === 'secret-exact')
    return candidate.secretId === parent.secretId;
  if (candidate.kind === 'external-exact' && parent.kind === 'external-exact')
    return candidate.target === parent.target;
  if (candidate.kind === 'provider-egress' && parent.kind === 'provider-egress')
    return (
      attachmentEgressFactsValid(
        candidate.attachmentManifestDigest,
        candidate.attachmentByteCount,
      ) &&
      attachmentEgressFactsValid(parent.attachmentManifestDigest, parent.attachmentByteCount) &&
      candidate.providerIds.every((value) => parent.providerIds.includes(value)) &&
      candidate.fragmentKinds.every((value) => parent.fragmentKinds.includes(value)) &&
      candidate.maxBytes <= parent.maxBytes &&
      candidate.allowedProviderTrust.every((value) =>
        parent.allowedProviderTrust.includes(value),
      ) &&
      candidate.allowedResidencies.every((value) => parent.allowedResidencies.includes(value)) &&
      candidate.allowedProvenance.every((value) => parent.allowedProvenance.includes(value)) &&
      (!parent.requireSecretScanClean || candidate.requireSecretScanClean) &&
      (!candidate.allowLocalOnlyTaskRemote || parent.allowLocalOnlyTaskRemote) &&
      candidate.attachmentManifestDigest === parent.attachmentManifestDigest &&
      candidate.attachmentByteCount === parent.attachmentByteCount
    );
  if (candidate.kind === 'provider-disclosure' && parent.kind === 'provider-disclosure')
    return (
      candidate.pathClassifications.every((value) => parent.pathClassifications.includes(value)) &&
      candidate.classifications.every((value) => parent.classifications.includes(value))
    );
  if (candidate.kind === 'provider-disclosure-exact' && parent.kind === 'provider-disclosure-exact')
    return (
      candidate.providerId === parent.providerId &&
      candidate.canonicalPath === parent.canonicalPath &&
      candidate.sourceDigest === parent.sourceDigest &&
      candidate.disclosedDigest === parent.disclosedDigest &&
      candidate.classifierVersion === parent.classifierVersion
    );
  if (
    (candidate.kind === 'computer-app' || candidate.kind === 'computer-app-exact') &&
    (parent.kind === 'computer-app' || parent.kind === 'computer-app-exact')
  )
    return (
      candidate.appIdentityDigest === parent.appIdentityDigest &&
      (parent.platform === undefined || candidate.platform === parent.platform)
    );
  if (
    (candidate.kind === 'computer-window' || candidate.kind === 'computer-window-exact') &&
    (parent.kind === 'computer-app' || parent.kind === 'computer-app-exact')
  )
    return (
      candidate.appIdentityDigest === parent.appIdentityDigest &&
      (parent.platform === undefined || candidate.platform === parent.platform)
    );
  if (
    (candidate.kind === 'computer-session' || candidate.kind === 'computer-session-exact') &&
    (parent.kind === 'computer-app' || parent.kind === 'computer-app-exact')
  )
    return (
      candidate.appIdentityDigest === parent.appIdentityDigest &&
      (parent.platform === undefined || candidate.platform === parent.platform)
    );
  if (
    (candidate.kind === 'computer-revision' || candidate.kind === 'computer-revision-exact') &&
    (parent.kind === 'computer-app' || parent.kind === 'computer-app-exact')
  )
    return (
      candidate.appIdentityDigest === parent.appIdentityDigest &&
      (parent.platform === undefined || candidate.platform === parent.platform)
    );
  if (
    (candidate.kind === 'computer-window' || candidate.kind === 'computer-window-exact') &&
    (parent.kind === 'computer-window' || parent.kind === 'computer-window-exact')
  )
    return (
      candidate.appIdentityDigest === parent.appIdentityDigest &&
      candidate.windowIdentityDigest === parent.windowIdentityDigest &&
      (parent.platform === undefined || candidate.platform === parent.platform)
    );
  if (
    (candidate.kind === 'computer-session' || candidate.kind === 'computer-session-exact') &&
    (parent.kind === 'computer-window' || parent.kind === 'computer-window-exact')
  )
    return (
      candidate.appIdentityDigest === parent.appIdentityDigest &&
      candidate.windowIdentityDigest === parent.windowIdentityDigest &&
      (parent.platform === undefined || candidate.platform === parent.platform)
    );
  if (
    (candidate.kind === 'computer-revision' || candidate.kind === 'computer-revision-exact') &&
    (parent.kind === 'computer-window' || parent.kind === 'computer-window-exact')
  )
    return (
      candidate.appIdentityDigest === parent.appIdentityDigest &&
      candidate.windowIdentityDigest === parent.windowIdentityDigest &&
      (parent.platform === undefined || candidate.platform === parent.platform)
    );
  if (
    (candidate.kind === 'computer-session' || candidate.kind === 'computer-session-exact') &&
    (parent.kind === 'computer-session' || parent.kind === 'computer-session-exact')
  )
    return (
      candidate.sessionId === parent.sessionId &&
      candidate.appIdentityDigest === parent.appIdentityDigest &&
      (parent.windowIdentityDigest === undefined ||
        candidate.windowIdentityDigest === parent.windowIdentityDigest) &&
      (parent.platform === undefined || candidate.platform === parent.platform)
    );
  if (
    (candidate.kind === 'computer-revision' || candidate.kind === 'computer-revision-exact') &&
    (parent.kind === 'computer-session' || parent.kind === 'computer-session-exact')
  )
    return (
      candidate.sessionId === parent.sessionId &&
      candidate.appIdentityDigest === parent.appIdentityDigest &&
      (parent.windowIdentityDigest === undefined ||
        candidate.windowIdentityDigest === parent.windowIdentityDigest) &&
      (parent.platform === undefined || candidate.platform === parent.platform)
    );
  if (
    (candidate.kind === 'computer-revision' || candidate.kind === 'computer-revision-exact') &&
    (parent.kind === 'computer-revision' || parent.kind === 'computer-revision-exact')
  )
    return (
      candidate.sessionId === parent.sessionId &&
      candidate.revision === parent.revision &&
      (parent.appIdentityDigest === undefined ||
        candidate.appIdentityDigest === parent.appIdentityDigest) &&
      (parent.windowIdentityDigest === undefined ||
        candidate.windowIdentityDigest === parent.windowIdentityDigest) &&
      (parent.platform === undefined || candidate.platform === parent.platform)
    );
  return false;
}

export const permissionResourceSetIsSubset = resourceSetIsSubset;
export const isResourceSetSubset = resourceSetIsSubset;

function attachmentEgressFactsValid(manifestDigest: string | null, byteCount: number): boolean {
  return (
    Number.isSafeInteger(byteCount) &&
    byteCount >= 0 &&
    (manifestDigest === null
      ? byteCount === 0
      : /^[a-f0-9]{64}$/.test(manifestDigest) && byteCount > 0)
  );
}

function resourceSetContainsPath(
  parent: ResourceSet,
  candidate: Extract<ResourceSet, { kind: 'path-exact' }>,
): boolean {
  if (parent.kind === 'path-exact')
    return (
      parent.canonicalPath === candidate.canonicalPath &&
      (parent.workspaceId === undefined || parent.workspaceId === candidate.workspaceId)
    );
  if (parent.kind === 'path-prefix')
    return (
      pathIsWithin(candidate.canonicalPath, parent.canonicalPath) &&
      (parent.workspaceId === undefined || parent.workspaceId === candidate.workspaceId)
    );
  return false;
}

export type ParsedShell =
  | {
      ok: true;
      autoAllowEligible: false;
      segments: { executable: string; argv: string[] }[];
    }
  | { ok: false; autoAllowEligible: false; reason: string };

export function parseShellSegments(command: string): ParsedShell {
  if (
    command.length === 0 ||
    /\$\(|`|\$\{|\$[A-Za-z_]|\$'|#|[()<>*?{}]|\[|\]|(^|[\s;|&])~(?=\/|\s|$)/.test(command)
  )
    return { ok: false, autoAllowEligible: false, reason: 'unsupported_shell_syntax' };
  const segments: string[][] = [[]];
  let token = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const pushToken = (): void => {
    if (token.length === 0) return;
    segments[segments.length - 1]?.push(token);
    token = '';
  };
  const pushSegment = (): boolean => {
    pushToken();
    if ((segments[segments.length - 1]?.length ?? 0) === 0) return false;
    segments.push([]);
    return true;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] as string;
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '\n' || character === '\r') {
      if (!pushSegment())
        return { ok: false, autoAllowEligible: false, reason: 'empty_shell_segment' };
      if (character === '\r' && command[index + 1] === '\n') index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      pushToken();
      continue;
    }
    if (character === ';' || character === '|') {
      if (!pushSegment())
        return { ok: false, autoAllowEligible: false, reason: 'empty_shell_segment' };
      if (command[index + 1] === character) index += 1;
      continue;
    }
    if (character === '&' && command[index + 1] === '&') {
      if (!pushSegment())
        return { ok: false, autoAllowEligible: false, reason: 'empty_shell_segment' };
      index += 1;
      continue;
    }
    if (character === '&')
      return { ok: false, autoAllowEligible: false, reason: 'background_shell_unsupported' };
    token += character;
  }
  if (quote !== null || escaped)
    return { ok: false, autoAllowEligible: false, reason: 'unclosed_shell_token' };
  pushToken();
  if ((segments[segments.length - 1]?.length ?? 0) === 0) segments.pop();
  if (segments.length === 0)
    return { ok: false, autoAllowEligible: false, reason: 'empty_shell_command' };
  return {
    ok: true,
    autoAllowEligible: false,
    segments: segments.map(([executable, ...argv]) => ({ executable: executable as string, argv })),
  };
}

export function evaluateShellSegments(
  command: string,
  authorize: (
    segment: { executable: string; argv: readonly string[] },
    index: number,
  ) => PermissionEvaluation,
):
  | {
      ok: true;
      autoAllowEligible: false;
      decision: PermissionDecision;
      reason: string;
      evaluations: PermissionEvaluation[];
      permits?: ExecutionPermit[];
    }
  | Extract<ParsedShell, { ok: false }> {
  const parsed = parseShellSegments(command);
  if (!parsed.ok) return parsed;
  const evaluations = parsed.segments.map((segment, index) => authorize(segment, index));
  const denied = evaluations.find(({ decision }) => decision === 'deny');
  if (denied !== undefined)
    return {
      ok: true,
      autoAllowEligible: false,
      decision: 'deny',
      reason: denied.reason,
      evaluations,
    };
  const approval = evaluations.find(({ decision }) => decision === 'approval_required');
  if (approval !== undefined)
    return {
      ok: true,
      autoAllowEligible: false,
      decision: 'approval_required',
      reason: approval.reason,
      evaluations,
    };
  const permits = evaluations.flatMap(({ permit }) => (permit === undefined ? [] : [permit]));
  if (permits.length !== evaluations.length)
    return {
      ok: true,
      autoAllowEligible: false,
      decision: 'deny',
      reason: 'missing_segment_permit',
      evaluations,
    };
  return {
    ok: true,
    autoAllowEligible: false,
    decision: evaluations.some(({ decision }) => decision === 'allow_once')
      ? 'allow_once'
      : 'allow',
    reason: 'all_shell_segments_authorized',
    evaluations,
    permits,
  };
}
