import type { ChatMessage, TeamActivitySummary } from '../types/sprint-coder';
import { QUEUE_REASON_LABELS, formatClockTime } from './team-execution-display';

// Display facts for the persisted Team activity log (Core C2b), rendered as history cards inside
// the normal Chat timeline.
//
// Everything here is derived from fields the backend actually persists on `TeamActivitySummary`
// (see types/sprint-coder.d.ts and TeamDetail.activities): `type`, `actorRole`, `subjectRole`,
// `status`, `queueReason`, `attemptOrdinal`, `terminalReason`, `recordedAt`, `seq`. No payload is
// parsed, no Worker state is consulted, and an absent field never becomes a claim: a missing
// `status` or `terminalReason` produces no supplement at all rather than "成功".

export type TeamActivityType = TeamActivitySummary['type'];
export type TeamActivityQueueReason = NonNullable<TeamActivitySummary['queueReason']>;

/** `actorRole` is the agent that acted — unnamed actors are the Team's Leader. */
export const UNKNOWN_ACTOR_ROLE_LABEL = 'Leader';
/** `subjectRole` is the agent acted upon — unnamed subjects are a generic Agent. */
export const UNKNOWN_SUBJECT_ROLE_LABEL = 'Agent';
/** A `type` outside the persisted union (a newer backend against an older renderer) still gets a
 * readable line instead of a blank card; the raw value is shown as a supplement. */
export const UNKNOWN_ACTIVITY_HEADLINE = 'Teamの活動が記録されました';

export function actorRoleLabel(role: string | null | undefined): string {
  if (role == null || role.trim() === '') return UNKNOWN_ACTOR_ROLE_LABEL;
  return role;
}

export function subjectRoleLabel(role: string | null | undefined): string {
  if (role == null || role.trim() === '') return UNKNOWN_SUBJECT_ROLE_LABEL;
  return role;
}

/** Queue causes use the exact wording already shipped on the Worker execution card (Core C1b) —
 * the labels are imported, not restated, so the two surfaces cannot drift. */
export function activityQueueReasonLabel(reason: string | null | undefined): string | null {
  if (reason == null || reason === '') return null;
  return QUEUE_REASON_LABELS[reason as TeamActivityQueueReason] ?? reason;
}

/**
 * The sentence for each persisted activity type.
 *
 * The actor/subject split follows the contract's own naming: the actor is the agent that performed
 * the act, the subject is the agent it was performed on (`worker_hired` = actor hires subject).
 * Lifecycle rows for an execution or attempt therefore name the subject, whose work it is, while
 * rows describing an act by one agent upon another name both. Nothing beyond that is inferred —
 * in particular no line claims an outcome, because outcomes live in `status`/`terminalReason`.
 */
const ACTIVITY_HEADLINES: Readonly<
  Record<TeamActivityType, (actor: string, subject: string) => string>
> = {
  worker_hired: (actor, subject) => `${actor}が「${subject}」を雇いました`,
  task_assigned: (actor, subject) => `${actor}が${subject}へ作業を任せました`,
  execution_queued: (_actor, subject) => `${subject}の実行が順番待ちに入りました`,
  execution_waiting: (_actor, subject) => `${subject}の実行が待機中になりました`,
  execution_started: (_actor, subject) => `${subject}が実行を開始しました`,
  execution_finished: (_actor, subject) => `${subject}の実行が終了しました`,
  steered: (actor, subject) => `${actor}が${subject}の作業に指示を追加しました`,
  attempt_started: (_actor, subject) => `${subject}が試行を開始しました`,
  attempt_finished: (_actor, subject) => `${subject}の試行が終了しました`,
  worker_reported: (_actor, subject) => `${subject}から作業の報告がありました`,
  worker_stopped: (actor, subject) => `${actor}が${subject}の作業を停止しました`,
};

export function activityHeadline(activity: TeamActivitySummary): string {
  const build = ACTIVITY_HEADLINES[activity.type as TeamActivityType];
  if (build === undefined) return UNKNOWN_ACTIVITY_HEADLINE;
  return build(actorRoleLabel(activity.actorRole), subjectRoleLabel(activity.subjectRole));
}

/**
 * Supplements shown under the headline. Each one appears only when the backend recorded it, so an
 * unknown status is silent rather than being rendered as a completed run.
 */
