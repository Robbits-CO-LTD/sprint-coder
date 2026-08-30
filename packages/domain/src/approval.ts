import { capabilities, type Capability, type PermissionResource } from './permission';

export const approvalStates = ['pending', 'resolved', 'canceled', 'stale', 'expired'] as const;
export type ApprovalState = (typeof approvalStates)[number];
export type ApprovalDecision = 'allow_once' | 'allow_task' | 'deny';

/** Computer Use approvals are a separate lane and never create a persistent task grant. */
export const computerUseApprovalDecisions = ['allow_once', 'allow_plan', 'deny'] as const;
export type ComputerUseApprovalDecision = (typeof computerUseApprovalDecisions)[number];
export type ComputerUseApprovalAction =
  | 'invoke'
  | 'set_text'
  | 'select'
  | 'toggle'
  | 'expand_collapse'
  | 'scroll'
  | 'click'
  | 'type'
  | 'key'
  | 'wait'
  | 'finish';
export type ComputerUseApprovalState = ApprovalState;

export type ComputerUseApprovalRecord = Readonly<{
  id: string;
  sessionId: string;
  taskId: string;
  turnId?: string;
  callId?: string;
  actionType: ComputerUseApprovalAction;
  actionDigest: string;
  targetLabel: string;
  preview: string;
  risk: 'low' | 'medium' | 'high';
  policyEpoch: number;
  observationRevision: number;
  eligibleForPlan: boolean;
  allowedDecisions: readonly ComputerUseApprovalDecision[];
  state: ComputerUseApprovalState;
  decision: ComputerUseApprovalDecision | null;
  revision: number;
  challenge: string;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
}>;

export type ApprovalRecord = Readonly<{
  id: string;
  taskId: string;
  turnId: string;
  callId: string;
  requestDigest: string;
  executionSpecDigest: string;
  policyEpoch: number;
  capability: Capability;
  resource: PermissionResource;
  state: ApprovalState;
  decision: ApprovalDecision | null;
  revision: number;
}>;

export class InvalidApprovalTransitionError extends Error {
  constructor(from: ApprovalState, to: ApprovalState) {
    super(`Invalid approval transition: ${from} -> ${to}`);
    this.name = 'InvalidApprovalTransitionError';
  }
}

export function transitionApproval(from: ApprovalState, to: ApprovalState): ApprovalState {
  if (from !== 'pending' || to === 'pending') throw new InvalidApprovalTransitionError(from, to);
  return to;
}

export function createApprovalRecord(
  input: Omit<ApprovalRecord, 'state' | 'decision' | 'revision'>,
): ApprovalRecord {
  if (
    input.id.length === 0 ||
    input.taskId.length === 0 ||
    input.turnId.length === 0 ||
    input.callId.length === 0
  )
    throw new Error('Invalid approval identity');
  if (
    !/^[a-f0-9]{64}$/.test(input.requestDigest) ||
    !/^[a-f0-9]{64}$/.test(input.executionSpecDigest)
  )
    throw new Error('Invalid approval digest');
  if (!Number.isInteger(input.policyEpoch) || input.policyEpoch < 0)
    throw new Error('Invalid approval policy epoch');
  if (!capabilities.includes(input.capability)) throw new Error('Invalid approval capability');
  if (
    (input.capability === 'computer.observe' || input.capability === 'computer.control') &&
    !input.resource.kind.startsWith('computer-')
  )
    throw new Error('Computer approvals require a Computer Use resource');
  const resource = structuredClone(input.resource);
  return deepFreeze({
    ...input,
    resource,
    state: 'pending' as const,
    decision: null,
    revision: 0,
  });
}

const COMPUTER_USE_ACTIONS = [
  'invoke',
  'set_text',
  'select',
  'toggle',
  'expand_collapse',
  'scroll',
  'click',
  'type',
  'key',
  'wait',
  'finish',
] as const satisfies readonly ComputerUseApprovalAction[];

const COMPUTER_USE_PLAN_ACTIONS: readonly ComputerUseApprovalAction[] = [
  'invoke',
  'set_text',
  'select',
  'toggle',
  'expand_collapse',
];

export function isPlanEligibleComputerUseAction(action: ComputerUseApprovalAction): boolean {
  return COMPUTER_USE_PLAN_ACTIONS.includes(action);
}

/**
 * Creates a sanitized, non-persistent Computer Use approval card.  The card contains only a
 * bounded preview and digest; callers must not put raw observations or provider output in it.
 */
