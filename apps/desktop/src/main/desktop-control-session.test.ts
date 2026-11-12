import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_CONTROL_AGENT_ID_VARIABLE,
  DESKTOP_CONTROL_SESSION_VARIABLE,
  desktopControlEnvironment,
  desktopControlScopeOptionRefusal,
  desktopControlSessionArgvRefusal,
  desktopControlStateFolder,
} from './desktop-control';
import {
  DESKTOP_CONTROL_WORKER_ACCENTS,
  configureDesktopControlTeamCursors,
  desktopControlAgentId,
  desktopControlSessionReadScope,
  desktopControlTeamCursors,
  desktopControlWorker,
  desktopControlWorkerLabel,
  endDesktopControlSession,
  endDesktopControlSessions,
  ensureDesktopControlSession,
  markDesktopControlWorker,
  resetDesktopControlSessions,
  type DesktopControlOwnRun,
  type DesktopControlWorker,
} from './desktop-control-session';

afterEach(() => resetDesktopControlSessions());

const started = (id: string) => JSON.stringify({ ok: true, data: { session_id: id } });

/** A stand-in for Main's own runs, recording each argv and the session it ran in. */
function ownRuns(id = 'run-1794492200868-61396-0') {
  const calls: { argv: readonly string[]; session?: unknown }[] = [];
  const run = vi.fn<DesktopControlOwnRun>(async (argv, session) => {
    calls.push(session === undefined ? { argv } : { argv, session });
    return argv[0] === 'session' && argv[1] === 'start' ? started(id) : '{"ok":true}';
  });
  return { run, calls, id };
}

describe('the variables of a run in Main’s session', () => {
  const lookup = { platform: 'win32' as const, realpath: (path: string) => path };
  const chosen = {
    AGENT_DESKTOP_SESSION: 'agent-chosen',
    agent_desktop_agent_id: 'w9',
    Agent_Desktop_Session: 'agent-chosen-2',
    agent_desktop_interaction_lease_handle: '1234',
    OTHER: 'kept',
  };

  it('sets the session and agent id from Main alone, dropping the ones the caller chose in any letter case', () => {
    expect(
      desktopControlEnvironment(chosen, [], lookup, undefined, undefined, {
        id: 'run-1',
        agentId: 'leader',
      }),
    ).toEqual({
      OTHER: 'kept',
      AGENT_DESKTOP_HOME: desktopControlStateFolder(),
      [DESKTOP_CONTROL_SESSION_VARIABLE]: 'run-1',
      [DESKTOP_CONTROL_AGENT_ID_VARIABLE]: 'leader',
    });
  });

  it('leaves them exactly as they were without a session of Main', () => {
    expect(desktopControlEnvironment(chosen, [], lookup)).toEqual({
      ...chosen,
      AGENT_DESKTOP_HOME: desktopControlStateFolder(),
    });
  });
});

describe('the arguments of a run Main places in its session', () => {
  it('refuses a session or agent id the agent chose, in every form the executable reads', () => {
    for (const argv of [
      ['--session', 'x', 'click', '@s1:e1'],
      ['click', '@s1:e1', '--session=x'],
      ['--agent-id', 'w1', 'snapshot', '-i'],
      ['snapshot', '--agent-id=w1', '--session', 'x'],
      ['batch', '[]', '--session', 'x'],
    ]) {
      expect(desktopControlScopeOptionRefusal(argv)).toContain('Sprint Coder が');
      expect(desktopControlSessionArgvRefusal(argv)).toContain('Sprint Coder が');
    }
    expect(desktopControlScopeOptionRefusal(['--session', 'x', 'list-windows'])).toBe(
      'デスクトップ操作の実行を拒否した: --session は付けない（Sprint Coder が、この Task の操作の記録とカーソルを自分で入れる）。',
    );
    // Text after `--` is text to type, not an option.
    for (const argv of [
      ['type', '@s1:e1', '--', '--session'],
      ['click', '@s1:e1'],
      ['snapshot', '-i'],
    ])
      expect(desktopControlSessionArgvRefusal(argv)).toBeNull();
  });

  it('refuses the agent’s own session and cursor management, and allows reading about them', () => {
    for (const argv of [
      ['session', 'start', '--cursor'],
      ['session', 'end'],
      ['session', 'end', 'run-1'],
      ['session', 'gc', '--ended'],
      ['cursor-overlay', 'enable', '--label', 'X'],
      ['cursor-overlay', 'disable'],
    ]) {
      expect(desktopControlSessionArgvRefusal(argv)).toContain('Sprint Coder が管理している');
      // Main's own runs of the same commands are judged only on their options.
      expect(desktopControlScopeOptionRefusal(argv)).toBeNull();
    }
    for (const argv of [
      ['session', 'list'],
      ['session', 'help'],
      ['cursor-overlay', 'help'],
      ['session', 'end', '--help'],
    ])
      expect(desktopControlSessionArgvRefusal(argv)).toBeNull();
  });
});

