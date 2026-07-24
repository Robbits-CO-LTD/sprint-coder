import { createHash, randomUUID } from 'node:crypto';
import {
  permissionRequestFingerprint,
  type PermissionRequest,
  type ReviewerDecision,
  type ToolKind,
  type ToolRisk,
  type ToolSideEffect,
} from '@sprint-coder/domain';

const MODEL_NAME = 'builtin-deterministic-risk-v1';
const TEMPLATE_VERSION = '1';
const ALLOWED_REASON_CODES = new Set([
  'safe_read_only',
  'provider_egress',
  'sandbox_full',
  'side_effect',
  'unsupported_operation',
]);

export type AutoReviewerInput = Readonly<{
  schemaVersion: 1;
  requestFingerprint: string;
  executionSpecDigest: string;
  resourceIdentityDigest: string;
  policyEpoch: number;
  capability: PermissionRequest['capability'];
  operation: PermissionRequest['operation'];
  providerEgress: PermissionRequest['providerEgress'];
  sandboxProfile: PermissionRequest['sandboxProfile'];
  risk: PermissionRequest['risk'];
  tool: Readonly<{
    kind: ToolKind;
    sideEffect: ToolSideEffect;
    risk: ToolRisk;
  }>;
}>;

export type AutoReviewerModel = (input: AutoReviewerInput) => Promise<unknown> | unknown;

export function autoReviewerInputDigest(input: {
  request: Omit<PermissionRequest, 'reviewerInputDigest'>;
  tool: Readonly<{ kind: ToolKind; sideEffect: ToolSideEffect; risk: ToolRisk }>;
  policyEpoch: number;
}): string {
  return createHash('sha256')
    .update(
      stableJson({
        schemaVersion: 1,
        templateVersion: TEMPLATE_VERSION,
        policyEpoch: input.policyEpoch,
        capability: input.request.capability,
        operation: input.request.operation,
        resourceIdentityDigest:
          'identityDigest' in input.request.resource
            ? input.request.resource.identityDigest
            : createHash('sha256').update(stableJson(input.request.resource)).digest('hex'),
        providerEgress: input.request.providerEgress,
        sandboxProfile: input.request.sandboxProfile,
        executionSpecDigest: input.request.executionSpecDigest,
        risk: input.request.risk,
        tool: input.tool,
      }),
    )
    .digest('hex');
}

type ReviewRequest = Readonly<{
  reviewRequestId: string;
  turnId: string;
  callId: string;
  request: PermissionRequest;
  tool: Readonly<{ kind: ToolKind; sideEffect: ToolSideEffect; risk: ToolRisk }>;
  policyEpoch: number;
}>;

type ModelDecision = Readonly<{
  schemaVersion: 1;
  decision: 'allow_once' | 'deny';
  reasonCode: string;
}>;

export class AutoReviewer {
  private readonly model: AutoReviewerModel;
  private readonly timeoutMs: number;
  private readonly decisions = new Map<
    string,
    Readonly<{ binding: string; decision: Readonly<ReviewerDecision> }>
  >();

  private constructor(options?: Readonly<{ model?: AutoReviewerModel; timeoutMs?: number }>) {
    this.model = options?.model ?? deterministicRiskModel;
    this.timeoutMs = Math.max(1, options?.timeoutMs ?? 2_000);
  }

  static createProduction(): AutoReviewer {
    return new AutoReviewer();
  }

  /** Test-only seam. Production callers must use the fixed no-I/O reviewer above. */
  static createForTesting(options: { model: AutoReviewerModel; timeoutMs: number }): AutoReviewer {
    return new AutoReviewer(options);
  }

  async review(review: ReviewRequest): Promise<Readonly<ReviewerDecision>> {
    const binding = reviewBinding(review);
    const cached = this.decisions.get(review.reviewRequestId);
    if (cached !== undefined)
      return cached.binding === binding
        ? cached.decision
        : this.boundDecision(review, {
            decision: 'deny',
            reason: 'review_request_conflict',
          });

    const { reviewerInputDigest: _claimedDigest, ...requestFacts } = review.request;
    const expectedInputDigest = autoReviewerInputDigest({
      request: requestFacts,
      tool: review.tool,
      policyEpoch: review.policyEpoch,
    });
    if (expectedInputDigest !== review.request.reviewerInputDigest) {
      const denied = Object.freeze(
        this.boundDecision(review, { decision: 'deny', reason: 'input_digest_mismatch' }),
      );
      this.decisions.set(review.reviewRequestId, Object.freeze({ binding, decision: denied }));
      return denied;
    }

    const input = buildInput(review);
    let decision: Readonly<ReviewerDecision>;
    if (review.request.risk === 'high' || review.tool.risk === 'high') {
      decision = this.boundDecision(review, {
        decision: 'deny',
        reason: 'high_risk',
      });
    } else {
      decision = await this.invokeModel(review, input);
    }
    Object.freeze(decision);
    this.decisions.set(review.reviewRequestId, Object.freeze({ binding, decision }));
    return decision;
  }

