import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  DESKTOP_CONTROL_LABEL_MAX,
  DESKTOP_CONTROL_LEADER_ACCENT,
  DESKTOP_CONTROL_LEADER_LABEL,
  DESKTOP_CONTROL_WORKER_ACCENTS,
  desktopControlWorkerAccent,
} from '@sprint-coder/contracts';
import {
  desktopControlArgvIsInert,
  desktopControlStateFolder,
  type DesktopControlSessionVariables,
} from './desktop-control';
import {
  DESKTOP_CONTROL_TEAM_CURSORS_VARIABLE,
  desktopControlTeamCursorsEnabled,
} from './desktop-control-build';
import { endDesktopControlQueue, endDesktopControlQueues } from './desktop-control-queue';
import { secureLogger } from './secure-logger';

/**
 * The multi-agent session Main keeps for each Task, so that every agent working on the Task draws
 * its own cursor (`session start --cursor --multi-agent`). On by default where desktop control is
 * built; off when Main started with `SPRINT_CODER_DESKTOP_TEAM_CURSORS=0`
 * (`DESKTOP_CONTROL_TEAM_CURSORS_AT_START`, given once to `configureDesktopControlTeamCursors`).
 * Off, nothing here runs and every desktop-control run is exactly as before the cursors existed.
 *
 * On, Main starts the Task's session itself before the Task's first desktop-control run that is
 * not inert, and every such run of the Task then runs in it: Main sets the session and the agent
 * id as variables (`desktopControlEnvironment`), and the agent may not choose either
 * (`desktopControlSessionArgvRefusal`). The Leader runs as agent `leader`; a Team Worker the
 * Leader marked for desktop control (`markDesktopControlWorker`) runs as its own agent, with its
 * role and an accent of its own on its cursor. The session ends when the Task is archived (after
 * the Task's desktop-control runs are stopped, and the Task's marks are forgotten) and when Sprint
 * Coder quits; the cursors'
 * renderer also ends by itself when Main exits.
 *
 * A session keeps its snapshots below its own folder, so the approval card and the app-wide Task
 * grant read the parts a ref names from there, and only for Main's own session of that Task
 * (`desktopControlSessionReadScope`).
 */

/** The agent id of the Leader in the Task's session. */
export const DESKTOP_CONTROL_LEADER_AGENT_ID = 'leader';
const LEADER_LABEL = DESKTOP_CONTROL_LEADER_LABEL;
const LEADER_ACCENT = DESKTOP_CONTROL_LEADER_ACCENT;
const SESSION_NAME = 'sprint-coder';
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/u;
/**
 * How long each cursor of the Task stays drawn after its agent's last action before it fades
 * (`--linger-ms`; the executable's own is about 6 seconds). An agent's actions are often several
 * seconds apart, so with the executable's own, the Team's cursors were rarely on screen together.
 * Finite, because a cursor is drawn above every window, the user's own included, whether or not
 * the window it acted on is still in view. A finished Worker's cursor goes away at once
 * (`retireDesktopControlWorkerCursor`), or by the same time if that could not run.
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
 * The Worker cursors' accents, in the order the Team's desktop Workers were marked, from the
 * shared contracts, so the approval card and the Team view mark each Worker with its cursor's color.
 */
export { DESKTOP_CONTROL_WORKER_ACCENTS };
/** How many Workers of one Task may hold desktop control at once (at most `..._MAX`). */
export const DESKTOP_CONTROL_WORKERS_DEFAULT = 3;
export const DESKTOP_CONTROL_WORKERS_MAX = 5;
const DESKTOP_CONTROL_WORKERS = Math.min(
  DESKTOP_CONTROL_WORKERS_DEFAULT,
  DESKTOP_CONTROL_WORKERS_MAX,
);
const LABEL_MAX = DESKTOP_CONTROL_LABEL_MAX;

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
 * Whether this Main process started with the Team's cursors on: on by default where desktop
 * control is built, off with `SPRINT_CODER_DESKTOP_TEAM_CURSORS=0`
 * (`desktopControlTeamCursorsEnabled`). Main turns the feature on from it once
 * (`configureDesktopControlTeamCursors`), and the Leader's hire tool offers the desktop mark only
 * when it is on, so with `0` the tool is exactly as it was before the mark existed.
 */
export const DESKTOP_CONTROL_TEAM_CURSORS_AT_START = desktopControlTeamCursorsEnabled(
  process.env[DESKTOP_CONTROL_TEAM_CURSORS_VARIABLE],
  process.platform,
  process.arch,
);