export function activityDetails(activity: TeamActivitySummary): string[] {
  const details: string[] = [];
  if (ACTIVITY_HEADLINES[activity.type as TeamActivityType] === undefined) {
    details.push(`種別 ${activity.type}`);
  }
  if (typeof activity.attemptOrdinal === 'number') {
    details.push(`試行 ${activity.attemptOrdinal}回目`);
  }
  const queueReason = activityQueueReasonLabel(activity.queueReason);
  if (queueReason !== null) details.push(`待機理由 ${queueReason}`);
  if (activity.status != null && activity.status !== '') details.push(`状態 ${activity.status}`);
  if (activity.terminalReason != null && activity.terminalReason !== '') {
    details.push(`終了理由 ${activity.terminalReason}`);
  }
  return details;
}

export type TeamActivityDisplay = {
  id: string;
  type: string;
  recordedAt: string;
  timeLabel: string;
  headline: string;
  details: string[];
  /** The supplements as one line, or null when the backend recorded none. */
  detailLabel: string | null;
  /** Single-sentence announcement for the polite live region. */
  ariaSummary: string;
};

export function describeActivity(activity: TeamActivitySummary): TeamActivityDisplay {
  const headline = activityHeadline(activity);
  const details = activityDetails(activity);
  const timeLabel = formatClockTime(activity.recordedAt);
  return {
    id: activity.id,
    type: activity.type,
    recordedAt: activity.recordedAt,
    timeLabel,
    headline,
    details,
    detailLabel: details.length === 0 ? null : details.join(' · '),
    ariaSummary: [timeLabel, headline, ...details].join('、'),
  };
}

/** ISO timestamps sort correctly as strings, but only when both parse; fall back to lexicographic
 * order so a malformed value can never make the comparison non-deterministic. */
function compareTimestamps(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `seq` is the backend's own ordering. Duplicate ids collapse to their first occurrence so a
 * refetch that overlaps a live event can never render the same activity twice. */
export function orderedActivities(
  activities: readonly TeamActivitySummary[] | null | undefined,
): TeamActivitySummary[] {
  if (activities == null || activities.length === 0) return [];
  const seen = new Set<string>();
  const unique: TeamActivitySummary[] = [];
  for (const activity of activities) {
    if (seen.has(activity.id)) continue;
    seen.add(activity.id);
    unique.push(activity);
  }
  return unique
    .map((activity, index) => ({ activity, index }))
    .sort((a, b) => a.activity.seq - b.activity.seq || a.index - b.index)
    .map(({ activity }) => activity);
}

export type TimelineActivityGroups = {
  /** Activities recorded before the first message — never dropped. */
  leading: TeamActivityDisplay[];
  /** Activities recorded at or after a message, keyed by that message's id. Anything after the
   * last message lands on the last message, so the tail is never dropped either. */
  byMessageId: Record<string, TeamActivityDisplay[]>;
};

const NO_ACTIVITY_DISPLAYS: TeamActivityDisplay[] = [];

export const EMPTY_ACTIVITY_GROUPS: TimelineActivityGroups = {
  leading: NO_ACTIVITY_DISPLAYS,
  byMessageId: {},
};

/**
 * Slot each activity into the Chat timeline by `recordedAt`: it belongs after the last message
 * (in render order) that was created no later than it, and before that message's successor.
 *
 * Messages keep their own order and their own associated cards — this only says which gap between
 * two messages a history card falls into. Within a gap the activities stay in `seq` order.
 * With no activities at all the result is the shared empty object, so the timeline renders exactly
 * the DOM it rendered before this feature existed.
 */
export function groupActivitiesByMessage(
  messages: readonly Pick<ChatMessage, 'id' | 'createdAt'>[],
  activities: readonly TeamActivitySummary[] | null | undefined,
): TimelineActivityGroups {
  const ordered = orderedActivities(activities);
  if (ordered.length === 0) return EMPTY_ACTIVITY_GROUPS;

  const leading: TeamActivityDisplay[] = [];
  const byMessageId: Record<string, TeamActivityDisplay[]> = {};

  for (const activity of ordered) {
    let hostId: string | null = null;
    for (const message of messages) {
      if (compareTimestamps(message.createdAt, activity.recordedAt) <= 0) hostId = message.id;
    }
    const display = describeActivity(activity);
    if (hostId === null) {
      leading.push(display);
      continue;
    }
    const bucket = byMessageId[hostId];
    if (bucket === undefined) byMessageId[hostId] = [display];
    else bucket.push(display);
  }

  return { leading, byMessageId };
}
