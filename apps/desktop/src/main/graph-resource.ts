import type { GraphMissionRecord } from './graph-mission-record';
import { z } from 'zod';
import { graphMissionStoredContextSchema } from './graph-mission-record';
import type { TeamMissionCheckpoint } from '@sprint-coder/contracts';
import type { GraphWriteFootprint } from './graph-write-conflicts';

export type GraphResourceKey = Readonly<{
  key: string;
  scope: 'worker' | 'machine' | 'workspace';
  name: string;
  rootIdentityDigest: string | null;
}>;
export const graphResourceInventorySchema = z
  .array(
    z
      .object({
        key: z.string().max(512),
        scope: z.enum(['worker', 'machine', 'workspace']),
        name: z.string().min(1).max(128),
        rootIdentityDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
      })
      .strict()
      .refine(
        (value) =>
          (value.scope === 'workspace') === (value.rootIdentityDigest !== null) &&
          value.key ===
            JSON.stringify(
              value.scope === 'workspace'
                ? [value.scope, value.rootIdentityDigest, value.name]
                : [value.scope, value.name],
            ),
      ),
  )
  .min(1)
  .max(17);
export type GraphResourceReservation = Readonly<{
  id: string;
  missionId: string;
  executionId: string;
  generation: number;
  attemptId: string | null;
  state: 'reserved' | 'active' | 'quarantined' | 'released';
  createdAt: string;
  releasedAt: string | null;
  resources: readonly GraphResourceKey[];
  writeFootprints: readonly GraphWriteFootprint[];
}>;
export type GraphResourceAcquisition =
  | { acquired: true; reservation: GraphResourceReservation }
  | {
      acquired: false;
      reason: 'dependencies' | 'resources' | 'write-conflicts';
      blockedKeys: string[];
    }
  | { acquired: false; reason: 'owner-active'; reservationId: string };
/** Main-only readiness observation. Acquisition must recheck these facts transactionally. */
export type GraphResourceAvailability =
  | { available: true; reservation: GraphResourceReservation | null }
  | {
      available: false;
      reason: 'dependencies' | 'resources' | 'write-conflicts';
      blockedKeys: string[];
    }
  | { available: false; reason: 'owner-active'; reservationId: string };
export type GraphResourceRelease = Readonly<{
  reservationId: string;
  executionId: string;
  generation: number;
  now: string;
  /** Only trusted Main may supply this after observing dispatch/stop state, never a model report. */
  confirmation: { kind: 'not-dispatched' } | { kind: 'attempt-stopped'; attemptId: string };
}>;
export type GraphAttemptStart = Readonly<{
  missionId: string;
  stepKey: string;
  generation: number;
  reservationId: string;
  now: string;
  reason?: 'initial' | 'manual_resume';
}>;
/** Internal persistence input after Main observes runtime stop and validates completion/integration. */
export type GraphStepCompletion = Readonly<{
  missionId: string;
  stepKey: string;
  generation: number;
  reservationId: string;
  attemptId: string;
  agentId: string;
  teamTaskId: string;
  report: unknown;
  doneEvidence: readonly { criterion: string; evidence: string }[];
  checkpoint: TeamMissionCheckpoint;
  confirmation: { kind: 'attempt-stopped'; attemptId: string };
  now: string;
}>;

/** Main records a failed/canceled invocation independently of whether its runtime stopped.
 * An unconfirmed stop retains every lease; terminal Attempt state is not stop evidence. */
export type GraphStepInterruption = Readonly<{
  missionId: string;
  stepKey: string;
  generation: number;
  reservationId: string;
  attemptId: string;
  outcome: 'failed' | 'canceled';
  reason: string;
  confirmation: { kind: 'attempt-stopped'; attemptId: string } | { kind: 'unconfirmed' };
  now: string;
}>;

/** Resource namespaces are app-wide or physical-root-wide, never isolated by Team ID. */
export function graphResourceKeys(graph: GraphMissionRecord, stepKey: string): GraphResourceKey[] {
  const step = graph.plan.steps.find((step) => step.key === stepKey);
  if (!step) throw new Error('Graph resource step not found');
  const context = graphMissionStoredContextSchema.parse(JSON.parse(graph.contextJson));
  const roots = new Map(context.roots);
  const resources: GraphResourceKey[] = [
    {
      key: JSON.stringify(['worker', step.workerId]),
      scope: 'worker',
      name: step.workerId,
      rootIdentityDigest: null,
    },
  ];
  for (const claim of step.resourceClaims) {
    if (claim.scope === 'machine')
      resources.push({
        key: JSON.stringify(['machine', claim.key]),
        scope: 'machine',
        name: claim.key,
        rootIdentityDigest: null,
      });
    else {
      const rootId =
        claim.rootId === 'legacy-primary' ? context.workspace.primaryRootId : claim.rootId;
      const identity = rootId === null ? undefined : roots.get(rootId);
      if (!identity) throw new Error('Graph resource root is not bound');
      resources.push({
        key: JSON.stringify(['workspace', identity, claim.key]),
        scope: 'workspace',
        name: claim.key,
        rootIdentityDigest: identity,
      });
    }
  }
  return [...new Map(resources.map((resource) => [resource.key, resource])).values()].sort(
    (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}
