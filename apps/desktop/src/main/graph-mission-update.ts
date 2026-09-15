import { z } from 'zod';
export const graphUpdateRequestSchema = z
  .object({
    taskId: z.string().min(1),
    missionId: z.string().min(1),
    expectedSemanticRevision: z.number().int().positive(),
    renderRevision: z.number().int().positive(),
    requestId: z.string().uuid(),
    now: z.string().datetime(),
  })
  .strict();
export type GraphUpdateRequest = z.infer<typeof graphUpdateRequestSchema>;
export const graphPendingUpdateSchema = graphUpdateRequestSchema
  .extend({
    changedKeys: z.array(z.string().min(1)).max(12),
    affectedKeys: z.array(z.string().min(1)).max(12),
  })
  .strict();
export type GraphPendingUpdate = z.infer<typeof graphPendingUpdateSchema>;

export const graphUpdateCommitSchema = graphUpdateRequestSchema
  .pick({ taskId: true, missionId: true, requestId: true, now: true })
  .extend({ consentId: z.string().uuid() })
  .strict();
export type GraphUpdateCommit = z.infer<typeof graphUpdateCommitSchema>;
