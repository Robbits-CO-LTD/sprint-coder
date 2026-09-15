import type {
  GraphMissionStartInput,
  GraphMissionResumeInput,
  GraphMissionUpdateInput,
  GraphMissionUpdateAgreement,
} from '@sprint-coder/contracts';

export function graphUpdateActivationIntent(
  input: GraphMissionUpdateInput | GraphMissionUpdateAgreement,
  operation: 'request' | 'agree',
): string {
  return JSON.stringify({
    operation: `graph-update-${operation}`,
    taskId: input.taskId,
    instanceId: input.instanceId,
    renderRevision: input.renderRevision,
    missionId: input.missionId,
    expectedSemanticRevision: input.expectedSemanticRevision,
    ...('requestId' in input
      ? { requestId: input.requestId, contextDigest: input.contextDigest }
      : {}),
  });
}

export function graphStartActivationIntent(input: GraphMissionStartInput): string {
  return JSON.stringify({
    operation: 'graph-start',
    taskId: input.taskId,
    instanceId: input.instanceId,
    renderRevision: input.renderRevision,
    contextDigest: input.contextDigest,
  });
}

export function graphResumeActivationIntent(input: GraphMissionResumeInput): string {
  return JSON.stringify({
    operation: 'graph-resume-integration',
    taskId: input.taskId,
    instanceId: input.instanceId,
    renderRevision: input.renderRevision,
    missionId: input.missionId,
    stepKey: input.stepKey,
    generation: input.generation,
  });
}

export function graphResumeStepActivationIntent(input: GraphMissionResumeInput): string {
  return JSON.stringify({
    operation: 'graph-resume-step',
    taskId: input.taskId,
    instanceId: input.instanceId,
    renderRevision: input.renderRevision,
    missionId: input.missionId,
    stepKey: input.stepKey,
    generation: input.generation,
    ...(input.workspaceReviewDigest ? { workspaceReviewDigest: input.workspaceReviewDigest } : {}),
  });
}
