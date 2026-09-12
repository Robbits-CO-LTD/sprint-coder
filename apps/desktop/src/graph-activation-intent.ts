import type { GraphMissionStartInput, GraphMissionResumeInput } from '@sprint-coder/contracts';

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
  });
}
