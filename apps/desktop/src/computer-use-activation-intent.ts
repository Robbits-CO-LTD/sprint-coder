import type {
  ComputerUseApprovalDecision,
  ComputerUseMode,
  ComputerUseStartInput,
} from '@sprint-coder/contracts';

export type ComputerUseStartActivationIntent = Readonly<{
  operation: 'start' | 'quick_start' | 'resume';
  taskId: string;
  profileId: string;
  mode: ComputerUseMode;
  connectionId: string;
  modelId: string;
  providerEgressConsent: boolean;
  remember: boolean;
  maxRounds?: number;
  expectedPolicyEpoch: number;
  expectedProfileRevision: number;
  windowId?: string;
  expectedWindowRevision?: number;
  resumeSessionId?: string;
}>;

export type ComputerUseApprovalActivationIntent = Readonly<{
  operation: 'approval';
  approvalId: string;
  expectedRevision: number;
  decision: ComputerUseApprovalDecision;
  challenge: string;
}>;

export type ComputerUseActivationIntent =
  ComputerUseStartActivationIntent | ComputerUseApprovalActivationIntent;

/** Stable, bounded serialization recorded at the trusted input event and compared again in Main. */
export function serializeComputerUseActivationIntent(intent: ComputerUseActivationIntent): string {
  const serialized = JSON.stringify(intent);
  if (serialized.length > 2_048) throw new Error('Computer Use activation intent is oversized');
  return serialized;
}

export function startActivationIntent(
  input: ComputerUseStartInput,
  operation: 'start' | 'resume' = input.resumeSessionId === undefined ? 'start' : 'resume',
): string {
  return serializeComputerUseActivationIntent({
    operation,
    taskId: input.taskId,
    profileId: input.profileId,
    mode: input.mode,
    connectionId: input.connectionId,
    modelId: input.modelId,
    providerEgressConsent: input.providerEgressConsent,
    remember: input.remember,
    maxRounds: input.maxRounds ?? 25,
    expectedPolicyEpoch: input.expectedPolicyEpoch,
    expectedProfileRevision: input.expectedProfileRevision,
    windowId: input.windowId,
    expectedWindowRevision: input.expectedWindowRevision,
    ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }),
  });
}

export function quickStartActivationIntent(
  input: Omit<
    ComputerUseStartActivationIntent,
    'operation' | 'windowId' | 'expectedWindowRevision'
  >,
): string {
  const { maxRounds = 25, ...rest } = input;
  return serializeComputerUseActivationIntent({ operation: 'quick_start', ...rest, maxRounds });
}

export function approvalActivationIntent(
  input: Omit<ComputerUseApprovalActivationIntent, 'operation'>,
): string {
  return serializeComputerUseActivationIntent({ operation: 'approval', ...input });
}
