import type { WorkerActivityEntry } from '@sprint-coder/contracts';

/** How many of a Worker's newest work-log steps travel with its summary to the renderer. */
export const WORKER_ACTIVITY_LOG_LIMIT = 30;

const LABEL_MAX = 500;

const FILE_CHANGE_VERB: Record<'add' | 'update' | 'delete', string> = {
  add: '作成',
  update: '編集',
  delete: '削除',
};

/** `編集 src/app.ts` / `作成 src/a.ts ほか2件` — the first path names the step, the count the rest. */
export function describeFileChanges(
  changes: readonly { path: string; kind: 'add' | 'update' | 'delete' }[],
): string {
  const first = changes[0];
  if (first === undefined) return 'ファイル変更';
  const rest = changes.length - 1;
  return `${FILE_CHANGE_VERB[first.kind]} ${first.path}${rest > 0 ? ` ほか${rest}件` : ''}`;
}

function clip(label: string): string {
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
}

/**
 * One persisted `team_activity_events` row (or the live event it was written from) as a work-log
 * entry, or null for event types the log does not show and for payloads it cannot read.
 */
export function workerActivityEntry(
  type: string,
  payload: unknown,
  at: string,
): WorkerActivityEntry | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (type === 'activity') {
    const label = record['label'];
    return typeof label === 'string' && label.trim() !== ''
      ? { kind: 'activity', label: clip(label.trim()), at }
      : null;
  }
  if (type === 'fileChange') {
    const changes = record['changes'];
    if (!Array.isArray(changes)) return null;
    const readable = changes.filter(
      (change): change is { path: string; kind: 'add' | 'update' | 'delete' } =>
        typeof change === 'object' &&
        change !== null &&
        typeof (change as { path?: unknown }).path === 'string' &&
        ['add', 'update', 'delete'].includes((change as { kind?: unknown }).kind as string),
    );
    return readable.length === 0
      ? null
      : { kind: 'fileChange', label: clip(describeFileChanges(readable)), at };
  }
  return null;
}
