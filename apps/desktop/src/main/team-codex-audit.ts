import { BUILTIN_CODEX_CONNECTION_ID } from './connection-identity';
import type { AgentRecord, PersistenceClient, TeamAttemptRecord } from './persistence';

export type TeamCodexAuditReport = Readonly<{
  ok: boolean;
  agentCount: number;
  attemptCount: number;
  violations: readonly string[];
}>;

export function auditCodexOnlyTeam(
  persistence: Pick<
    PersistenceClient,
    'getTeamSnapshot' | 'listTeamExecutions' | 'listTeamAttempts'
  >,
  teamId: string,
): TeamCodexAuditReport {
  const agents = persistence.getTeamSnapshot(teamId).agents;
  const attempts = persistence
    .listTeamExecutions(teamId)
    .flatMap(({ id }) => persistence.listTeamAttempts(id));
  return evaluateCodexOnlyAudit(agents, attempts);
}

export function evaluateCodexOnlyAudit(
  agents: readonly AgentRecord[],
  attempts: readonly TeamAttemptRecord[],
): TeamCodexAuditReport {
  const violations: string[] = [];
  for (const agent of agents)
    validateSelection(`agent:${agent.id}`, agent.modelSelection, violations);
  for (const attempt of attempts) {
    validateSelection(`attempt:${attempt.id}`, attempt.modelSelection, violations);
    if (
      attempt.state === 'completed' &&
      (attempt.resolution.resolvedProvider !== 'openai' ||
        attempt.resolution.resolvedModel === null ||
        attempt.resolution.resolvedModel === 'auto')
    )
      violations.push(`attempt:${attempt.id}:invalid_resolution`);
  }
  return {
    ok: violations.length === 0,
    agentCount: agents.length,
    attemptCount: attempts.length,
    violations,
  };
}

function validateSelection(
  subject: string,
  selection: AgentRecord['modelSelection'],
  violations: string[],
): void {
  if (selection.connectionId !== BUILTIN_CODEX_CONNECTION_ID)
    violations.push(`${subject}:connection`);
  if (selection.requestedProvider !== 'openai') violations.push(`${subject}:provider`);
  if (selection.requestedModel === null || selection.requestedModel === 'auto')
    violations.push(`${subject}:model`);
}
