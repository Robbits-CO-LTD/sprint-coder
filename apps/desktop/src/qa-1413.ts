import { z } from 'zod';
import { skillDraftSchema } from '@sprint-coder/contracts';

export const qa1413FixtureSchema = z.object({
  taskId: z.uuid(),
  turnId: z.uuid(),
  conflict: skillDraftSchema,
  missing: skillDraftSchema,
});

export const QA_1413_PROFILE = 'qa-1413-local';
