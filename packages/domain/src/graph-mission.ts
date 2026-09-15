/** Validate execution dependencies, independently of a diagram's descriptive connections. */
export function graphMissionOrder(
  steps: readonly { key: string; nodeId: string; dependsOn: readonly string[] }[],
): string[] {
  if (steps.length < 2 || steps.length > 12)
    throw new Error('Graph Mission requires 2 to 12 steps');
  const keys = new Set(steps.map((step) => step.key));
  if (keys.size !== steps.length || new Set(steps.map((step) => step.nodeId)).size !== steps.length)
    throw new Error('Graph Mission step keys and node mappings must be unique');
  for (const step of steps) {
    if (new Set(step.dependsOn).size !== step.dependsOn.length)
      throw new Error('Duplicate graph dependency');
    if (step.dependsOn.some((key) => key === step.key || !keys.has(key)))
      throw new Error('Invalid graph dependency');
  }
  const ordered: string[] = [];
  const completed = new Set<string>();
  while (ordered.length < steps.length) {
    const ready = steps.filter(
      (step) => !completed.has(step.key) && step.dependsOn.every((key) => completed.has(key)),
    );
    if (ready.length === 0) throw new Error('Graph Mission contains a dependency cycle');
    for (const step of ready) {
      ordered.push(step.key);
      completed.add(step.key);
    }
  }
  return ordered;
}

type ConstraintPlan = Readonly<{
  objective: string;
  doneCriteria: readonly string[];
  steps: readonly Readonly<{
    key: string;
    nodeId: string;
    workerId: string;
    objective: string;
    doneCriteria: readonly string[];
    access: 'read-only' | 'workspace-write';
    dependsOn: readonly string[];
    writeClaims: readonly Readonly<{
      rootId: string;
      path: string | null;
      semanticKeys: readonly string[];
    }>[];
    resourceClaims: readonly Readonly<{
      scope: 'machine' | 'workspace';
      rootId: string | null;
      key: string;
    }>[];
  }>[];
}>;
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);
const claims = (step: ConstraintPlan['steps'][number]) =>
  JSON.stringify([
    [...step.dependsOn].sort(),
    step.writeClaims
      .map((claim) => JSON.stringify([claim.rootId, claim.path, [...claim.semanticKeys].sort()]))
      .sort(),
    step.resourceClaims
      .map((claim) => JSON.stringify([claim.scope, claim.rootId, claim.key]))
      .sort(),
  ]);

/** Constraints may change in place; authority, instructions and completed evidence may not. */
export function graphMissionConstraintUpdate(
  previous: ConstraintPlan,
  proposed: ConstraintPlan,
  completed: ReadonlySet<string>,
): { changedKeys: string[]; affectedKeys: string[] } {
  graphMissionOrder(previous.steps);
  graphMissionOrder(proposed.steps);
  if (
    previous.objective !== proposed.objective ||
    !sameList(previous.doneCriteria, proposed.doneCriteria) ||
    previous.steps.length !== proposed.steps.length
  )
    throw new Error('Mission instructions or structure require a separate plan');
  const changedKeys: string[] = [];
  for (const [index, step] of proposed.steps.entries()) {
    const old = previous.steps[index]!;
    if (
      old.key !== step.key ||
      old.nodeId !== step.nodeId ||
      old.workerId !== step.workerId ||
      old.access !== step.access ||
      old.objective !== step.objective ||
      !sameList(old.doneCriteria, step.doneCriteria)
    )
      throw new Error('Worker, authority, instructions or step structure require a separate plan');
    if (claims(old) !== claims(step)) {
      if (completed.has(step.key)) throw new Error('Completed step constraints are immutable');
      changedKeys.push(step.key);
    }
  }
  const affected = new Set(changedKeys);
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of [...previous.steps, ...proposed.steps]) {
      if (affected.has(step.key) || !step.dependsOn.some((key) => affected.has(key))) continue;
      if (completed.has(step.key))
        throw new Error('An update cannot invalidate a completed checkpoint');
      affected.add(step.key);
      grew = true;
    }
  }
  return {
    changedKeys,
    affectedKeys: proposed.steps.filter((step) => affected.has(step.key)).map((step) => step.key),
  };
}
