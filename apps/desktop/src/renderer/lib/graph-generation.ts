import { graphGenerationSchema, type GraphGeneration } from '@sprint-coder/contracts';

export function acceptGraphGeneration(
  value: unknown,
  taskId: string,
  sequence: number,
): GraphGeneration | null {
  const parsed = graphGenerationSchema.safeParse(value);
  return parsed.success && parsed.data.taskId === taskId && parsed.data.sequence > sequence
    ? parsed.data
    : null;
}
