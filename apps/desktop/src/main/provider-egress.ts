import { Buffer } from 'node:buffer';
import type { TaskSummary } from '@sprint-coder/contracts';
import type { PermissionEvaluation, PermissionRequest, ProviderEgress } from '@sprint-coder/domain';
import { digestCanonical } from './context-compiler';
import type { PreparedContext } from './context-ledger';
import type { PermissionBroker } from './permission-broker';
import { redactSecrets } from './secret-redactor';

export type ProviderEgressDecision = Readonly<{
  allowed: boolean;
  evaluation: PermissionEvaluation;
}>;

export type ProviderEgressInput = {
  broker: PermissionBroker;
  task: TaskSummary;
  turnId: string;
  prompt: string;
  context: PreparedContext;
  now: string;
  payloadDigest?: string;
  adapterVersion?: string;
  connectionId?: string;
  modelId?: string;
  endpointTrust?: 'trusted-local' | 'trusted-remote' | 'untrusted';
  round?: number;
  toolCatalogDigest?: string;
  attachmentManifestDigest?: string;
  attachmentByteCount?: number;
};

export function dispatchAfterCodexProviderEgress(
  input: ProviderEgressInput,
  dispatch: () => void,
): ProviderEgressDecision {
  const decision = authorizeCodexProviderEgress(input);
  if (decision.allowed) dispatch();
  return decision;
}

export function authorizeCodexProviderEgress(input: ProviderEgressInput): ProviderEgressDecision {
  return authorizeProviderEgress(
    input,
    'openai-codex',
    'codex',
    'codex_provider_egress',
    'trusted-remote',
  );
}

// Additive twin for the Claude CLI runtime (Slice 3.4): same gate shape and same generic
// 'provider.egress' capability, distinguished only by providerId/subjectId/audit reason so
// existing Codex audit trails and Capability policy grants are unaffected.
export function dispatchAfterClaudeProviderEgress(
  input: ProviderEgressInput,
  dispatch: () => void,
): ProviderEgressDecision {
  const decision = authorizeClaudeProviderEgress(input);
  if (decision.allowed) dispatch();
  return decision;
}

export function authorizeClaudeProviderEgress(input: ProviderEgressInput): ProviderEgressDecision {
  return authorizeProviderEgress(
    input,
    'anthropic-claude-code',
    'claude',
    'claude_provider_egress',
    'trusted-remote',
  );
}

export function authorizeOfficialApiProviderEgress(
  input: ProviderEgressInput,
  providerId: string,
  providerTrust: Exclude<ProviderEgress, 'none'> = 'trusted-remote',
): ProviderEgressDecision {
  return authorizeProviderEgress(
    input,
    providerId,
    `official-api:${providerId}`,
    `${providerId}_official_api_egress`,
    providerTrust,
  );
}

