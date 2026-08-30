import { Buffer } from 'node:buffer';
import {
  COMPUTER_USE_LIMITS,
  type ProviderExecutionRequest,
  type TaskSummary,
} from '@sprint-coder/contracts';
import type { PermissionEvaluation, PermissionRequest, ProviderEgress } from '@sprint-coder/domain';
import { digestCanonical } from './context-compiler';
import type { PreparedContext } from './context-ledger';
import type { PermissionBroker } from './permission-broker';
import { assessProviderDisclosure } from './provider-disclosure-classifier';

export type ProviderEgressDecision = Readonly<{
  allowed: boolean;
  evaluation: PermissionEvaluation;
}>;

/**
 * The Computer Use provider path carries an ephemeral screenshot in addition to a bounded,
 * redacted accessibility projection.  Keep this separate from the normal Turn context so the
 * observation cannot accidentally enter chat history, context seals, or ToolImageBridge state.
 */
export type ComputerUseProviderEgressInput = Readonly<{
  broker: PermissionBroker;
  task: TaskSummary;
  turnId: string;
  sessionId: string;
  providerId: string;
  connectionId: string;
  modelId: string;
  prompt: string;
  screenshotMimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  screenshotDigest: string;
  screenshotByteCount: number;
  accessibilityTreeDigest: string;
  accessibilityTreeByteCount: number;
  now: string;
  endpointTrust?: 'trusted-local' | 'trusted-remote' | 'untrusted';
  round: number;
  signal?: AbortSignal;
}>;

export function authorizeComputerUseProviderEgress(
  input: ComputerUseProviderEgressInput,
): ProviderEgressDecision {
  if (input.signal?.aborted) {
    return Object.freeze({
      allowed: false,
      evaluation: {
        decision: 'deny' as const,
        reason: 'computer_use_provider_egress_canceled',
        policyEpoch: input.broker.getPolicy(input.task.id).policyEpoch,
        evaluationTrace: [],
      },
    });
  }
  if (
    !/^[a-f0-9]{64}$/.test(input.screenshotDigest) ||
    !/^[a-f0-9]{64}$/.test(input.accessibilityTreeDigest) ||
    !Number.isSafeInteger(input.screenshotByteCount) ||
    input.screenshotByteCount < 1 ||
    !Number.isSafeInteger(input.accessibilityTreeByteCount) ||
    input.accessibilityTreeByteCount < 0 ||
    !Number.isSafeInteger(input.round) ||
    input.round < 1 ||
    input.round > COMPUTER_USE_LIMITS.maxRounds ||
    input.sessionId.length < 1 ||
    input.sessionId.length > 128
  )
    throw new Error('Invalid Computer Use provider egress facts');
  const trust = input.endpointTrust ?? 'trusted-remote';
  const providerTrust = trust === 'untrusted' ? ('untrusted-remote' as const) : trust;
  const manifestDigest = digestCanonical({
    sessionId: input.sessionId,
    revision: input.round,
    screenshot: {
      mimeType: input.screenshotMimeType,
      sha256: input.screenshotDigest,
      byteLength: input.screenshotByteCount,
    },
    accessibilityTree: {
      sha256: input.accessibilityTreeDigest,
      byteLength: input.accessibilityTreeByteCount,
    },
  });
  const context = {
    fragments: [],
    projectItems: [],
    projectSnapshotDigest: null,
    usageEvents: [],
    compacted: false,
  } as PreparedContext;
  return authorizeOfficialApiProviderEgress(
    {
      broker: input.broker,
      task: input.task,
      turnId: input.turnId,
      prompt: input.prompt,
      context,
      now: input.now,
      payloadDigest: digestCanonical({
        sessionId: input.sessionId,
        round: input.round,
        promptDigest: digestCanonical(input.prompt),
        screenshotDigest: input.screenshotDigest,
        accessibilityTreeDigest: input.accessibilityTreeDigest,
      }),
      adapterVersion: 'computer-use-v1',
      connectionId: input.connectionId,
      modelId: input.modelId,
      endpointTrust: trust,
      round: input.round,
      toolCatalogDigest: digestCanonical(['computer-use-v1']),
      attachmentManifestDigest: manifestDigest,
      attachmentByteCount: input.screenshotByteCount,
      ephemeral: true,
    },
    input.providerId,
    providerTrust,
  );
}

/** Normalize Provider-owned transport values before scanning the egress policy projection. */
export function providerMessagesForEgressPolicy(
  messages: ProviderExecutionRequest['messages'],
): readonly unknown[] {
  return messages.map((message) => ({
    ...message,
    ...(message.toolCallId === undefined ? {} : { toolCallId: 'provider-tool-call-id' }),
    ...(message.toolCalls === undefined
      ? {}
      : {
          toolCalls: message.toolCalls.map((toolCall) => ({
            ...toolCall,
            callId: 'provider-tool-call-id',
          })),
        }),
    ...(message.inlineImages === undefined
      ? {}
      : {
          inlineImages: message.inlineImages.map(({ mimeType }) => ({
            mimeType,
            bytes: 'redacted-image-bytes',
          })),
        }),
  }));
}

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
  /** Evaluate and revalidate without persisting a live, session-bound permission audit. */
  ephemeral?: boolean;
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
  const secretScan =
    assessProviderDisclosure(content).classification === 'safe'
      ? ('clean' as const)
      : ('blocked' as const);
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
  const evaluation = input.ephemeral
    ? input.broker.preview(evaluationInput)
    : input.broker.evaluate(evaluationInput);
  if (
    (evaluation.decision !== 'allow' && evaluation.decision !== 'allow_once') ||
    evaluation.permit === undefined
  )
    return Object.freeze({ allowed: false, evaluation });
  const revalidationInput = {
    ...evaluationInput,
    permit: evaluation.permit,
    now: input.now,
  };
  const revalidated = input.ephemeral
    ? input.broker.revalidateEphemeral(revalidationInput)
    : input.broker.revalidate(revalidationInput);
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
