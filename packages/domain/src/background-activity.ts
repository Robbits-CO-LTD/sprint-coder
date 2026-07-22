import { createHash } from 'node:crypto';

export const backgroundActivityKinds = ['command', 'monitor', 'scheduler'] as const;
export type BackgroundActivityKind = (typeof backgroundActivityKinds)[number];

export const backgroundActivityStates = [
  'registered',
  'running',
  'completed',
  'failed',
  'canceled',
] as const;
export type BackgroundActivityState = (typeof backgroundActivityStates)[number];

export const backgroundWakePolicies = ['immediate', 'nextSafePoint', 'manual'] as const;
export type BackgroundWakePolicy = (typeof backgroundWakePolicies)[number];

export const backgroundCompletionStates = [
  'persisted',
  'attached',
  'runtimeAcked',
  'quarantined',
] as const;
export type BackgroundCompletionState = (typeof backgroundCompletionStates)[number];

const activityTransitions: Readonly<
  Record<BackgroundActivityState, readonly BackgroundActivityState[]>
> = {
  registered: ['running', 'canceled'],
  running: ['completed', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

export function transitionBackgroundActivity(
  from: BackgroundActivityState,
  to: BackgroundActivityState,
): BackgroundActivityState {
  if (!activityTransitions[from].includes(to))
    throw new Error(`Invalid background activity transition: ${from} -> ${to}`);
  return to;
}

export type BackgroundEpochs = Readonly<{
  branchEpoch: number;
  policyEpoch: number;
  contextEpoch: number;
}>;

export function backgroundDeliveryId(input: {
  completionId: string;
  activityId: string;
  ownerThreadId: string;
}): string {
  assertBoundedId(input.completionId, 'completionId');
  assertBoundedId(input.activityId, 'activityId');
  assertBoundedId(input.ownerThreadId, 'ownerThreadId');
  return createHash('sha256')
    .update(
      JSON.stringify({
        activityId: input.activityId,
        completionId: input.completionId,
        ownerThreadId: input.ownerThreadId,
      }),
    )
    .digest('hex');
}

export function backgroundEpochMismatch(
  completion: BackgroundEpochs,
  current: BackgroundEpochs,
): 'branch_epoch_changed' | 'policy_epoch_changed' | 'context_epoch_changed' | null {
  assertEpochs(completion);
  assertEpochs(current);
  if (completion.branchEpoch !== current.branchEpoch) return 'branch_epoch_changed';
  if (completion.policyEpoch !== current.policyEpoch) return 'policy_epoch_changed';
  if (completion.contextEpoch !== current.contextEpoch) return 'context_epoch_changed';
  return null;
}

export function assertEpochs(epochs: BackgroundEpochs): void {
  for (const [name, value] of Object.entries(epochs))
    if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
}

function assertBoundedId(value: string, name: string): void {
  if (value.length < 1 || value.length > 128) throw new Error(`Invalid ${name}`);
}
