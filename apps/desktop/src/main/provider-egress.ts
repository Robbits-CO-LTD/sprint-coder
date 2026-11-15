import { Buffer } from 'node:buffer';
import type { ProviderExecutionRequest, TaskSummary } from '@sprint-coder/contracts';
import type { PermissionEvaluation, PermissionRequest, ProviderEgress } from '@sprint-coder/domain';
import { digestCanonical } from './context-compiler';
import type { PreparedContext } from './context-ledger';
import type { PermissionBroker } from './permission-broker';
import { assessProviderEgressDisclosure } from './provider-disclosure-classifier';

export type ProviderEgressDecision = Readonly<{
  allowed: boolean;
  evaluation: PermissionEvaluation;
  /**
   * The secret scan's reason codes (for example `ai-provider-token`), empty when the scan was
   * clean. Codes only: never the scanned bytes, so a denial can be explained without disclosing
   * what it withheld (issue #841).
   */
  disclosureReasons?: readonly string[];
}>;

/** What each secret-scan reason code found, in words a user can act on. Never the bytes. */
const DISCLOSURE_REASON_WORDS: Readonly<Record<string, string>> = {
  'uri-userinfo': 'ユーザー名やパスワードの入った URL',
  'webhook-url': 'Webhook の URL',
  'ai-provider-token': 'API key',
  'slack-token': 'Slack の token',
  'gitlab-token': 'GitLab の token',
  'known-secret-pattern': '鍵や token',
  'private-key': '秘密鍵',
  cookie: 'Cookie の値',
  'credential-field': 'パスワードや鍵の値（password= など）',
};

/**
 * The user-facing reason for a Provider send the secret scan stopped, or null when the scan did not
 * stop it (the caller keeps its own policy message). Built from reason codes only, so it never
 * repeats what was withheld (issue #841).
 *
 * The advice is a new Task on purpose: the request is already in this Task's conversation, and
 * every later Turn of the Task sends that conversation again, so a resend here is stopped again.
 */
export function describeProviderEgressDenial(
  disclosureReasons: readonly string[] | undefined,
): string | null {
  if (disclosureReasons === undefined || disclosureReasons.length === 0) return null;
  const found = [
    ...new Set(
      disclosureReasons
        .filter((code) => code !== 'credential-prone-filename')
        .map((code) => DISCLOSURE_REASON_WORDS[code] ?? '秘密の情報に見える文字列'),
    ),
  ];
  if (found.length === 0) found.push('秘密の情報に見える文字列');
  return `送る内容（依頼の文や、この Task のこれまでの会話）に${found.join('・')}が入っているため、AI に送りませんでした。この Task からは送れないままなので、その部分を外して、新しい Task で依頼してください。`;
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
  /**
   * Exact canonical roots from Main's sealed Turn workspace. The secret scan once exempted them from
   * its entropy guess; with that guess gone from egress they are only bound into the audit record.
   */
  knownWorkspaceRoots?: readonly string[];
  /** The labels Main declared for those same roots (issue #849), bound into the audit likewise. */
  knownWorkspaceLabels?: readonly string[];
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

export function dispatchAfterGrokProviderEgress(
  input: ProviderEgressInput,
  dispatch: () => void,
): ProviderEgressDecision {
  const decision = authorizeGrokProviderEgress(input);
  if (decision.allowed) dispatch();
  return decision;
}

export function authorizeGrokProviderEgress(input: ProviderEgressInput): ProviderEgressDecision {
  return authorizeProviderEgress(
    input,
    'xai-grok-cli',
    'grok',
    'grok_provider_egress',
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

/**
 * Identify the Workspace roots and labels the Turn declared, so the audit record keeps the same
 * shape it had while the secret scan exempted them (it no longer exempts anything). Normalized and
 * sorted: the same declaration spelled with either separator, in any order, is the same fact. Null
 * means nothing was declared. Labels (issue #849) join the digest whenever there are any; a
 * declaration of roots alone keeps the digest it always had.
 */
function knownRootsDigest(
  knownWorkspaceRoots: readonly string[] | undefined,
  knownWorkspaceLabels: readonly string[] | undefined,
): string | null {
  const normalized = [
    ...new Set(
      (knownWorkspaceRoots ?? [])
        .filter((root): root is string => typeof root === 'string' && root !== '')
        .map((root) => root.replaceAll('\\', '/').replace(/\/+$/u, '')),
    ),
  ].sort();
  const labels = [
    ...new Set(
      (knownWorkspaceLabels ?? []).filter(
        (label): label is string => typeof label === 'string' && label.trim() !== '',
      ),
    ),
  ].sort();
  if (labels.length > 0) return digestCanonical({ roots: normalized, labels });
  return normalized.length === 0 ? null : digestCanonical(normalized);
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
  const disclosure = assessProviderEgressDisclosure(content);
  const secretScan =
    disclosure.classification === 'safe' ? ('clean' as const) : ('blocked' as const);
  const disclosureReasons = secretScan === 'clean' ? Object.freeze([]) : disclosure.reasons;
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
    knownRootsDigest: knownRootsDigest(input.knownWorkspaceRoots, input.knownWorkspaceLabels),
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
    return Object.freeze({ allowed: false, evaluation, disclosureReasons });
  const revalidationInput = {
    ...evaluationInput,
    permit: evaluation.permit,
    now: input.now,
  };
  const revalidated = input.broker.revalidate(revalidationInput);
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
    disclosureReasons,
  });
}
