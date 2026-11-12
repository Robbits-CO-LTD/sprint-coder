import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  desktopControlArgvIsInert,
  desktopControlStateFolder,
  type DesktopControlSessionVariables,
} from './desktop-control';
import { secureLogger } from './secure-logger';

/**
 * The multi-agent session Main keeps for each Task, so that every agent working on the Task draws
 * its own cursor (`session start --cursor --multi-agent`). Off unless the hidden opt-in
 * `SPRINT_CODER_DESKTOP_TEAM_CURSORS=1` was set when Main started (`configureDesktopControlTeamCursors`);
 * off, nothing here runs and every desktop-control run is exactly as before.
 *
 * On, Main starts the Task's session itself before the Task's first desktop-control run that is
 * not inert, and every such run of the Task then runs in it: Main sets the session and the agent
 * id as variables (`desktopControlEnvironment`), and the agent may not choose either
 * (`desktopControlSessionArgvRefusal`). The Leader runs as agent `leader`; a Team Worker the
 * Leader marked for desktop control (`markDesktopControlWorker`) runs as its own agent, with its
 * role and an accent of its own on its cursor. The session ends when the Task is archived (and the
 * Task's marks are forgotten) and when Sprint Coder quits; the cursors'
 * renderer also ends by itself when Main exits.
 *
 * A session keeps its snapshots below its own folder, so the approval card and the app-wide Task
 * grant read the parts a ref names from there, and only for Main's own session of that Task
 * (`desktopControlSessionReadScope`).
 */

/** The agent id of the Leader in the Task's session. */
export const DESKTOP_CONTROL_LEADER_AGENT_ID = 'leader';
const LEADER_LABEL = 'Leader';
const LEADER_ACCENT = '#2563EB';
const SESSION_NAME = 'sprint-coder';
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/u;
/**
 * How long each cursor of the Task stays drawn after its agent's last action before it fades
 * (`--linger-ms`; the executable's own is about 6 seconds). An agent's actions are often several
 * seconds apart, so with the executable's own, the Team's cursors were rarely on screen together.
 * Finite, because a cursor is drawn above every window, the user's own included, whether or not
 * the window it acted on is still in view; a finished Worker's cursor goes away by the same time.
 */
export const DESKTOP_CONTROL_CURSOR_LINGER_MS = 30_000;
const LINGER = ['--linger-ms', String(DESKTOP_CONTROL_CURSOR_LINGER_MS)] as const;
/** How long quitting waits for the sessions to end; the renderer ends with Main regardless. */
const END_ALL_TIMEOUT_MS = 3_000;

/**
 * Runs the shipped desktop-control executable as Main itself, through the same preparation, seal
 * check and runner as the agent's runs, and returns what it printed; throws when it could not run
 * or did not exit 0. Given a session, the run is placed in it as that agent.
 */
export type DesktopControlOwnRun = (
  argv: readonly string[],
  session?: DesktopControlSessionVariables,
) => Promise<string>;

type TaskSession = {
  /** Set once `session start` printed the id. */
  id: string | null;
  ready: Promise<DesktopControlSessionVariables>;
  run: DesktopControlOwnRun;
  /** The Workers whose cursor has been styled in this session, by agent id. */
  styled: Map<string, Promise<void>>;
};

/**
 * The Worker cursors' accents, in the order the Team's desktop Workers were marked. None is close
 * to the Leader's blue. The one place these colors live (the Team view is to match them later).
 */
export const DESKTOP_CONTROL_WORKER_ACCENTS = Object.freeze([
  '#16A34A',
  '#EA580C',
  '#9333EA',
  '#DB2777',
  '#0D9488',
  '#CA8A04',
  '#DC2626',
  '#92400E',
]);
/** How many Workers of one Task may hold desktop control at once (at most `..._MAX`). */
export const DESKTOP_CONTROL_WORKERS_DEFAULT = 3;
export const DESKTOP_CONTROL_WORKERS_MAX = 5;
const DESKTOP_CONTROL_WORKERS = Math.min(
  DESKTOP_CONTROL_WORKERS_DEFAULT,
  DESKTOP_CONTROL_WORKERS_MAX,
);
const LABEL_MAX = 24;

/** A Worker the Leader marked for desktop control: the cursor it draws, and how it is named. */
export type DesktopControlWorker = Readonly<{
  /** The Team agent (`AgentRecord.id`). */
  workerId: string;
  /** The agent id its runs carry, in the form the executable accepts. */
  agentId: string;
  /** Its role, as its cursor and the approval card name it. */
  label: string;
  /** Its accent's place in `DESKTOP_CONTROL_WORKER_ACCENTS`. */
  colorIndex: number;
}>;

/**
 * The hidden opt-in as this Main process started with it. Main turns the feature on from it once
 * (`configureDesktopControlTeamCursors`), and the Leader's hire tool offers the desktop mark only
 * when it was given, so without it the tool is exactly as it was.
 */
