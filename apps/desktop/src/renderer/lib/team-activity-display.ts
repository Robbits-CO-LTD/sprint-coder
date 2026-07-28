import type {
  ChatMessage,
  TeamActivitySummary,
  TeamMessageSummary,
  WorkerSummary,
} from '../types/sprint-coder';
import {
  BUILTIN_CONNECTION_LABELS,
  QUEUE_REASON_LABELS,
  formatClockTime,
} from './team-execution-display';

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

// ---------------------------------------------------------------------------------------------
// Model selection facts (Team v2): which model and which Connection an agent actually got, and —
// on the hire itself — why.
//
// These live here rather than in team-execution-display.ts because the same three persisted fields
// appear on BOTH `TeamActivitySummary` (the hire row) and `WorkerSummary` (the card), and both
// surfaces must word them identically. Nothing is inferred: `engine` never stands in for a model,
// a provider id is never turned into a product name, and an absent value is stated as 不明 rather
// than left blank or guessed at.
// ---------------------------------------------------------------------------------------------

/** A model/Connection the backend did not record is said to be unknown, never omitted silently. */
export const UNKNOWN_MODEL_SELECTION_LABEL = '不明';

/** How long a `modelSelectionReason` may render before it is clamped. The contract allows 2,000
 * characters; a history card is one line of annotation, so the tail is elided rather than allowed
 * to push the whole timeline around. */
export const MODEL_SELECTION_REASON_MAX_LENGTH = 120;

/** A value the backend did not record and a value it recorded as whitespace are the same fact —
 * "not known" — so both collapse to null here rather than being told apart downstream. */
