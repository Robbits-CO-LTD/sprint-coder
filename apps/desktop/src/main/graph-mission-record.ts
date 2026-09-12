import { z } from 'zod';
import { effectiveWorkspaceSetSchema, type GraphMissionPlan } from '@sprint-coder/contracts';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const graphMissionStoredContextSchema = z
  .object({
    workspace: effectiveWorkspaceSetSchema,
    roots: z.array(z.tuple([z.string().min(1), digest])).max(16),
    policyEpoch: z.number().int().nonnegative(),
    team: z
      .object({
        id: z.string().min(1),
        taskId: z.string().min(1),
        leaderAgentId: z.string().min(1),
        state: z.literal('active'),
      })
      .strict(),
    workers: z
      .array(
        z
          .object({
            id: z.string().min(1),
            taskId: z.string().min(1),
            teamId: z.string().min(1),
            kind: z.literal('worker'),
            state: z.enum(['ready', 'waiting']),
            writeCapable: z.boolean(),
            authorityDigest: digest,
          })
          .strict(),
      )
      .min(1)
      .max(12),
    busyWorkerIds: z.array(z.string()).max(0),
  })
  .strict();
/** Internal Main input. The caller must establish fresh human consent and filesystem eligibility;
 * possession of this object, a review result or its digests is not an authorization token. */
export const graphMissionCommitSchema = z
  .object({
    taskId: z.string().min(1),
    graphId: z.string().uuid(),
    renderRevision: z.number().int().positive(),
    semanticRevision: z.number().int().positive(),
    semanticDigest: digest,
    policyEpoch: z.number().int().nonnegative(),
    workspaceDigest: digest,
    contextDigest: digest,
    consentId: z.string().uuid(),
    now: z.string().datetime(),
  })
  .strict();
export type GraphMissionCommitInput = z.infer<typeof graphMissionCommitSchema>;
export type GraphMissionRecord = Readonly<{
  missionId: string;
  taskId: string;
  graphId: string;
  renderRevision: number;
  semanticRevision: number;
  semanticDigest: string;
  policyEpoch: number;
  workspaceDigest: string;
  contextDigest: string;
  consentId: string;
  approvedAt: string;
  contextJson: string;
  plan: GraphMissionPlan;
  steps: readonly { key: string; nodeId: string; executionId: string; generation: number }[];
}>;
