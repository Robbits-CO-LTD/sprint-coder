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
] as const;

export type Capability = (typeof capabilities)[number];
export type PermissionOperation =
  'read' | 'write' | 'execute' | 'fetch' | 'open' | 'use' | 'egress';
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
      reasons: readonly string[];
      classifierVersion: string;
    }
  | { kind: 'secret'; secretId: string }
  | { kind: 'external'; target: string };

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
  | { kind: 'secret-exact'; secretId: string }
  | { kind: 'external-exact'; target: string }
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

const FULL_RULES: readonly PermissionRule[] = [
  ...SAFE_AUTO_RULES,
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
      allowRules: cloneRules(SAFE_AUTO_RULES),
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
    grantMatches(grant, request, policy.policyEpoch, now),
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
      ![
        'workspace',
        'external',
        'app-private',
        'os-protected',
        'credential',
        'signing-key',
        'update-key',
        'unclassified',
      ].includes(request.resource.classification)
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

function permissionResourceIdentity(resource: PermissionResource): string {
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

function grantMatches(
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

function resourceContains(set: ResourceSet, resource: PermissionResource): boolean {
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
  return resource.kind === 'external' && resource.target === set.target;
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

function resourceSetIsSubset(candidate: ResourceSet, parent: ResourceSet): boolean {
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
  if (candidate.kind === 'provider-disclosure-exact' && parent.kind === 'provider-disclosure-exact')
    return (
      candidate.providerId === parent.providerId &&
      candidate.canonicalPath === parent.canonicalPath &&
      candidate.sourceDigest === parent.sourceDigest &&
      candidate.disclosedDigest === parent.disclosedDigest &&
      candidate.classifierVersion === parent.classifierVersion
    );
  return false;
}

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
