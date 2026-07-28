import { isWorkerActive, type WorkerState } from '@sprint-coder/domain';
import type { LiveState } from './context-reminder';

// Turning stored records into the handful of facts worth restating after a compaction.
//
// Split from the persistence client on purpose. The client can only be exercised against a real
// database, and this is the part with the actual decisions in it — which Workers still count as
// running, what to say about one that has no activity to report, which paths count as changed.
// Keeping it pure means those decisions are testable, and leaves the client with nothing but the two
// queries that feed it.

/** The subset of an agent record this derivation reads. */
export type LiveAgent = Readonly<{
  id: string;
  kind: 'leader' | 'worker';
  role: string;
  state: WorkerState;
  currentActivity: string | null;
}>;

/** The subset of a Turn diff entry this derivation reads. */
export type LiveDiffEntry = Readonly<{
  path: string;
  destination: string | null;
}>;

export function deriveLiveState(input: {
  agents: readonly LiveAgent[];
  diff: readonly LiveDiffEntry[];
}): LiveState {
  return {
    runningWorkers: input.agents
      // The Leader is the one reading this; telling it that it is running is noise.
      .filter((agent) => agent.kind === 'worker' && isWorkerActive(agent.state))
      .map((agent) => ({
        id: agent.id,
        role: agent.role,
        // What it is doing beats what state it is in, so the activity wins when there is one. The
        // state is the honest fallback: "busy" says less than "running the test suite", but a blank
        // status would invite the Leader to assume nothing is happening.
        status: agent.currentActivity ?? agent.state,
      })),
    touchedPaths: changedPaths(input.diff),
  };
}

/**
 * The paths a Turn's diff actually names, deduplicated and in first-seen order.
 *
 * A rename contributes where the file is now, because that is where the model will go looking; the
 * old path is left out rather than listed as a file that still exists. This has to be what changed
 * and not what was allowed to change: the reminder tells the model not to redo work these paths
 * account for, so a path listed here that was never touched is an instruction to skip real work.
 */
function changedPaths(diff: readonly LiveDiffEntry[]): readonly string[] {
  return [...new Set(diff.map((entry) => entry.destination ?? entry.path))];
}