export const DESKTOP_CONTROL_TEAM_CURSORS_AT_START =
  process.env['SPRINT_CODER_DESKTOP_TEAM_CURSORS'] === '1';

let teamCursors = false;
let collected: Promise<void> | null = null;
const sessions = new Map<string, TaskSession>();
const desktopWorkers = new Map<string, Map<string, DesktopControlWorker>>();

/** Read once, when Main starts; `false` keeps every run as it was. */
export function configureDesktopControlTeamCursors(enabled: boolean): void {
  teamCursors = enabled;
}

export function desktopControlTeamCursors(): boolean {
  return teamCursors;
}

/**
 * The Task's session, started (and the Leader's cursor styled) on the first call, as the Leader,
 * or as the Worker given, whose cursor is styled (its role and accent) the first time it runs in
 * the session. A failure leaves nothing behind, so the next call tries again, and is thrown: the
 * run that needed it does not start outside the session or with an unstyled cursor.
 */
export async function ensureDesktopControlSession(
  taskId: string,
  run: DesktopControlOwnRun,
  worker?: DesktopControlWorker,
): Promise<DesktopControlSessionVariables> {
  if (!teamCursors) throw new Error('Desktop control team cursors are off');
  const entry = taskSession(taskId, run);
  const leader = await entry.ready;
  if (worker === undefined) return leader;
  const scoped = { id: leader.id, agentId: worker.agentId };
  let styled = entry.styled.get(worker.agentId);
  if (styled === undefined) {
    styled = run(
      [
        'cursor-overlay',
        'enable',
        '--label',
        worker.label,
        '--accent',
        DESKTOP_CONTROL_WORKER_ACCENTS[worker.colorIndex % DESKTOP_CONTROL_WORKER_ACCENTS.length]!,
        ...LINGER,
      ],
      scoped,
    ).then(() => undefined);
    entry.styled.set(worker.agentId, styled);
    styled.catch(() => {
      if (entry.styled.get(worker.agentId) === styled) entry.styled.delete(worker.agentId);
    });
  }
  await styled;
  return scoped;
}

function taskSession(taskId: string, run: DesktopControlOwnRun): TaskSession {
  const existing = sessions.get(taskId);
  if (existing !== undefined) return existing;
  const entry: TaskSession = {
    id: null,
    ready: Promise.resolve({ id: '', agentId: '' }),
    run,
    styled: new Map(),
  };
  entry.ready = (async () => {
    // Sessions an earlier Sprint Coder ended are only folders by now; reclaimed once per start.
    collected ??= run(['session', 'gc', '--ended']).then(
      () => undefined,
      (error: unknown) => {
        secureLogger.warn('Desktop control could not reclaim ended sessions', {
          error: errorText(error),
        });
      },
    );
    await collected;
    const id = sessionIdOf(
      await run([
        'session',
        'start',
        '--name',
        SESSION_NAME,
        '--cursor',
        '--multi-agent',
        '--no-trace',
      ]),
    );
    const leader = { id, agentId: DESKTOP_CONTROL_LEADER_AGENT_ID };
    try {
      await run(
        ['cursor-overlay', 'enable', '--label', LEADER_LABEL, '--accent', LEADER_ACCENT, ...LINGER],
        leader,
      );
    } catch (error) {
      await run(['session', 'end', id]).catch(() => undefined);
      throw error;
    }
    entry.id = id;
    return leader;
  })();
  sessions.set(taskId, entry);
  entry.ready.catch(() => {
    if (sessions.get(taskId) === entry) sessions.delete(taskId);
  });
  return entry;
}

/**
 * Marks a Worker the Leader hired for desktop control, with the next accent of the Task, or says
 * why it is not marked: the Task already has as many desktop Workers as it may hold at once. Kept
 * in memory only: after a restart no Worker is marked, which only takes the tool away. Marking the
 * same Worker again keeps its first mark.
 *
 * Given the Team's Workers that are still at work (`live`), the marks of every other Worker (one
 * that finished, failed, was stopped, or whose Team ended) are dropped first, so the bound counts
 * Workers at once rather than ever, and a freed accent goes to the next Worker. Without it, no mark
 * is dropped, which only refuses more.
 */