let teamCursors = false;
let workerToolOffered: () => boolean = () => false;
let collected: Promise<void> | null = null;
const sessions = new Map<string, TaskSession>();
const desktopWorkers = new Map<string, Map<string, DesktopControlWorker>>();

/**
 * Given once, when Main starts (`DESKTOP_CONTROL_TEAM_CURSORS_AT_START`); off until then, and
 * `false` keeps every run as it was before the Team's cursors existed.
 */
export function configureDesktopControlTeamCursors(enabled: boolean): void {
  teamCursors = enabled;
}

export function desktopControlTeamCursors(): boolean {
  return teamCursors;
}

/**
 * Given once by Main: whether a marked Worker's Turn can be given the command tool at all, as the
 * managed harness itself decides it (`ManagedCodingHarness.commandToolsOffered`: not without the
 * command sandbox). The Leader's hire marks no Worker while it says no, so a Worker is never told
 * to use a tool it does not have. Until Main gives it, no Worker can be given the tool.
 */
export function configureDesktopControlWorkerTool(offered: () => boolean): void {
  workerToolOffered = offered;
}

export function desktopControlWorkerToolOffered(): boolean {
  return workerToolOffered();
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
        desktopControlWorkerAccent(worker.colorIndex),
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

/**
 * Takes down the cursor of a Worker that is no longer at work (it finished, failed or was
 * stopped), at once, rather than leaving it drawn for up to `DESKTOP_CONTROL_CURSOR_LINGER_MS`
 * after its last action, where a Worker marked next with the freed accent could be seen beside a
 * cursor of the same color. Run by Main itself (`cursor-overlay retire`, as the Worker's agent in
 * the Task's session), which ends that one Worker's renderer and no other agent's.
 *
 * Only for a Worker the Leader marked whose cursor was styled in the Task's session: one that never
 * drew a cursor has none to take down, and nothing runs. Called again for the same Worker, nothing
 * runs again, until the Worker draws its cursor once more (its next run styles it again). Best
 * effort: never throws, and a run that fails is only logged, so the Worker's end goes on.
 */
export async function retireDesktopControlWorkerCursor(
  taskId: string,
  workerId: string,
): Promise<void> {
  if (!teamCursors || workerId === '') return;
  const worker = desktopWorkers.get(taskId)?.get(workerId);
  if (worker === undefined) return;
  const entry = sessions.get(taskId);
  const styled = entry?.styled.get(worker.agentId);
  if (entry === undefined || entry.id === null || styled === undefined) return;
  // Forgotten first, so a second call for the same end runs nothing.
  entry.styled.delete(worker.agentId);
  try {
    await styled;
    await entry.run(['cursor-overlay', 'retire'], { id: entry.id, agentId: worker.agentId });
  } catch (error) {
    secureLogger.warn('Desktop control could not take down a finished Worker cursor', {
      error: errorText(error),
    });
  }
}

/** The Worker's desktop-control mark, when the Leader gave it one and the Team's cursors are on. */
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
 *
 * Given `stopRuns` (the Task's archive stops the Task's desktop-control runs, those gone on in the
 * background included), the runs still waiting are refused first, so none of them starts in the
 * turn a stopped run frees; then the running ones are stopped, and the session is ended only once
 * their processes have ended, so no run of it is still acting, or still drawing its cursor, when
 * the session's cursors are taken down. It is called whether or not the Task has a session (team
 * cursors off, a run of the Task is still a desktop-control run), and a run that could not be
 * confirmed stopped does not keep the session from ending.
 */
export async function endDesktopControlSession(
  taskId: string,
  stopRuns?: () => Promise<void>,
): Promise<void> {
  // The runs still waiting for their turn in it do not start (`desktop-control-queue.ts`).
  endDesktopControlQueue(taskId);
  desktopWorkers.delete(taskId);
  const entry = sessions.get(taskId);
  // A run of the Task from now on starts a new session, never this one.
  if (entry !== undefined) sessions.delete(taskId);
  if (stopRuns !== undefined)
    try {
      await stopRuns();
    } catch (error) {
      secureLogger.warn('Desktop control runs of the Task were not confirmed stopped', {
        error: errorText(error),
      });
    }
  if (entry !== undefined) await endSession(entry);
}

/** Ends every Task's session, waiting a few seconds at most (when Sprint Coder quits). */
export async function endDesktopControlSessions(): Promise<void> {
  endDesktopControlQueues();
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

/** For tests: forgets every session, and turns the Team's cursors off until configured again. */
export function resetDesktopControlSessions(): void {
  teamCursors = false;
  workerToolOffered = () => false;
  collected = null;
  sessions.clear();
  desktopWorkers.clear();
  endDesktopControlQueues();
}
