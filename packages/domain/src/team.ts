import type { CapabilityCeiling } from './permission';

export const TEAM_MAX_AGENT_DEPTH = 4;
export const TEAM_MAX_CONCURRENT_EXECUTIONS = 8;

export type TeamBudgetMode = 'bounded' | 'unlimited';

export type TeamPolicy = Readonly<{
  maxAgentDepth: number;
  maxConcurrentExecutions: number;
  allowWorkerDirectMessages: boolean;
  budgetMode: TeamBudgetMode;
}>;

export type ManagerPolicy = Readonly<{
  maxDirectChildren: number | null;
  maxDelegationDepth: number;
  allowManagerChildren: boolean;
}>;

export type TeamDelegationErrorCode =
  | 'legacy_delegation_field'
  | 'not_manager'
  | 'direct_child_limit'
  | 'manager_child_forbidden'
  | 'team_depth_limit'
  | 'manager_delegation_limit';

export class TeamDelegationError extends Error {
  readonly code: TeamDelegationErrorCode;
  readonly details: Readonly<Record<string, number | string | boolean | null>>;

  constructor(
    code: TeamDelegationErrorCode,
    message: string,
    details: Readonly<Record<string, number | string | boolean | null>> = {},
  ) {
    super(message);
    this.name = 'TeamDelegationError';
    this.code = code;
    this.details = details;
  }
}

export const DEFAULT_TEAM_POLICY: TeamPolicy = Object.freeze({
  maxAgentDepth: TEAM_MAX_AGENT_DEPTH,
  maxConcurrentExecutions: TEAM_MAX_CONCURRENT_EXECUTIONS,
  allowWorkerDirectMessages: true,
  budgetMode: 'bounded',
});

export const DEFAULT_MANAGER_POLICY: ManagerPolicy = Object.freeze({
  maxDirectChildren: null,
  maxDelegationDepth: TEAM_MAX_AGENT_DEPTH,
  allowManagerChildren: true,
});

export type DelegatingAgent = Readonly<{
  kind: 'leader' | 'worker';
  depth: number;
  canDelegate: boolean;
  managerPolicy: ManagerPolicy | null;
}>;

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
  // A later user turn may explicitly ask the same Task to do more Team work. Re-forming keeps
  // the completed Workers as history while allowing the Leader to hire fresh Workers.
  completed: ['forming'],
  failed: [],
};