function recorded(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The model id verbatim — it is the backend's own string, and no part of it is interpreted. */
export function requestedModelLabel(model: string | null | undefined): string {
  return recorded(model) ?? UNKNOWN_MODEL_SELECTION_LABEL;
}

/** Built-in runtimes get their product name (the same map the execution card uses, imported rather
 * than restated so the two cannot drift); every other id is a user-created Connection whose display
 * name this contract does not carry, so the id itself is shown verbatim. */
export function requestedConnectionLabel(connectionId: string | null | undefined): string {
  const id = recorded(connectionId);
  if (id === null) return UNKNOWN_MODEL_SELECTION_LABEL;
  return BUILTIN_CONNECTION_LABELS[id] ?? id;
}

/** Reasons are free text from the backend: newlines collapse to spaces so one reason cannot become
 * several lines of a one-line card, and an over-long reason is elided at a character boundary. */
export function modelSelectionReasonLabel(reason: string | null | undefined): string | null {
  const text = recorded(reason);
  if (text === null) return null;
  const collapsed = text.replace(/\s+/g, ' ');
  if (collapsed.length <= MODEL_SELECTION_REASON_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, MODEL_SELECTION_REASON_MAX_LENGTH)}…`;
}

// ---------------------------------------------------------------------------------------------
// Which runtime a Worker is actually running on (Team v2 multi-provider).
//
// `engine` is a backend-compatibility field whose union is still `mock | codex | claude`, so an
// external-API Worker necessarily carries one of those three values. Reading it as the runtime is
// therefore wrong for every Worker hired against a Provider Connection — it would announce a
// GPT-5 Worker as "Claude". `connectionId` is the execution identity, so it decides.
// ---------------------------------------------------------------------------------------------

/** A Connection that is not one of the two built-in CLIs runs against an external Provider API.
 * The contract carries no display name for it, and a Provider name must never be guessed from a
 * connection id or a model id, so the surface states the only fact it has: it is an API run. */
export const EXTERNAL_API_RUNTIME_LABEL = 'API';

/** Product names for the built-in runtimes. Deliberately NOT `BUILTIN_CONNECTION_LABELS`: that map
 * words the Connection row ("Claude CLI"), while this is the role/objective sub-line, which has
 * always read "Claude"/"Codex". Both are keyed by the same two connection ids. */
const BUILTIN_RUNTIME_LABELS: Readonly<Record<string, string>> = {
  'builtin:claude-cli': 'Claude',
  'builtin:codex-cli': 'Codex',
};

/** The pre-multi-provider wording, kept only for rows the backend recorded no Connection on.
 * Keyed off the union so adding an engine is a type error here rather than a silent "Mock"; the
 * lookup below still guards at runtime, since a newer backend can send this renderer a value the
 * union does not yet have — exactly what the Canvas card's old ternary defaulted to "Mock". */
const ENGINE_RUNTIME_LABELS: Readonly<Record<WorkerSummary['engine'], string>> = {
  claude: 'Claude',
  codex: 'Codex',
  mock: 'Mock',
};

/**
 * The runtime name shown beside a Worker's objective, on the Canvas card and in the List row alike.
 *
 * A recorded `connectionId` is the Worker's real execution identity: the two built-in ids get their
 * product name, and every other id — a user-created Provider Connection — is announced as an API
 * run rather than as a Provider name inferred from the id. Only a legacy row that carries no
 * Connection at all falls back to `engine`, where it is still the best fact available.
 */
export function workerRuntimeLabel(worker: Pick<WorkerSummary, 'connectionId' | 'engine'>): string {
  const id = recorded(worker.connectionId);
  if (id !== null) return BUILTIN_RUNTIME_LABELS[id] ?? EXTERNAL_API_RUNTIME_LABEL;
  return ENGINE_RUNTIME_LABELS[worker.engine] ?? ENGINE_RUNTIME_LABELS.mock;
}

export type WorkerModelDisplay = {
  /** Always a sentence-worthy string — 不明 when the backend recorded no model. */
  modelLabel: string;
  /** Always a sentence-worthy string — 不明 when the backend recorded no Connection. */
  connectionLabel: string;
  /** Single-sentence announcement, so the Canvas card and the List row say the same thing. */
  ariaSummary: string;
};

/**
 * The model/Connection pair a Worker card shows. Both keys always render: unlike the optional
 * supplements on an activity card, "which model is this Worker running on" is a question the card
 * exists to answer, so silence there would read as "no model" rather than "not recorded".
 */
export function describeWorkerModel(
  worker: Pick<WorkerSummary, 'connectionId' | 'requestedModel'>,
): WorkerModelDisplay {
  const modelLabel = requestedModelLabel(worker.requestedModel);
  const connection = requestedConnectionLabel(worker.connectionId);
  return {
    modelLabel,
    connectionLabel: connection,
    ariaSummary: `モデル ${modelLabel}、Connection ${connection}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Who a Worker card's message line is actually talking to (Team v2 worker-to-worker messaging).
//
// The backend persists `sourceAgentId`/`targetAgentId` on every `TeamMessageSummary` and a Manager
// Worker may message its own children (see team-tools.ts / the hierarchy on `WorkerSummary`), so a
// line on a Worker card is NOT necessarily a Leader exchange. Both the Canvas card and the List row
// used to hard-code "Leaderから"/"報告", which renders a Worker A -> Worker B message as if the
// Leader had sent it. The peer is resolved here, from the persisted ids alone, so the two surfaces
// cannot word the same message differently.
// ---------------------------------------------------------------------------------------------

/** The Team's root agent, matched by `team.leaderAgentId` — never by engine/provider/model. */
export const LEADER_MESSAGE_PEER_LABEL = 'Leader';
/** A peer id that matches neither the Leader nor any known agent (a legacy or corrupted row). The
 * line still names a counterpart rather than going blank, but nothing about WHICH agent it was is
 * invented — an id, a Connection or a model id is not a role. */
export const UNKNOWN_MESSAGE_PEER_LABEL = 'Agent';

export type TeamMessageDirection = 'incoming' | 'outgoing';

export type TeamMessagePeerDisplay = {
  /** Relative to the Worker whose card is rendering: `incoming` is addressed TO it. */
  direction: TeamMessageDirection;
  /** The persisted id of the agent at the other end — the sender for `incoming`, the recipient
   * for `outgoing`. Empty only when the backend recorded none. */
  peerAgentId: string;
  /** The counterpart's role: `Leader`, a Worker's own role, or `Agent` when unresolvable. */
  peerLabel: string;
  /** The tag on the message line — `…から` for `incoming`, `…へ` for `outgoing`. */
  tagLabel: string;
};

export type TeamMessagePeerContext = {
  /** The Worker whose card/row is rendering these lines. */
  agentId: string;
  /** `team.leaderAgentId`: the only id that may be named Leader. */
  leaderAgentId: string;
  /** Every agent a peer id can be resolved against, by persisted id. The Leader is matched by
   * `leaderAgentId` above and so does not need to appear here. */
  agents: readonly Pick<WorkerSummary, 'id' | 'role'>[];
};

/**
 * The direction and counterpart of one message line on a Worker card.
 *
 * Direction is decided exactly as both surfaces already decided it — a message whose target is this
 * Worker is incoming — so message order, styling and the rendered body are untouched; only WHO the
 * tag names changes. Resolution is by persisted agent id only: the Leader is `leaderAgentId`, any
 * other id must be present in `agents` to be named, and everything else is stated as a generic
 * Agent. A `kind`, a connection id or a model never stands in for a role here.
 */
export function describeMessagePeer(
  message: Pick<TeamMessageSummary, 'sourceAgentId' | 'targetAgentId'>,
  context: TeamMessagePeerContext,
): TeamMessagePeerDisplay {
  const direction: TeamMessageDirection =
    message.targetAgentId === context.agentId ? 'incoming' : 'outgoing';
  const peerAgentId = direction === 'incoming' ? message.sourceAgentId : message.targetAgentId;
  const peerLabel = messagePeerLabel(peerAgentId, context);
  return {
    direction,
    peerAgentId,
    peerLabel,
    tagLabel: direction === 'incoming' ? `${peerLabel}から` : `${peerLabel}へ`,
  };
}

/** An id the backend never recorded, an id belonging to no known agent, and an agent whose role is
 * blank are all the same fact — "which agent this was is not known" — so all three land on the
 * generic label instead of leaking a raw id into the sentence. */
function messagePeerLabel(peerAgentId: string, context: TeamMessagePeerContext): string {
  const id = recorded(peerAgentId);
  if (id === null) return UNKNOWN_MESSAGE_PEER_LABEL;
  if (id === recorded(context.leaderAgentId)) return LEADER_MESSAGE_PEER_LABEL;
  const agent = context.agents.find((candidate) => candidate.id === id);
  if (agent === undefined) return UNKNOWN_MESSAGE_PEER_LABEL;
  return recorded(agent.role) ?? UNKNOWN_MESSAGE_PEER_LABEL;
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
  // The hire is where the model choice is MADE, so it is the row that explains it. Every later row
  // for the same Worker would only restate what its card and its execution card already show, and
  // `modelSelectionReason` is only ever recorded against the decision itself. Each of the three is
  // a supplement like the ones above: absent means absent, so nothing is claimed and no 不明
  // placeholder is invented here — that wording belongs on the Worker card, which must answer the
  // question every time it renders.
  if (activity.type === 'worker_hired') {
    if (recorded(activity.requestedModel) !== null) {
      details.push(`モデル ${requestedModelLabel(activity.requestedModel)}`);
    }
    if (recorded(activity.connectionId) !== null) {
      details.push(`Connection ${requestedConnectionLabel(activity.connectionId)}`);
    }
    const reason = modelSelectionReasonLabel(activity.modelSelectionReason);
    if (reason !== null) details.push(`選定理由 ${reason}`);
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
