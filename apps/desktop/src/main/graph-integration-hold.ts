import { z } from 'zod';
import { graphMissionKeySchema, workerReportSchema } from '@sprint-coder/contracts';
import type { GraphStepCompletion } from './graph-resource';

const id = z.string().min(1).max(128);
export const graphIntegrationPayloadSchema = z
  .object({
    missionId: id,
    stepKey: graphMissionKeySchema,
    executionId: id,
    reservationId: id,
    generation: z.number().int().positive(),
    attemptId: id,
    agentId: id,
    teamTaskId: id,
    report: workerReportSchema,
    repositories: z
      .array(
        z
          .object({
            repoPath: z.string().min(1).max(32_768),
            worktreePath: z.string().min(1).max(32_768),
            baseHead: z.string().regex(/^[a-f0-9]{40,64}$/iu),
            workerHead: z.string().regex(/^[a-f0-9]{40,64}$/iu),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    doneEvidence: z
      .array(
        z
          .object({
            criterion: z.string().min(1).max(1000),
            evidence: z.string().min(1).max(20_000),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export type GraphIntegrationHold = Readonly<
  z.infer<typeof graphIntegrationPayloadSchema> & {
    stoppedAt: string;
    reason: string;
    integrationActive: boolean;
    resumeOrdinal: number;
  }
>;
/** Trusted Main supplies this only after runtime stop and commit sealing are observed. */
export type GraphIntegrationHoldInput = Omit<GraphStepCompletion, 'checkpoint'> & {
  reason: string;
};