describe('the Task’s desktop-control session', () => {
  it('is off unless the opt-in was given, and then never runs anything', async () => {
    const { run } = ownRuns();
    expect(desktopControlTeamCursors()).toBe(false);
    await expect(ensureDesktopControlSession('task-1', run)).rejects.toThrow('off');
    expect(run).not.toHaveBeenCalled();
    expect(desktopControlSessionReadScope('task-1', ['click', '@s1:e1'])).toEqual({});
    await endDesktopControlSessions();
    expect(run).not.toHaveBeenCalled();
  });

  it('starts once per Task, styles the Leader’s cursor in it, and is shared by concurrent runs', async () => {
    configureDesktopControlTeamCursors(true);
    const { run, calls, id } = ownRuns();
    const [first, second] = await Promise.all([
      ensureDesktopControlSession('task-1', run),
      ensureDesktopControlSession('task-1', run),
    ]);
    expect(first).toEqual({ id, agentId: 'leader' });
    expect(second).toBe(first);
    expect(calls).toEqual([
      { argv: ['session', 'gc', '--ended'] },
      {
        argv: [
          'session',
          'start',
          '--name',
          'sprint-coder',
          '--cursor',
          '--multi-agent',
          '--no-trace',
        ],
      },
      {
        argv: ['cursor-overlay', 'enable', '--label', 'Leader', '--accent', '#2563EB'],
        session: { id, agentId: 'leader' },
      },
    ]);
    // Another Task gets its own session; ended sessions are reclaimed only once per start.
    const other = ownRuns('run-2');
    await expect(ensureDesktopControlSession('task-2', other.run)).resolves.toEqual({
      id: 'run-2',
      agentId: 'leader',
    });
    expect(other.calls.map(({ argv }) => argv[1])).toEqual(['start', 'enable']);
  });

  it('reads the parts a run names only from Main’s own session of that Task', async () => {
    configureDesktopControlTeamCursors(true);
    const { run, id } = ownRuns();
    // Before the session exists, a run that will run in it names no part and is never granted.
    expect(desktopControlSessionReadScope('task-1', ['click', '@s1:e1'])).toBeNull();
    const pending = ensureDesktopControlSession('task-1', run);
    expect(desktopControlSessionReadScope('task-1', ['click', '@s1:e1'])).toBeNull();
    await pending;
    expect(desktopControlSessionReadScope('task-1', ['click', '@s1:e1'])).toEqual({
      stateRoot: join(desktopControlStateFolder(), 'sessions', id),
    });
    expect(desktopControlSessionReadScope('task-2', ['click', '@s1:e1'])).toBeNull();
    // A run that only prints never runs in the session.
    expect(desktopControlSessionReadScope('task-2', ['skills', 'get', 'desktop'])).toEqual({});
  });

  it('leaves nothing behind when it cannot start, and tries again on the next run', async () => {
    configureDesktopControlTeamCursors(true);
    const failing = vi.fn<DesktopControlOwnRun>(async (argv) => {
      if (argv[1] === 'start') return '{"ok":false,"error":{"code":"INTERNAL"}}';
      return '{"ok":true}';
    });
    await expect(ensureDesktopControlSession('task-1', failing)).rejects.toThrow(
      'printed no session id',
    );
    expect(desktopControlSessionReadScope('task-1', ['click', '@s1:e1'])).toBeNull();
    // The Leader's cursor could not be styled: the session it started is ended again.
    const styling = vi.fn<DesktopControlOwnRun>(async (argv) => {
      if (argv[0] === 'cursor-overlay') throw new Error('enable failed');
      return argv[1] === 'start' ? started('run-3') : '{"ok":true}';
    });
    await expect(ensureDesktopControlSession('task-1', styling)).rejects.toThrow('enable failed');
    expect(styling).toHaveBeenLastCalledWith(['session', 'end', 'run-3']);
    const { run, id } = ownRuns();
    await expect(ensureDesktopControlSession('task-1', run)).resolves.toEqual({
      id,
      agentId: 'leader',
    });
  });

  it('ends a Task’s session when the Task is archived, and every session when Sprint Coder quits', async () => {
    configureDesktopControlTeamCursors(true);
    const one = ownRuns('run-a');
    const two = ownRuns('run-b');
    await ensureDesktopControlSession('task-1', one.run);
    await ensureDesktopControlSession('task-2', two.run);
    await endDesktopControlSession('task-1');
    expect(one.run).toHaveBeenLastCalledWith(['session', 'end', 'run-a']);
    expect(desktopControlSessionReadScope('task-1', ['click', '@s1:e1'])).toBeNull();
    await endDesktopControlSession('task-1');
    expect(one.run).toHaveBeenCalledTimes(4);
    await endDesktopControlSessions();
    expect(two.run).toHaveBeenLastCalledWith(['session', 'end', 'run-b']);
    expect(desktopControlSessionReadScope('task-2', ['click', '@s1:e1'])).toBeNull();
  });
});

