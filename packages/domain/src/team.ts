import type { CapabilityCeiling } from './permission';

export const teamStates = [
  'draft',
  'forming',
  'active',
  'paused',
  'winding_down',
  'completed',
  'failed',
] as const;
export type TeamState = (typeof teamStates)[number];

export const workerStates = [
  'invited',
  'spawning',
  'ready',
  'busy',
  'waiting',
  'done',
  'failed',
  'stopped',
] as const;
export type WorkerState = (typeof workerStates)[number];

export const teamMessageStates = [
  'created',
  'persisted',
  'dispatching',
  'delivered',
  'acknowledged',
] as const;
export type TeamMessageState = (typeof teamMessageStates)[number];

export const contextInheritancePolicies = [
  'none',
  'summary',
  'selected_items',
  'full_fork',
] as const;
export type ContextInheritancePolicy = (typeof contextInheritancePolicies)[number];

const teamTransitions: Readonly<Record<TeamState, readonly TeamState[]>> = {
  draft: ['forming', 'failed'],
  forming: ['active', 'failed'],
  active: ['paused', 'winding_down', 'failed'],
  paused: ['active', 'winding_down', 'failed'],
  winding_down: ['completed', 'failed'],
  completed: [],
  failed: [],
};

const workerTransitions: Readonly<Record<WorkerState, readonly WorkerState[]>> = {
  invited: ['spawning', 'stopped'],
  spawning: ['ready', 'failed', 'stopped'],
  ready: ['busy', 'stopped'],
  busy: ['waiting', 'done', 'failed', 'stopped'],
  waiting: ['busy', 'done', 'failed', 'stopped'],
  done: [],
  failed: [],
  stopped: [],
};

const messageTransitions: Readonly<Record<TeamMessageState, readonly TeamMessageState[]>> = {
  created: ['persisted'],
  persisted: ['dispatching'],
  dispatching: ['delivered'],
  delivered: ['acknowledged'],
  acknowledged: [],
};

export function transitionTeam(from: TeamState, to: TeamState): TeamState {
  if (!teamTransitions[from].includes(to))
    throw new Error(`Invalid team transition: ${from} -> ${to}`);
  return to;
}

export function transitionWorker(from: WorkerState, to: WorkerState): WorkerState {
  if (!workerTransitions[from].includes(to))
    throw new Error(`Invalid worker transition: ${from} -> ${to}`);
  return to;
}

export function transitionTeamMessage(
  from: TeamMessageState,
  to: TeamMessageState,
): TeamMessageState {
  if (!messageTransitions[from].includes(to))
    throw new Error(`Invalid team message transition: ${from} -> ${to}`);
  return to;
}

export function assertLeaderRoutedMessage(
  sourceRole: 'leader' | 'worker',
  targetRole: 'leader' | 'worker',
): void {
  if (sourceRole === targetRole)
    throw new Error('Team messages must be routed between the leader and a worker');
}

export function assertWorkerPersistenceInput(input: {
  role: string;
  objective: string;
  parentCapabilityCeiling: CapabilityCeiling;
  contextInheritancePolicy: ContextInheritancePolicy;
}): void {
  if (input.role.trim().length < 1 || input.role.length > 100)
    throw new Error('Invalid worker role');
  if (input.objective.trim().length < 1 || input.objective.length > 10_000)
    throw new Error('Invalid worker objective');
  if (!contextInheritancePolicies.includes(input.contextInheritancePolicy))
    throw new Error('Invalid context inheritance policy');
  const ceiling = input.parentCapabilityCeiling;
  if (
    !Number.isSafeInteger(ceiling.maxWorkerDepth) ||
    ceiling.maxWorkerDepth < 0 ||
    !Number.isSafeInteger(ceiling.maxConcurrentWorkers) ||
    ceiling.maxConcurrentWorkers < 0
  )
    throw new Error('Invalid parent capability ceiling');
}