  private async invokeModel(
    review: ReviewRequest,
    input: AutoReviewerInput,
  ): Promise<Readonly<ReviewerDecision>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve(this.model(input)),
        new Promise<symbol>((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT), this.timeoutMs);
        }),
      ]);
      if (result === TIMEOUT) return this.boundDecision(review, { decision: 'timeout' });
      const parsed = parseModelDecision(result);
      if (parsed === null)
        return this.boundDecision(review, {
          decision: 'schema_failure',
        });
      return this.boundDecision(
        review,
        parsed.decision === 'allow_once'
          ? {
              decision: 'allow_once',
              reason: parsed.reasonCode,
              decisionNonce: randomUUID(),
            }
          : { decision: 'deny', reason: parsed.reasonCode },
      );
    } catch {
      return this.boundDecision(review, { decision: 'model_failure' });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private boundDecision(
    review: ReviewRequest,
    outcome:
      | Readonly<{ decision: 'allow_once'; reason: string; decisionNonce: string }>
      | Readonly<{ decision: 'deny'; reason: string }>
      | Readonly<{ decision: 'timeout' | 'schema_failure' | 'model_failure' }>,
  ): ReviewerDecision {
    return {
      reviewRequestId: review.reviewRequestId,
      turnId: review.turnId,
      callId: review.callId,
      requestFingerprint: permissionRequestFingerprint(review.request),
      executionSpecDigest: review.request.executionSpecDigest,
      policyEpoch: review.policyEpoch,
      model: MODEL_NAME,
      templateVersion: TEMPLATE_VERSION,
      inputDigest: review.request.reviewerInputDigest,
      ...outcome,
    };
  }
}

const TIMEOUT = Symbol('auto-reviewer-timeout');

function buildInput(review: ReviewRequest): AutoReviewerInput {
  const resourceIdentityDigest =
    'identityDigest' in review.request.resource
      ? review.request.resource.identityDigest
      : createHash('sha256').update(stableJson(review.request.resource)).digest('hex');
  return deepFreeze({
    schemaVersion: 1 as const,
    requestFingerprint: permissionRequestFingerprint(review.request),
    executionSpecDigest: review.request.executionSpecDigest,
    resourceIdentityDigest,
    policyEpoch: review.policyEpoch,
    capability: review.request.capability,
    operation: review.request.operation,
    providerEgress: review.request.providerEgress,
    sandboxProfile: review.request.sandboxProfile,
    risk: review.request.risk,
    tool: { ...review.tool },
  });
}

function reviewBinding(review: ReviewRequest): string {
  return createHash('sha256')
    .update(
      stableJson({
        requestFingerprint: permissionRequestFingerprint(review.request),
        turnId: review.turnId,
        callId: review.callId,
        policyEpoch: review.policyEpoch,
        tool: review.tool,
      }),
    )
    .digest('hex');
}

function deterministicRiskModel(input: AutoReviewerInput): ModelDecision {
  if (input.providerEgress !== 'none')
    return { schemaVersion: 1, decision: 'deny', reasonCode: 'provider_egress' };
  if (input.sandboxProfile === 'full')
    return { schemaVersion: 1, decision: 'deny', reasonCode: 'sandbox_full' };
  if (!['none', 'read'].includes(input.tool.sideEffect))
    return { schemaVersion: 1, decision: 'deny', reasonCode: 'side_effect' };
  if (input.operation !== 'read')
    return { schemaVersion: 1, decision: 'deny', reasonCode: 'unsupported_operation' };
  return { schemaVersion: 1, decision: 'allow_once', reasonCode: 'safe_read_only' };
}

function parseModelDecision(value: unknown): ModelDecision | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['schemaVersion', 'decision', 'reasonCode'].includes(key)))
    return null;
  if (
    record.schemaVersion !== 1 ||
    (record.decision !== 'allow_once' && record.decision !== 'deny') ||
    typeof record.reasonCode !== 'string' ||
    !ALLOWED_REASON_CODES.has(record.reasonCode)
  )
    return null;
  return {
    schemaVersion: 1,
    decision: record.decision,
    reasonCode: record.reasonCode,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}
