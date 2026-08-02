import type { FileChange, TurnDiff } from '../types/sprint-coder';
import type { LiveFileEdit } from './file-edit-buffer';

const MAX_EXACT_DIFF_LINES = 400;
const MAX_FRAME_CHARACTERS = 262_144;

export type WorkspaceLineStats = {
  added: number;
  deleted: number;
  incomplete: boolean;
};

export type WorkspaceChangeSummary = {
  diff: TurnDiff;
  lineStats: WorkspaceLineStats;
};

export function changedLineStats(
  beforeText: string,
  afterText: string,
): { added: number; deleted: number } | null {
  if (beforeText.length >= MAX_FRAME_CHARACTERS || afterText.length >= MAX_FRAME_CHARACTERS)
    return null;
  const before = lines(beforeText);
  const after = lines(afterText);
  if (before.length > MAX_EXACT_DIFF_LINES || after.length > MAX_EXACT_DIFF_LINES) return null;

  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const row = table[i];
    if (row === undefined) continue;
    for (let j = after.length - 1; j >= 0; j -= 1)
      row[j] =
        before[i] === after[j]
          ? (table[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
  }
  const common = table[0]?.[0] ?? 0;
  return { added: after.length - common, deleted: before.length - common };
}

export function summarizeRuntimeChanges(
  turnId: string,
  records: readonly { changes: FileChange[] }[],
  liveEdits: readonly LiveFileEdit[],
): WorkspaceChangeSummary | null {
  const latestByPath = new Map<string, FileChange>();
  const order: string[] = [];
  for (const record of records) {
    for (const change of record.changes) {
      const key = `${change.rootId}\u0000${change.path}`;
      if (!latestByPath.has(key)) order.push(key);
      latestByPath.set(key, change);
    }
  }
  if (order.length === 0) return null;

  const editByPath = new Map<string, LiveFileEdit>(
    liveEdits
      .filter((edit) => edit.turnId === turnId && edit.complete)
      .map((edit) => [`${edit.rootId}\u0000${edit.path}`, edit] as const),
  );
  let added = 0;
  let deleted = 0;
  let incomplete = false;

  const entries = order.flatMap((key, index) => {
    const change = latestByPath.get(key);
    if (change === undefined) return [];
    const edit = editByPath.get(key);
    if (change.kind === 'add' && edit !== undefined) {
      const stats = changedLineStats('', edit.text);
      if (stats === null) incomplete = true;
      else {
        added += stats.added;
        deleted += stats.deleted;
      }
    } else if (change.kind === 'update' && edit?.baseline !== null && edit !== undefined) {
      const stats = changedLineStats(edit.baseline, edit.text);
      if (stats === null) incomplete = true;
      else {
        added += stats.added;
        deleted += stats.deleted;
      }
    } else {
      // Deletes and late Runtime reports do not always carry a trustworthy before-image. The card
      // stays useful, but never turns an absent baseline into a made-up line count.
      incomplete = true;
    }
    return [
      {
        ordinal: index + 1,
        kind: change.kind,
        path: `${change.rootLabel} › ${change.path}`,
        destination: null,
        preHash: null,
        postHash: null,
        provenance: 'agent_edit' as const,
        status: 'applied' as const,
        actualHash: null,
      },
    ];
  });

  return {
    diff: { turnId, entries },
    lineStats: { added, deleted, incomplete },
  };
}

function lines(text: string): string[] {
  if (text.length === 0) return [];
  const result = text.split('\n');
  if (result.at(-1) === '') result.pop();
  return result;
}
