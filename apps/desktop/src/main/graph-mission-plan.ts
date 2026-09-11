import { graphMissionPlanSchema, type GraphMissionPlan } from '@sprint-coder/contracts';
import { graphMissionOrder } from '@sprint-coder/domain';

/** A draft declaration grants no authority. Worker eligibility, canonical claims and current
 * code/permissions must still be bound atomically by the eventual agreement/start operation. */
export function validateGraphMissionPlan(
  value: unknown,
  kind: 'architecture' | 'workflow',
  nodeIds: readonly string[],
): GraphMissionPlan | null {
  if (value === null) return null;
  const plan = graphMissionPlanSchema.parse(value);
  if (kind !== 'workflow') throw new Error('Only Workflow diagrams can declare a graph Mission');
  if (Buffer.byteLength(JSON.stringify(plan)) > 256 * 1024)
    throw new Error('Graph Mission plan is too large');
  graphMissionOrder(plan.steps);
  for (const step of plan.steps) {
    if (!nodeIds.includes(step.nodeId))
      throw new Error('Graph Mission node mapping does not exist');
    const writes = step.writeClaims.map((claim) => JSON.stringify([claim.rootId, claim.path]));
    const resources = step.resourceClaims.map((claim) =>
      JSON.stringify([claim.scope, claim.rootId, claim.key]),
    );
    if (
      new Set(writes).size !== writes.length ||
      new Set(resources).size !== resources.length ||
      step.writeClaims.some(
        (claim) => new Set(claim.semanticKeys).size !== claim.semanticKeys.length,
      )
    )
      throw new Error('Duplicate graph Mission claim');
  }
  return plan;
}

/** Claim/dependency sets are unordered; step ordering remains the scheduler's fair tie-break. */
export function graphMissionProjection(plan: GraphMissionPlan | null) {
  if (plan === null) return null;
  const sorted = <T>(values: T[]) =>
    values.sort((a, b) => {
      const left = JSON.stringify(a);
      const right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  return {
    ...plan,
    steps: plan.steps.map((step, index) => ({
      ...step,
      ordinal: index + 1,
      dependsOn: [...step.dependsOn].sort(),
      writeClaims: sorted(
        step.writeClaims.map((claim) => ({
          ...claim,
          semanticKeys: [...claim.semanticKeys].sort(),
        })),
      ),
      resourceClaims: sorted([...step.resourceClaims]),
    })),
  };
}
