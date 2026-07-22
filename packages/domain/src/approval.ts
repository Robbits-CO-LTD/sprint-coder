import { capabilities, type Capability, type PermissionResource } from './permission';

export const approvalStates = ['pending', 'resolved', 'canceled', 'stale', 'expired'] as const;
export type ApprovalState = (typeof approvalStates)[number];
export type ApprovalDecision = 'allow_once' | 'allow_task' | 'deny';

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
  const resource = structuredClone(input.resource);
  return deepFreeze({
    ...input,
    resource,
    state: 'pending' as const,
    decision: null,
    revision: 0,
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
