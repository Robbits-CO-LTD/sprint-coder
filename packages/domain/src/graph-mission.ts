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
