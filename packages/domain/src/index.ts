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