function authorizeProviderEgress(
  input: ProviderEgressInput,
  providerId: string,
  subjectRuntime: string,
  auditReason: string,
  providerTrust: Exclude<ProviderEgress, 'none'>,
): ProviderEgressDecision {
  const content = [
    input.prompt,
    ...input.context.fragments.map((fragment) => fragment.content),
    ...input.context.projectItems.map((item) => item.content),
  ].join('\n');
  const secretScan = redactSecrets(content) === content ? ('clean' as const) : ('blocked' as const);
  const textByteCount = Buffer.byteLength(content, 'utf8');
  const attachmentManifestDigest = input.attachmentManifestDigest ?? null;
  const attachmentByteCount = input.attachmentByteCount ?? 0;
  if (
    !Number.isSafeInteger(attachmentByteCount) ||
    attachmentByteCount < 0 ||
    (attachmentManifestDigest === null) !== (attachmentByteCount === 0) ||
    (attachmentManifestDigest !== null && !/^[a-f0-9]{64}$/.test(attachmentManifestDigest))
  )
    throw new Error('Invalid provider attachment egress facts');
  const byteCount = textByteCount + attachmentByteCount;
  if (!Number.isSafeInteger(byteCount)) throw new Error('Provider egress byte count overflow');
  const provenanceTrust =
    input.context.fragments.some((fragment) => fragment.trust === 'assistant') ||
    input.context.projectItems.some((item) => item.authority === 'none')
      ? ('untrusted' as const)
      : input.context.fragments.every((fragment) => fragment.source === 'system') &&
          input.context.projectItems.length === 0
        ? ('system' as const)
        : ('user' as const);
  const fragmentKind = [
    'prompt',
    ...new Set(input.context.fragments.map((fragment) => fragment.source)),
    ...new Set(input.context.projectItems.map((item) => `project:${item.kind}`)),
  ]
    .sort()
    .join('+');
  const resource = {
    kind: 'provider' as const,
    providerId,
    fragmentKind,
    byteCount,
    providerTrust,
    dataResidency: providerTrust === 'trusted-local' ? 'local-device' : 'unspecified',
    provenanceTrust,
    secretScan,
    localOnlyTask:
      input.task.localOnly || input.context.projectItems.some((item) => item.localOnly),
    attachmentManifestDigest,
    attachmentByteCount,
  };
  const executionSpecDigest = digestCanonical({
    providerId,
    turnId: input.turnId,
    promptDigest: digestCanonical(input.prompt),
    context: input.context.fragments.map((fragment) => ({
      id: fragment.id,
      contentDigest: digestCanonical(fragment.content),
    })),
    projectItems: input.context.projectItems.map((item) => ({
      id: item.id,
      kind: item.kind,
      authority: item.authority,
      localOnly: item.localOnly,
      sealedDigest: item.sealedDigest,
    })),
    egressAudit: {
      payloadDigest: input.payloadDigest ?? digestCanonical(input.prompt),
      adapterVersion: input.adapterVersion ?? 'unknown',
      providerId,
      connectionId: input.connectionId ?? null,
      modelId: input.modelId ?? null,
      endpointTrust: input.endpointTrust ?? providerTrust,
      round: input.round ?? 1,
      toolCatalogDigest: input.toolCatalogDigest ?? digestCanonical([]),
      attachmentManifestDigest,
      attachmentByteCount,
    },
  });
  const requestBase = {
    taskId: input.task.id,
    subjectId: `runtime:${subjectRuntime}:${input.turnId}`,
    capability: 'provider.egress' as const,
    resource,
    operation: 'egress' as const,
    providerEgress: providerTrust,
    sandboxProfile: 'read-only' as const,
    executionSpecDigest,
    risk: 'high' as const,
  };
  const request: PermissionRequest = {
    ...requestBase,
    reviewerInputDigest: digestCanonical({ request: requestBase, source: 'main-provider-gate' }),
  };
  const resourceSet = {
    kind: 'provider-egress' as const,
    providerIds: [providerId],
    fragmentKinds: [fragmentKind],
    maxBytes: byteCount,
    allowedProviderTrust: [providerTrust],
    allowedResidencies: [providerTrust === 'trusted-local' ? 'local-device' : 'unspecified'],
    allowedProvenance: [provenanceTrust],
    requireSecretScanClean: true,
    allowLocalOnlyTaskRemote: false,
    attachmentManifestDigest,
    attachmentByteCount,
  };
  const ceiling = {
    entries: [
      {
        capability: 'provider.egress' as const,
        resourceSet,
        operations: ['egress' as const],
        expiresAt: new Date(Date.parse(input.now) + 60_000).toISOString(),
        providerEgress: [providerTrust],
        sandboxProfiles: ['read-only' as const],
      },
    ],
    maxWorkerDepth: 0,
    maxConcurrentWorkers: 0,
  };
  const basePolicy = {
    managedDeny: [],
    projectDeny: [],
    parentCeiling: ceiling,
    modeCeiling: ceiling,
    sandbox: { feasible: true, profile: 'read-only' as const },
    allowRules: [
      {
        capability: 'provider.egress' as const,
        resourceSet,
        operations: ['egress' as const],
        auditReason,
      },
    ],
  };
  const evaluationInput = {
    taskId: input.task.id,
    request,
    basePolicy,
    now: input.now,
  };
  const evaluation = input.broker.evaluate(evaluationInput);
  if (
    (evaluation.decision !== 'allow' && evaluation.decision !== 'allow_once') ||
    evaluation.permit === undefined
  )
    return Object.freeze({ allowed: false, evaluation });
  const revalidated = input.broker.revalidate({
    ...evaluationInput,
    permit: evaluation.permit,
    now: input.now,
  });
  const finalEvaluation: PermissionEvaluation = revalidated.valid
    ? evaluation
    : {
        decision: 'deny',
        reason: revalidated.reason,
        policyEpoch: evaluation.policyEpoch,
        evaluationTrace: [...evaluation.evaluationTrace, 'execution-revalidation'],
      };
  return Object.freeze({
    allowed: revalidated.valid,
    evaluation: finalEvaluation,
  });
}