describe('the Team Workers marked for desktop control', () => {
  it('names each with its role and the next accent, up to three at once, and keeps a first mark', () => {
    const one = markDesktopControlWorker('task-1', 'agent-a', '画面の確認係');
    const two = markDesktopControlWorker('task-1', 'agent-b', '  \u0007\u200b ');
    const three = markDesktopControlWorker('task-1', 'agent-c', 'x'.repeat(40));
    expect(one).toEqual({
      worker: { workerId: 'agent-a', agentId: 'agent-a', label: '画面の確認係', colorIndex: 0 },
    });
    expect(two).toMatchObject({ worker: { label: 'Worker 2', colorIndex: 1 } });
    expect(three).toMatchObject({ worker: { label: `${'x'.repeat(23)}…`, colorIndex: 2 } });
    expect(markDesktopControlWorker('task-1', 'agent-d', 'four')).toEqual({
      refusal: expect.stringContaining('同時に 3 人まで'),
    });
    expect(markDesktopControlWorker('task-1', 'agent-a', 'renamed')).toEqual(one);
    // Another Task counts its own.
    expect(markDesktopControlWorker('task-2', 'agent-d', 'four')).toMatchObject({
      worker: { colorIndex: 0 },
    });
    // Read only with the opt-in on.
    expect(desktopControlWorker('task-1', 'agent-a')).toBeUndefined();
    configureDesktopControlTeamCursors(true);
    expect(desktopControlWorker('task-1', 'agent-a')).toEqual((one as { worker: unknown }).worker);
    expect(desktopControlWorker('task-1', 'agent-d')).toBeUndefined();
    // No accent repeats the Leader's blue, and none repeats another.
    expect(new Set(DESKTOP_CONTROL_WORKER_ACCENTS).size).toBe(8);
    expect(DESKTOP_CONTROL_WORKER_ACCENTS).not.toContain('#2563EB');
  });

  it('gives runs an agent id the executable accepts, never the Leader’s', () => {
    expect(desktopControlAgentId('0f3c-agent_1')).toBe('0f3c-agent_1');
    for (const id of ['leader', 'a b', 'x'.repeat(65), 'ä', ''])
      expect(desktopControlAgentId(id)).toMatch(/^w-[a-f0-9]{24}$/u);
    expect(desktopControlAgentId('a b')).toBe(desktopControlAgentId('a b'));
    expect(desktopControlWorkerLabel('a\nb\tc', 0)).toBe('a b c');
  });

  it('styles a Worker’s cursor once per session, as that Worker', async () => {
    configureDesktopControlTeamCursors(true);
    const { run, calls, id } = ownRuns();
    const worker: DesktopControlWorker = {
      workerId: 'agent-b',
      agentId: 'agent-b',
      label: 'Checker',
      colorIndex: 1,
    };
    await expect(ensureDesktopControlSession('task-1', run, worker)).resolves.toEqual({
      id,
      agentId: 'agent-b',
    });
    await ensureDesktopControlSession('task-1', run, worker);
    await expect(ensureDesktopControlSession('task-1', run)).resolves.toEqual({
      id,
      agentId: 'leader',
    });
    expect(calls.map(({ argv }) => argv.join(' '))).toEqual([
      'session gc --ended',
      'session start --name sprint-coder --cursor --multi-agent --no-trace',
      'cursor-overlay enable --label Leader --accent #2563EB',
      'cursor-overlay enable --label Checker --accent #EA580C',
    ]);
    expect(calls[3]!.session).toEqual({ id, agentId: 'agent-b' });
    // A styling that failed is tried again on the next run, and that run does not start.
    const failing = vi.fn<DesktopControlOwnRun>(async () => {
      throw new Error('enable failed');
    });
    const other = { ...worker, workerId: 'agent-c', agentId: 'agent-c', colorIndex: 2 };
    await expect(ensureDesktopControlSession('task-1', failing, other)).rejects.toThrow(
      'enable failed',
    );
    expect(failing).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledTimes(4);
    run.mockImplementationOnce(async () => {
      throw new Error('enable failed');
    });
    await expect(ensureDesktopControlSession('task-1', run, other)).rejects.toThrow();
    await ensureDesktopControlSession('task-1', run, other);
    expect(run).toHaveBeenCalledTimes(6);
  });
});
