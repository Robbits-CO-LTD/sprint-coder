import type { ModelSelection } from '@sprint-coder/contracts';

/**
 * The rules that keep the legacy Runtime/Model chips and the V2 Model Picker on *one* selection
 * (Team v2 UI slice U2).
 *
 * Both surfaces write through Main, which derives one from the other, so the only thing the
 * renderer has to get right is *which answer is still true by the time it arrives*. Every rule here
 * is a pure function of (what was asked for, what came back, what the app is showing now) — no
 * store, no window, no `runtime.kind`. The picker stays Runtime-agnostic by construction: nothing
 * below can branch on which CLI is installed because nothing below is given that fact.
 */

/**
 * What the Composer needs to decide *which* model picker to show, and what the V2 one starts from.
 *
 * Deliberately small: the catalog itself is never mirrored in the store. `models.query` is
 * Main-owned, paged and filtered, and holding its pages in the renderer would make it the second
 * place a 1000+ model catalog lives — the picker keeps its own page window instead and this carries
 * only the facts that outlive the popup being open.
 */
export type ModelPickerSnapshot = {
  /** The Task the two fields below were resolved for. */
  taskId: string | null;
  /** `multiProviderModelPickerV2` as Main reported it. `null` while unresolved — the Composer keeps
   * the legacy chip until this is explicitly `true`, so an in-flight (or never-arriving) answer
   * degrades to today's UI rather than to an empty one. */
  enabled: boolean | null;
  /** Main's canonical selection for the Task. Null when Main has not answered yet. */
  selection: ModelSelection | null;
};

/** Shown when Main has no selection for the Task: the provider default decides, and saying so is
 * more honest than naming a model the app only guessed at. */
export const MODEL_PICKER_AUTO_LABEL = '自動';

/** The catalog row the user last clicked, kept only so the trigger can show a display name instead
 * of a raw id. Identity is carried alongside the name so the name can be *disowned* the moment the
 * canonical selection moves somewhere else — see `resolveTriggerLabel`. */
export type ChosenModel = {
  connectionId: string | null;
  requestedModel: string | null;
  displayName: string;
};

export function sameSelection(a: ModelSelection | null, b: ModelSelection | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.connectionId === b.connectionId &&
    a.requestedProvider === b.requestedProvider &&
    a.requestedModel === b.requestedModel
  );
}

/** The V2 picker replaces the legacy chip only once Main has answered `true` for *this* Task.
 * Unresolved (`null`), a backend without the `models` API, and a resolved answer that belongs to
 * the Task the user just left all keep the legacy chip — so the flag being off is indistinguishable
 * from today's UI. */
export function isModelPickerV2Active(snapshot: ModelPickerSnapshot, taskId: string): boolean {
  return snapshot.enabled === true && snapshot.taskId === taskId;
}

/** The canonical selection, but only when it is genuinely *this* Task's.
 *
 * The snapshot is a single slot, so between a Task switch and that Task's answer arriving it still
 * holds the previous Task's selection. Reading it unconditionally would tick a row as selected — and
 * label the trigger — with a model the current Task was never set to. */
export function selectionForTask(
  snapshot: ModelPickerSnapshot,
  taskId: string,
): ModelSelection | null {
  return snapshot.taskId === taskId ? snapshot.selection : null;
}

/** What the trigger says.
 *
 * `chosen` is a *display* convenience, never a second source of truth: it is used only while it
 * still describes the canonical selection. So a legacy Runtime/Model write, a Main answer that
 * normalised the request to something else, a failed write that rolled back, and a Task switch all
 * drop the local name automatically rather than leaving the trigger asserting a model the app is no
 * longer on. When the name has been disowned, the id is the most Main actually told us. */
export function resolveTriggerLabel(
  selection: ModelSelection | null,
  chosen: ChosenModel | null,
): string {
  if (
    chosen !== null &&
    selection !== null &&
    selection.connectionId === chosen.connectionId &&
    selection.requestedModel === chosen.requestedModel
  )
    return chosen.displayName;
  return selection?.requestedModel ?? MODEL_PICKER_AUTO_LABEL;
}

/**
 * Whether a resolved `models` answer may still be written to the store.
 *
 * Two independent ways to be stale, and both have to be checked:
 *  - the user moved to another Task, so the answer describes a Task that is no longer on screen;
 *  - a newer read or write started after this one, so this answer predates an intent the user has
 *    already expressed. Tokens are handed out in start order, which makes "newest intent wins"
 *    decidable without knowing whether it was a read or a write.
 */
export function shouldApplyModelPickerAnswer(args: {
  requestTaskId: string;
  requestToken: number;
  currentTaskId: string | null;
  latestToken: number;
}): boolean {
  return args.requestTaskId === args.currentTaskId && args.requestToken === args.latestToken;
}

/** An optimistic selection may only be painted over the Task it belongs to. Writing it against
 * another Task's snapshot would also have to invent that Task's `enabled`, and a guess there is the
 * difference between the V2 picker and the legacy chip. */
export function canApplyOptimisticSelection(current: ModelPickerSnapshot, taskId: string): boolean {
  return current.taskId === taskId;
}

/**
 * Undoes an optimistic selection write that Main rejected — and *only* that write.
 *
 * A rejection can arrive long after the user has moved on, so the rollback has to prove the store
 * still holds what it is about to remove: same Task, same attempted selection. Otherwise the newer
 * state is the truth and restoring the pre-write snapshot would hand one Task's selection to
 * another. When the snapshot that was captured before the write belongs to a different Task there
 * is nothing trustworthy to restore, so the selection goes back to "not answered" rather than to a
 * borrowed value.
 */
export function rollbackModelPicker(args: {
  current: ModelPickerSnapshot;
  previous: ModelPickerSnapshot;
  taskId: string;
  attempted: ModelSelection;
}): ModelPickerSnapshot {
  const { current, previous, taskId, attempted } = args;
  if (current.taskId !== taskId) return current;
  if (!sameSelection(current.selection, attempted)) return current;
  if (previous.taskId === taskId) return previous;
  return { taskId, enabled: current.enabled, selection: null };
}
