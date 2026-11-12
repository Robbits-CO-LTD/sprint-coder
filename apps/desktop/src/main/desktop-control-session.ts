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
 * (`desktopControlSessionArgvRefusal`). Only the Leader works on the desktop for now, as agent
 * `leader`. The session ends when the Task is archived and when Sprint Coder quits; the cursors'
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
};

let teamCursors = false;
let collected: Promise<void> | null = null;
const sessions = new Map<string, TaskSession>();

/** Read once, when Main starts; `false` keeps every run as it was. */
export function configureDesktopControlTeamCursors(enabled: boolean): void {
  teamCursors = enabled;
}

export function desktopControlTeamCursors(): boolean {
  return teamCursors;
}

/**
 * The Task's session, started (and the Leader's cursor styled) on the first call. A failure leaves
 * no session behind, so the next call tries again, and is thrown: the run that needed it does not
 * start outside the session.
 */
export function ensureDesktopControlSession(
  taskId: string,
  run: DesktopControlOwnRun,
): Promise<DesktopControlSessionVariables> {
  if (!teamCursors) return Promise.reject(new Error('Desktop control team cursors are off'));
  const existing = sessions.get(taskId);
  if (existing !== undefined) return existing.ready;
  const entry: TaskSession = { id: null, ready: Promise.resolve({ id: '', agentId: '' }), run };
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
        ['cursor-overlay', 'enable', '--label', LEADER_LABEL, '--accent', LEADER_ACCENT],
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
  return entry.ready;
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

/** Ends the Task's session, if it has one (when the Task is archived). */
export async function endDesktopControlSession(taskId: string): Promise<void> {
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
}
