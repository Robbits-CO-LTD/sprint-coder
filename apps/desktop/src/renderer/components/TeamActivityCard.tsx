import type { TeamActivityDisplay } from '../lib/team-activity-display';

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