export function markDesktopControlWorker(
  taskId: string,
  workerId: string,
  role: string,
  live?: ReadonlySet<string>,
): { worker: DesktopControlWorker } | { refusal: string } {
  // A run that names no Worker carries the empty id, so the empty id never holds a mark.
  if (workerId === '')
    return { refusal: 'Worker を特定できないので、デスクトップ操作の道具を渡しません。' };
  const workers = desktopWorkers.get(taskId) ?? new Map<string, DesktopControlWorker>();
  if (live !== undefined)
    for (const id of [...workers.keys()]) if (id !== workerId && !live.has(id)) workers.delete(id);
  const known = workers.get(workerId);
  if (known !== undefined) return { worker: known };
  if (workers.size >= DESKTOP_CONTROL_WORKERS)
    return {
      refusal: `デスクトップ操作を任せられる Worker は、同時に ${DESKTOP_CONTROL_WORKERS} 人までです。この Worker にはデスクトップ操作の道具を渡しません。`,
    };
  // The first accent no Worker at work holds.
  const held = new Set([...workers.values()].map(({ colorIndex }) => colorIndex));
  let colorIndex = 0;
  while (held.has(colorIndex)) colorIndex += 1;
  const worker: DesktopControlWorker = Object.freeze({
    workerId,
    agentId: desktopControlAgentId(workerId),
    label: desktopControlWorkerLabel(role, colorIndex),
    colorIndex,
  });
  workers.set(workerId, worker);
  desktopWorkers.set(taskId, workers);
  return { worker };
}

/** The Worker's desktop-control mark, when the Leader gave it one and the opt-in is on. */
export function desktopControlWorker(
  taskId: string,
  workerId: string,
): DesktopControlWorker | undefined {
  return teamCursors && workerId !== '' ? desktopWorkers.get(taskId)?.get(workerId) : undefined;
}

/**
 * The agent id a Worker's runs carry: its Team id when the executable accepts that form (1 to 64
 * letters, digits, `-` or `_`) and it is not the Leader's, or else a stable digest of it.
 */
export function desktopControlAgentId(workerId: string): string {
  return SESSION_ID.test(workerId) && workerId !== DESKTOP_CONTROL_LEADER_AGENT_ID
    ? workerId
    : `w-${createHash('sha256').update(workerId).digest('hex').slice(0, 24)}`;
}

/** The cursor's label: the role without control or invisible characters, cut short. */
export function desktopControlWorkerLabel(role: string, colorIndex: number): string {
  const characters = Array.from(
    role
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
  );
  if (characters.length === 0) return `Worker ${colorIndex + 1}`;
  return characters.length > LABEL_MAX
    ? `${characters.slice(0, LABEL_MAX - 1).join('')}…`
    : characters.join('');
}

/**
 * Where the parts a desktop-control run of this Task names are read from, for its approval card
 * and the app-wide Task grant: `{}` for the default folder (team cursors off, or a run that only
 * prints, which never runs in the session), the folder of Main's own session of this Task, or
 * `null` when the run will run in a session whose snapshots cannot be read yet, so no part is named
 * and no grant covers it.
 */
export function desktopControlSessionReadScope(
  taskId: string,
  argv: readonly string[],
): Readonly<{ stateRoot?: string }> | null {
  if (!teamCursors || desktopControlArgvIsInert(argv)) return {};
  const id = sessions.get(taskId)?.id ?? null;
  if (id === null || !SESSION_ID.test(id)) return null;
  return { stateRoot: join(desktopControlStateFolder(), 'sessions', id) };
}

/**
 * Ends the Task's session, if it has one, and forgets which of its Workers were marked for desktop
 * control (when the Task is archived), so no mark outlives the Task's session.
 */
export async function endDesktopControlSession(taskId: string): Promise<void> {
  desktopWorkers.delete(taskId);
  const entry = sessions.get(taskId);
  if (entry === undefined) return;
  sessions.delete(taskId);
  await endSession(entry);
}

/** Ends every Task's session, waiting a few seconds at most (when Sprint Coder quits). */
export async function endDesktopControlSessions(): Promise<void> {
  const entries = [...sessions.values()];
  sessions.clear();
  if (entries.length === 0) return;
  await Promise.race([
    Promise.allSettled(entries.map((entry) => endSession(entry))),
    new Promise((resolve) => setTimeout(resolve, END_ALL_TIMEOUT_MS).unref()),
  ]);
}

async function endSession(entry: TaskSession): Promise<void> {
  try {
    const { id } = await entry.ready;
    await entry.run(['session', 'end', id]);
  } catch (error) {
    secureLogger.warn('Desktop control session did not end cleanly', { error: errorText(error) });
  }
}

/** The session id `session start` printed, or a thrown error when its output is not that. */
function sessionIdOf(stdout: string): string {
  const output = JSON.parse(stdout) as { ok?: unknown; data?: { session_id?: unknown } | null };
  const id = output.ok === true ? output.data?.session_id : undefined;
  if (typeof id !== 'string' || !SESSION_ID.test(id))
    throw new Error('Desktop control session start printed no session id');
  return id;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** For tests: forgets every session and the opt-in. */
export function resetDesktopControlSessions(): void {
  teamCursors = false;
  collected = null;
  sessions.clear();
  desktopWorkers.clear();
}
