import type { AccessPreset, ProjectDefaultAccess } from '@sprint-coder/contracts';

/**
 * Decides whether a Project's remembered default may seed a Task's access preset, and with what.
 *
 * This is the whole behavioural payload of the Project feature — a Project is otherwise just a row
 * — so it lives here as a pure function rather than inline in the IPC handler, where it could only
 * be exercised through a live BrowserWindow.
 *
 * Returns the preset to apply, or `null` to leave the Task alone.
 *
 * Codex's equivalent is the approval-policy default derived from `trust_level`
 * (.reference-repos/codex/codex-rs/core/src/config/mod.rs:3574), with the same precedence: an
 * explicit per-session choice wins over the folder's stored trust.
 */
export function projectAccessToApply(input: {
  projectDefaultAccess: ProjectDefaultAccess;
  /** The Task's current permission-policy epoch. 0 means no preset has ever been written for it. */
  taskPolicyEpoch: number;
}): AccessPreset | null {
  // The user already set a preset on this Task by hand. A folder default answers the question for
  // Tasks that were never asked; it does not overrule an answer given for this specific Task.
  if (input.taskPolicyEpoch !== 0) return null;
  // 'ask' is already where a Task starts, so applying it would burn a policy epoch — and make every
  // Runtime re-read a policy — to arrive exactly where it began.
  if (input.projectDefaultAccess === 'ask') return null;
  return input.projectDefaultAccess;
}
