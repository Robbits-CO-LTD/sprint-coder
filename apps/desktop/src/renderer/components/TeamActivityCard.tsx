import { useState } from 'react';
import type { TeamActivityDisplay } from '../lib/team-activity-display';
import { Markdown } from './Markdown';

/**
 * Team activity history card (Core C2b): one persisted `TeamActivitySummary` shown inline in the
 * normal Chat timeline, so "誰が誰を雇い、誰に何を任せたか" reads in the same column as the
 * conversation it happened during.
 *
 * Deliberately inert — no buttons, no `tabIndex`, no `<details>` — so the timeline's keyboard order
 * is exactly what it was. The type is carried by words (and exposed as `data-activity-type` for
 * tests/styling), never by colour alone, and nothing here animates.
 *
 * `data-activity-id` is the persisted activity's own id, mirrored onto the root purely as a
 * machine-readable identity: it is what lets a restart check assert that the timeline restored the
 * same activities and rendered each of them exactly once (`orderedActivities` dedupes by this id).
 * It is inert — no focus, ARIA, or visual consequence.
 */
export function TeamActivityCard({ activity }: { activity: TeamActivityDisplay }) {
  return (
    <div
      className="team-activity"
      data-testid="team-activity-card"
      data-activity-id={activity.id}
      data-activity-type={activity.type}
    >
      {/* Polite announcement of the same facts shown below — mirrors the Worker execution card's
          live region. Never assertive: Team history must not interrupt whatever is being read. */}
      <p className="visually-hidden" aria-live="polite" data-testid="team-activity-live">
        {activity.ariaSummary}
      </p>
      <time className="team-activity-time" dateTime={activity.recordedAt}>
        {activity.timeLabel}
      </time>
      <p className="team-activity-headline" data-testid="team-activity-headline">
        {activity.headline}
      </p>
      {activity.detailLabel !== null && (
        <p className="team-activity-detail" data-testid="team-activity-detail">
          {activity.detailLabel}
        </p>
      )}
    </div>
  );
}

export function formatTeamWorkDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (totalSeconds === 0) return '1s未満';
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * One Turn's Team trace. While the Turn is live the rows stay open so the user can follow the
 * tools as they happen. The moment the Turn settles, `active` stops forcing the disclosure open
 * and the same durable rows collapse behind one elapsed-time summary. Native `<details>` keeps the
 * history keyboard-accessible and lets a reader reopen it without a second state model.
 */
export function TeamActivityGroup({
  activities,
  active,
  startedAtMs,
  finishedAtMs,
  workContent,
}: {
  activities: readonly TeamActivityDisplay[];
  active: boolean;
  startedAtMs: number;
  finishedAtMs: number | null;
  workContent?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  if (activities.length === 0 && !workContent) return null;

  const recordedEnds = activities
    .map(({ recordedAt }) => Date.parse(recordedAt))
    .filter((value) => Number.isFinite(value));
  const endedAtMs = Math.max(startedAtMs, finishedAtMs ?? startedAtMs, ...recordedEnds);
  const open = active || expanded;
  const summaryLabel = active
    ? `作業中 · ${activities.length}件`
    : `${formatTeamWorkDuration(endedAtMs - startedAtMs)}作業しました`;

  return (
    <details
      className="team-activity-group"
      data-testid="team-activity-group"
      open={open}
      onToggle={(event) => {
        if (active) {
          if (!event.currentTarget.open) event.currentTarget.open = true;
          return;
        }
        setExpanded(event.currentTarget.open);
      }}
    >
      <summary
        data-testid="team-activity-summary"
        aria-label={`${summaryLabel}。作業履歴${activities.length}件`}
      >
        <span>{summaryLabel}</span>
        <span className="team-activity-chevron" aria-hidden="true">
          {open ? '⌄' : '›'}
        </span>
      </summary>
      <div className="team-activity-list">
        {workContent && (
          <div className="team-work-transcript" data-testid="team-work-transcript">
            <p className="team-work-transcript-label">作業中の会話</p>
            <Markdown content={workContent} />
          </div>
        )}
        {activities.map((activity) => (
          <TeamActivityCard key={activity.id} activity={activity} />
        ))}
      </div>
    </details>
  );
}
