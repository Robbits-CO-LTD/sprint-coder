import { Buffer } from 'node:buffer';
import type { TaskSummary } from '@sprint-coder/contracts';
import type { PermissionEvaluation, PermissionRequest } from '@sprint-coder/domain';
import { digestCanonical } from './context-compiler';
import type { PreparedContext } from './context-ledger';
import { PermissionBroker } from './permission-broker';
import { redactSecrets } from './secret-redactor';

const PROVIDER_ID = 'openai-codex';
const PROVIDER_TRUST = 'trusted-remote' as const;
const DATA_RESIDENCY = 'unspecified';

export type ProviderEgressDecision = Readonly<{
  allowed: boolean;
  evaluation: PermissionEvaluation;
}>;

export function dispatchAfterCodexProviderEgress(
  input: Parameters<typeof authorizeCodexProviderEgress>[0],
  dispatch: () => void,
): ProviderEgressDecision {
  const decision = authorizeCodexProviderEgress(input);
  if (decision.allowed) dispatch();
  return decision;
}

export function authorizeCodexProviderEgress(input: {
  broker: PermissionBroker;
  task: TaskSummary;
  turnId: string;
  prompt: string;
  context: PreparedContext;
  now: string;
}): ProviderEgressDecision {
  const content = [
    input.prompt,
    ...input.context.fragments.map((fragment) => fragment.content),
  ].join('\n');
  const secretScan = redactSecrets(content) === content ? ('clean' as const) : ('blocked' as const);
  const byteCount = Buffer.byteLength(content, 'utf8');
  const provenanceTrust = input.context.fragments.some((fragment) => fragment.trust === 'assistant')
    ? ('untrusted' as const)
    : input.context.fragments.every((fragment) => fragment.source === 'system')
      ? ('system' as const)
      : ('user' as const);
  const fragmentKind = [
    'prompt',
    ...new Set(input.context.fragments.map((fragment) => fragment.source)),
  ]
    .sort()
    .join('+');
  const resource = {
    kind: 'provider' as const,
    providerId: PROVIDER_ID,
    fragmentKind,
    byteCount,
    providerTrust: PROVIDER_TRUST,
    dataResidency: DATA_RESIDENCY,
    provenanceTrust,
    secretScan,
    localOnlyTask: input.task.localOnly,
  };
  const executionSpecDigest = digestCanonical({
    providerId: PROVIDER_ID,
    turnId: input.turnId,
    promptDigest: digestCanonical(input.prompt),
    context: input.context.fragments.map((fragment) => ({
      id: fragment.id,
      contentDigest: digestCanonical(fragment.content),
    })),
  });
  const requestBase = {
    taskId: input.task.id,
    subjectId: `runtime:codex:${input.turnId}`,
    capability: 'provider.egress' as const,
    resource,
    operation: 'egress' as const,
    providerEgress: PROVIDER_TRUST,
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
    providerIds: [PROVIDER_ID],
    fragmentKinds: [fragmentKind],
    maxBytes: byteCount,
    allowedProviderTrust: [PROVIDER_TRUST],
    allowedResidencies: [DATA_RESIDENCY],
    allowedProvenance: [provenanceTrust],
    requireSecretScanClean: true,
    allowLocalOnlyTaskRemote: false,
  };
  const ceiling = {
    entries: [
      {
        capability: 'provider.egress' as const,
        resourceSet,
        operations: ['egress' as const],
        expiresAt: new Date(Date.parse(input.now) + 60_000).toISOString(),
        providerEgress: [PROVIDER_TRUST],
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
        auditReason: 'codex_provider_egress',
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