const workerTransitions: Readonly<Record<WorkerState, readonly WorkerState[]>> = {
  invited: ['spawning', 'stopped'],
  spawning: ['ready', 'failed', 'stopped'],
  ready: ['busy', 'failed', 'stopped'],
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

/**
 * Whether a Worker in this state can still do anything.
 *
 * Read off the transition table rather than restating it as a list of terminal names, because a list is
 * a second place to remember: adding a state and forgetting the list would silently report a live
 * Worker as finished, or a finished one as live. A state nothing leads out of is terminal by
 * construction, so a new state is classified correctly the moment its transitions are declared.
 */
export function isWorkerActive(state: WorkerState): boolean {
  return workerTransitions[state].length > 0;
}

export function transitionTeamMessage(
  from: TeamMessageState,
  to: TeamMessageState,
): TeamMessageState {
  if (!messageTransitions[from].includes(to))
    throw new Error(`Invalid team message transition: ${from} -> ${to}`);
  return to;
}

export function assertTeamMessageAllowed(input: {
  source: { id: string; kind: 'leader' | 'worker' };
  target: { id: string; kind: 'leader' | 'worker' };
  allowWorkerDirectMessages: boolean;
}): void {
  if (input.source.id === input.target.id)
    throw new Error('Team message source and target Agents must differ');
  if (input.source.kind === 'leader' && input.target.kind === 'leader')
    throw new Error('A Team cannot message between multiple Leaders');
  if (
    input.source.kind === 'worker' &&
    input.target.kind === 'worker' &&
    !input.allowWorkerDirectMessages
  )
    throw new Error('Team Policy forbids Worker direct messages');
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

export function assertTeamPolicy(policy: TeamPolicy): TeamPolicy {
  if (
    !Number.isSafeInteger(policy.maxAgentDepth) ||
    policy.maxAgentDepth < 1 ||
    policy.maxAgentDepth > TEAM_MAX_AGENT_DEPTH
  )
    throw new Error(`Team maxAgentDepth must be between 1 and ${TEAM_MAX_AGENT_DEPTH}`);
  if (
    !Number.isSafeInteger(policy.maxConcurrentExecutions) ||
    policy.maxConcurrentExecutions < 1 ||
    policy.maxConcurrentExecutions > TEAM_MAX_CONCURRENT_EXECUTIONS
  )
    throw new Error(
      `Team maxConcurrentExecutions must be between 1 and ${TEAM_MAX_CONCURRENT_EXECUTIONS}`,
    );
  if (typeof policy.allowWorkerDirectMessages !== 'boolean')
    throw new Error('Invalid worker direct-message policy');
  if (!['bounded', 'unlimited'].includes(policy.budgetMode))
    throw new Error('Invalid Team budget mode');
  return policy;
}

export function assertManagerPolicy(policy: ManagerPolicy, teamPolicy: TeamPolicy): ManagerPolicy {
  assertTeamPolicy(teamPolicy);
  if (
    policy.maxDirectChildren !== null &&
    (!Number.isSafeInteger(policy.maxDirectChildren) || policy.maxDirectChildren < 1)
  )
    throw new Error('Manager maxDirectChildren must be null or a positive integer');
  if (
    !Number.isSafeInteger(policy.maxDelegationDepth) ||
    policy.maxDelegationDepth < 1 ||
    policy.maxDelegationDepth > teamPolicy.maxAgentDepth
  )
    throw new Error('Manager maxDelegationDepth exceeds the Team policy');
  if (typeof policy.allowManagerChildren !== 'boolean')
    throw new Error('Invalid Manager child-delegation policy');
  return policy;
}

export function assertDelegationAllowed(input: {
  requester: DelegatingAgent;
  requestedChildCanDelegate: boolean;
  directChildCount: number;
  teamPolicy: TeamPolicy;
}): number {
  const teamPolicy = assertTeamPolicy(input.teamPolicy);
  const requester = input.requester;
  if (
    !Number.isSafeInteger(requester.depth) ||
    requester.depth < 0 ||
    requester.depth > teamPolicy.maxAgentDepth
  )
    throw new Error('Invalid requester hierarchy depth');
  if (!requester.canDelegate || requester.managerPolicy === null)
    throw new TeamDelegationError(
      'not_manager',
      'Only a Manager with canDelegate may hire child Agents',
      { requesterDepth: requester.depth },
    );
  const managerPolicy = assertManagerPolicy(requester.managerPolicy, teamPolicy);
  if (!Number.isSafeInteger(input.directChildCount) || input.directChildCount < 0)
    throw new Error('Invalid direct child count');
  if (
    managerPolicy.maxDirectChildren !== null &&
    input.directChildCount >= managerPolicy.maxDirectChildren
  )
    throw new TeamDelegationError('direct_child_limit', 'Manager direct-child limit reached', {
      directChildCount: input.directChildCount,
      maxDirectChildren: managerPolicy.maxDirectChildren,
    });
  if (input.requestedChildCanDelegate && !managerPolicy.allowManagerChildren)
    throw new TeamDelegationError(
      'manager_child_forbidden',
      'Manager Policy forbids hiring another Manager',
      { requesterDepth: requester.depth },
    );
  const childDepth = requester.depth + 1;
  if (childDepth > teamPolicy.maxAgentDepth)
    throw new TeamDelegationError(
      'team_depth_limit',
      `Team hierarchy depth exceeds ${teamPolicy.maxAgentDepth}`,
      {
        requesterDepth: requester.depth,
        requestedChildDepth: childDepth,
        maxAgentDepth: teamPolicy.maxAgentDepth,
      },
    );
  if (childDepth > managerPolicy.maxDelegationDepth)
    throw new TeamDelegationError(
      'manager_delegation_limit',
      `Manager delegation limit ${managerPolicy.maxDelegationDepth} does not allow child depth ${childDepth}`,
      {
        requesterDepth: requester.depth,
        requestedChildDepth: childDepth,
        maxDelegationDepth: managerPolicy.maxDelegationDepth,
      },
    );
  return childDepth;
}