export function createComputerUseApprovalRecord(
  input: Omit<ComputerUseApprovalRecord, 'state' | 'decision' | 'revision'>,
): ComputerUseApprovalRecord {
  if (
    input.id.length === 0 ||
    input.sessionId.length === 0 ||
    input.taskId.length === 0 ||
    (input.turnId !== undefined && input.turnId.length === 0) ||
    (input.callId !== undefined && input.callId.length === 0) ||
    input.targetLabel.trim().length === 0 ||
    input.challenge.length < 8 ||
    input.challenge.length > 256
  )
    throw new Error('Invalid Computer Use approval identity');
  if (!/^[a-f0-9]{64}$/.test(input.actionDigest) || input.preview.length > 256)
    throw new Error('Invalid Computer Use approval digest or preview');
  if (!COMPUTER_USE_ACTIONS.includes(input.actionType))
    throw new Error('Invalid Computer Use approval action');
  if (!(['low', 'medium', 'high'] as const).includes(input.risk))
    throw new Error('Invalid Computer Use approval risk');
  if (!Number.isInteger(input.policyEpoch) || input.policyEpoch < 0)
    throw new Error('Invalid Computer Use approval policy epoch');
  if (!Number.isInteger(input.observationRevision) || input.observationRevision < 0)
    throw new Error('Invalid Computer Use observation revision');
  if (
    input.allowedDecisions.length === 0 ||
    input.allowedDecisions.length > 3 ||
    new Set(input.allowedDecisions).size !== input.allowedDecisions.length ||
    input.allowedDecisions.some((decision) => !computerUseApprovalDecisions.includes(decision))
  )
    throw new Error('Invalid Computer Use approval decisions');
  if (!input.allowedDecisions.includes('allow_once'))
    throw new Error('Computer Use approval must offer allow_once');
  if (!input.allowedDecisions.includes('deny'))
    throw new Error('Computer Use approval must offer deny');
  const planCapable = isPlanEligibleComputerUseAction(input.actionType);
  if (!planCapable && input.eligibleForPlan)
    throw new Error('Only the exact semantic action set can allow a plan');
  if (!input.eligibleForPlan && input.allowedDecisions.includes('allow_plan'))
    throw new Error('Non-plan Computer Use approvals are allow_once only');
  if (input.eligibleForPlan && !input.allowedDecisions.includes('allow_plan'))
    throw new Error('Plan-eligible Computer Use action requires allow_plan');
  if (
    !Number.isFinite(Date.parse(input.createdAt)) ||
    !Number.isFinite(Date.parse(input.expiresAt))
  )
    throw new Error('Invalid Computer Use approval time');
  if (Date.parse(input.expiresAt) <= Date.parse(input.createdAt))
    throw new Error('Computer Use approval expiry must be after creation');
  return deepFreeze({
    ...input,
    targetLabel: input.targetLabel.trim(),
    state: 'pending' as const,
    decision: null,
    revision: 0,
    allowedDecisions: Object.freeze([...input.allowedDecisions]),
  });
}

export const createComputerUseApproval = createComputerUseApprovalRecord;

export function resolveComputerUseApproval(input: {
  approval: ComputerUseApprovalRecord;
  expectedRevision: number;
  challenge: string;
  decision: ComputerUseApprovalDecision;
  decidedAt: string;
}): ComputerUseApprovalRecord {
  const { approval } = input;
  if (approval.state !== 'pending') throw new Error('Computer Use approval is not pending');
  if (approval.revision !== input.expectedRevision)
    throw new Error('Computer Use approval is stale');
  if (approval.challenge !== input.challenge)
    throw new Error('Computer Use approval challenge mismatch');
  if (!approval.allowedDecisions.includes(input.decision))
    throw new Error('Computer Use approval decision is not allowed');
  if (input.decision === 'allow_plan' && !approval.eligibleForPlan)
    throw new Error('Computer Use allow_plan is not permitted for this action');
  if (!Number.isFinite(Date.parse(input.decidedAt))) throw new Error('Invalid decision time');
  return deepFreeze({
    ...approval,
    state: transitionApproval(approval.state, 'resolved'),
    decision: input.decision,
    revision: approval.revision + 1,
    decidedAt: input.decidedAt,
  });
}

/** A Computer Use lane has no task-wide or persistent approval decision. */
export function isComputerUsePersistentDecision(decision: string): boolean {
  return decision === 'allow_task' || decision === 'allow_plan';
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
