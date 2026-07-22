export const turnStates = [
  'queued',
  'understanding',
  'planning',
  'executing',
  'synthesizing',
  'canceling',
  'completed',
  'canceled',
  'failed',
  'interrupted',
] as const;

export type TurnState = (typeof turnStates)[number];

const transitions: Readonly<Record<TurnState, readonly TurnState[]>> = {
  queued: ['understanding', 'canceling', 'failed', 'interrupted'],
  understanding: ['planning', 'canceling', 'failed', 'interrupted'],
  planning: ['executing', 'canceling', 'failed', 'interrupted'],
  executing: ['synthesizing', 'canceling', 'failed', 'interrupted'],
  synthesizing: ['completed', 'canceling', 'failed', 'interrupted'],
  canceling: ['canceled', 'failed', 'interrupted'],
  completed: [],
  canceled: [],
  failed: [],
  interrupted: [],
};

export class InvalidTurnTransitionError extends Error {
  constructor(from: TurnState, to: TurnState) {
    super(`Invalid turn transition: ${from} -> ${to}`);
    this.name = 'InvalidTurnTransitionError';
  }
}

export function canTransitionTurn(from: TurnState, to: TurnState): boolean {
  return transitions[from].includes(to);
}

export function transitionTurn(from: TurnState, to: TurnState): TurnState {
  if (!canTransitionTurn(from, to)) throw new InvalidTurnTransitionError(from, to);
  return to;
}

export type TurnReducerEvent = { type: 'state.transitioned'; state: TurnState };

export function reduceTurn(state: TurnState, event: TurnReducerEvent): TurnState {
  return transitionTurn(state, event.state);
}

export const intelligenceStepStates = [
  'prepared',
  'sampling',
  'sampled',
  'dispatching',
  'toolsCommitted',
  'completed',
  'failed',
] as const;

export type IntelligenceStepState = (typeof intelligenceStepStates)[number];

const intelligenceStepTransitions: Readonly<
  Record<IntelligenceStepState, readonly IntelligenceStepState[]>
> = {
  prepared: ['sampling', 'failed'],
  sampling: ['sampled', 'failed'],
  sampled: ['dispatching', 'completed', 'failed'],
  dispatching: ['toolsCommitted', 'failed'],
  toolsCommitted: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export type ReasoningEffort = 'low' | 'medium' | 'high';

export type StepSnapshot = {
  stepId: string;
  taskId: string;
  turnId: string;
  ordinal: number;
  model: string;
  effort: ReasoningEffort;
  contextDigest: string;
  toolCatalogDigest: string;
  policyEpoch: number;
  workspaceRevision: string;
  contractRevision: number | null;
  createdAt: string;
};

export class InvalidIntelligenceStepTransitionError extends Error {
  constructor(from: IntelligenceStepState, to: IntelligenceStepState) {
    super(`Invalid intelligence step transition: ${from} -> ${to}`);
    this.name = 'InvalidIntelligenceStepTransitionError';
  }
}

export function transitionIntelligenceStep(
  from: IntelligenceStepState,
  to: IntelligenceStepState,
): IntelligenceStepState {
  if (!intelligenceStepTransitions[from].includes(to))
    throw new InvalidIntelligenceStepTransitionError(from, to);
  return to;
}

export * from './permission';
export * from './tool-registry';
