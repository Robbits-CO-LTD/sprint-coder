export const teamExecutionStates = [
  'assigned',
  'queued',
  'waiting_verification',
  'waiting_rate_limit',
  'running',
  'waiting_resume',
  'completed',
  'failed',
  'canceled',
] as const;
export type TeamExecutionState = (typeof teamExecutionStates)[number];

export const teamAttemptStates = [
  'created',
  'waiting_verification',
  'waiting_rate_limit',
  'running',
  'completed',
  'failed',
  'canceled',
  'interrupted',
] as const;
export type TeamAttemptState = (typeof teamAttemptStates)[number];

export const teamQueueReasons = [
  'global_concurrency',
  'connection_concurrency',
  'verification',
  'rate_limit',
  'budget',
  'recovery',
  'automatic_retry',
] as const;
export type TeamQueueReason = (typeof teamQueueReasons)[number];

export type ExecutionInstruction = Readonly<{
  revision: number;
  content: string;
  updatedAt: string;
}>;

const executionTransitions: Readonly<Record<TeamExecutionState, readonly TeamExecutionState[]>> = {
  assigned: ['queued', 'waiting_resume', 'canceled'],
  queued: [
    'waiting_verification',
    'waiting_rate_limit',
    'running',
    'waiting_resume',
    'failed',
    'canceled',
  ],
  waiting_verification: ['queued', 'running', 'waiting_resume', 'failed', 'canceled'],
  waiting_rate_limit: ['queued', 'running', 'waiting_resume', 'failed', 'canceled'],
  running: ['queued', 'waiting_rate_limit', 'waiting_resume', 'completed', 'failed', 'canceled'],
  waiting_resume: ['queued', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

const attemptTransitions: Readonly<Record<TeamAttemptState, readonly TeamAttemptState[]>> = {
  created: ['waiting_verification', 'waiting_rate_limit', 'running', 'canceled'],
  waiting_verification: ['running', 'failed', 'canceled'],
  waiting_rate_limit: ['running', 'failed', 'canceled'],
  running: ['waiting_rate_limit', 'completed', 'failed', 'canceled', 'interrupted'],
  completed: [],
  failed: [],
  canceled: [],
  interrupted: [],
};

export function transitionTeamExecution(
  from: TeamExecutionState,
  to: TeamExecutionState,
): TeamExecutionState {
  if (!executionTransitions[from].includes(to))
    throw new Error(`Invalid Team execution transition: ${from} -> ${to}`);
  return to;
}

export function transitionTeamAttempt(
  from: TeamAttemptState,
  to: TeamAttemptState,
): TeamAttemptState {
  if (!attemptTransitions[from].includes(to))
    throw new Error(`Invalid Team attempt transition: ${from} -> ${to}`);
  return to;
}

export function createExecutionInstruction(
  content: string,
  updatedAt: string,
): ExecutionInstruction {
  return validateInstruction({ revision: 1, content, updatedAt });
}

export function reviseQueuedExecutionInstruction(input: {
  executionState: TeamExecutionState;
  current: ExecutionInstruction;
  content: string;
  updatedAt: string;
}): ExecutionInstruction {
  if (
    !['assigned', 'queued', 'waiting_verification', 'waiting_rate_limit'].includes(
      input.executionState,
    )
  )
    throw new Error('Only a queued Team execution instruction can be revised in place');
  const current = validateInstruction(input.current);
  return validateInstruction({
    revision: current.revision + 1,
    content: input.content,
    updatedAt: input.updatedAt,
  });
}

export function nextTeamAttemptOrdinal(existingOrdinals: readonly number[]): number {
  if (existingOrdinals.some((ordinal) => !Number.isSafeInteger(ordinal) || ordinal < 1))
    throw new Error('Invalid Team attempt ordinal');
  const unique = new Set(existingOrdinals);
  if (unique.size !== existingOrdinals.length) throw new Error('Duplicate Team attempt ordinal');
  const ordered = [...existingOrdinals].sort((left, right) => left - right);
  if (ordered.some((ordinal, index) => ordinal !== index + 1))
    throw new Error('Team attempt ordinals must be contiguous');
  return existingOrdinals.length === 0 ? 1 : Math.max(...existingOrdinals) + 1;
}

function validateInstruction(instruction: ExecutionInstruction): ExecutionInstruction {
  if (!Number.isSafeInteger(instruction.revision) || instruction.revision < 1)
    throw new Error('Invalid execution instruction revision');
  if (instruction.content.trim().length < 1 || instruction.content.length > 100_000)
    throw new Error('Invalid execution instruction');
  if (Number.isNaN(Date.parse(instruction.updatedAt)))
    throw new Error('Invalid execution instruction timestamp');
  return instruction;
}
