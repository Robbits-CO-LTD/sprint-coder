import { randomUUID } from 'node:crypto';
import { graphGenerationSchema, type GraphGeneration } from '@sprint-coder/contracts';

export function graphGenerationActive(value: GraphGeneration): boolean {
  return value.state === 'running' || value.state === 'canceling';
}

export function beginGraphGeneration(
  taskId: string,
  proposedTitle: string | null,
  baseRenderRevision: number,
  prior: GraphGeneration | null,
): GraphGeneration {
  if (prior && graphGenerationActive(prior)) throw new Error('Graph generation is already active');
  return graphGenerationSchema.parse({
    id: randomUUID(),
    taskId,
    sequence: (prior?.sequence ?? 0) + 1,
    state: 'running',
    proposedTitle,
    baseRenderRevision,
    resultRenderRevision: null,
    failureStage: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });
}

export function cancelGraphGeneration(current: GraphGeneration): GraphGeneration {
  if (current.state !== 'running') return current;
  return graphGenerationSchema.parse({
    ...current,
    state: 'canceling',
    sequence: current.sequence + 1,
  });
}

export function finishGraphGeneration(
  current: GraphGeneration,
  state: 'succeeded' | 'failed' | 'canceled' | 'interrupted',
  failureStage: GraphGeneration['failureStage'] = null,
  resultRenderRevision: number | null = null,
): GraphGeneration {
  if (!graphGenerationActive(current)) throw new Error('Graph generation is already terminal');
  if (state === 'succeeded' && current.state !== 'running')
    throw new Error('Canceled generation cannot publish');
  return graphGenerationSchema.parse({
    ...current,
    state,
    failureStage,
    resultRenderRevision,
    sequence: current.sequence + 1,
    finishedAt: new Date().toISOString(),
  });
}
