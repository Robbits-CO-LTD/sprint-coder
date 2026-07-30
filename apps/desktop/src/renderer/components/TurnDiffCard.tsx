import { useId, useRef, useState } from 'react';
import type { TurnDiff, TurnDiffEntry } from '../types/sprint-coder';
import type { WorkspaceLineStats } from '../lib/workspace-change-summary';
import { Check } from './icons';

// The one summary of what a Turn wrote. Timeline anchors it to the assistant message of its Turn,
// so by the time it renders the work is over and the card can speak in the past tense.
//
// Line counts arrive only from a Runtime change summary that has an honest Turn baseline. They are
// omitted or marked partial rather than inferred from hashes. Undo is deliberately absent: no safe
// rollback boundary exists in this Slice.

/** Rows shown before the reader asks for the rest. */
export const PREVIEW_COUNT = 3;

const KIND_LABEL: Record<TurnDiffEntry['kind'], string> = {
  add: '追加',
  update: '更新',
  delete: '削除',
  rename: '名前変更',
};

/** `12秒` / `1分5秒` / `2時間3分`, or null for anything that cannot be stated truthfully. Not
 * lib/format's `formatElapsed`: that one is the running mm:ss clock on the Run Card, this one is a
 * finished duration read once. */
export function formatWorkDuration(elapsedMs: number | null | undefined): string | null {
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  const totalSeconds = Math.round(elapsedMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}分` : `${minutes}分${seconds}秒`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}時間` : `${hours}時間${restMinutes}分`;
}

export function TurnDiffCard({
  diff,
  elapsedMs = null,
  lineStats = null,
  workerBreakdown = [],
}: {
  diff: TurnDiff;
  elapsedMs?: number | null;
  lineStats?: WorkspaceLineStats | null;
  workerBreakdown?: readonly { role: string; status: string }[];
}) {
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const headingId = useId();
  const listId = useId();

  if (diff.entries.length === 0) return null;

  const entries = diff.entries;
  const hidden = Math.max(0, entries.length - PREVIEW_COUNT);
  const visible = expanded ? entries : entries.slice(0, PREVIEW_COUNT);
  const duration = formatWorkDuration(elapsedMs);
  // Surfaced on the card as well as on the row: collapsing to three rows can hide a drifted file,
  // and the warning is the one thing here that must not depend on the reader expanding the list.
  const driftCount = entries.filter((entry) => entry.status === 'external_drift').length;

  // 「レビューする」 opens no diff viewer and asks Main for nothing — neither exists. It does the one
  // honest thing a summary card can do: show every row and put the keyboard on the list.
  const reviewList = () => {
    setExpanded(true);
    listRef.current?.focus();
    listRef.current?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <section className="turn-diff-card" data-testid="turn-diff-card" aria-labelledby={headingId}>
      <div className="turn-diff-head">
        <span className="turn-diff-check" aria-hidden="true">
          <Check size={12} />
        </span>
        <h3 className="turn-diff-title" id={headingId}>
          {entries.length}件のファイルを編集
        </h3>
        <span className="turn-diff-status" data-testid="turn-diff-status">
          {duration === null ? '作業しました' : `${duration}作業しました`}
        </span>
      </div>

      {lineStats !== null && (
        <p className="turn-diff-line-stats" data-testid="turn-diff-line-stats">
          <span className="turn-diff-added">+{lineStats.added}</span>{' '}
          <span className="turn-diff-deleted">-{lineStats.deleted}</span>
          {lineStats.incomplete && <span className="turn-diff-partial">（一部不明）</span>}
        </p>
      )}

      {driftCount > 0 && (
        <p className="turn-diff-drift-note" data-testid="turn-diff-drift-note">
          {driftCount}件のファイルがこのターンの記録と一致しません（外部変更あり）
        </p>
      )}

      {/* tabIndex -1, not 0: the list is a focus target for 「レビューする」, not a tab stop. */}
      <ul className="turn-diff-list" id={listId} ref={listRef} tabIndex={-1}>
        {visible.map((entry) => (
          <li
            className="turn-diff-row"
            key={`${entry.ordinal}:${entry.path}:${entry.destination ?? ''}`}
          >
            <span className={`turn-diff-kind turn-diff-kind--${entry.kind}`}>
              {KIND_LABEL[entry.kind]}
            </span>
            <bdi className="turn-diff-path" dir="ltr" title={entry.path}>
              {entry.path}
            </bdi>
            {entry.destination !== null && (
              <>
                <span className="turn-diff-arrow" aria-hidden="true">
                  →
                </span>
                <span className="sr-only">から</span>
                <bdi className="turn-diff-path" dir="ltr" title={entry.destination}>
                  {entry.destination}
                </bdi>
              </>
            )}
            {entry.status === 'external_drift' && (
              <span className="turn-diff-drift">外部変更あり</span>
            )}
          </li>
        ))}
      </ul>

      {workerBreakdown.length > 0 && (
        <div className="turn-diff-workers" data-testid="turn-diff-workers">
          <span className="turn-diff-workers-title">Team内訳</span>
          <ul>
            {workerBreakdown.map((worker) => (
              <li key={`${worker.role}:${worker.status}`}>
                <span>{worker.role}</span>
                <span>{worker.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="turn-diff-actions">
        {hidden > 0 && (
          <button
            type="button"
            className="turn-diff-action"
            data-testid="turn-diff-toggle"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '閉じる' : `あと${hidden}件のファイルを表示`}
          </button>
        )}
        <button
          type="button"
          className="turn-diff-action turn-diff-action--primary"
          data-testid="turn-diff-review"
          aria-controls={listId}
          onClick={reviewList}
        >
          レビューする
        </button>
      </div>
    </section>
  );
}
