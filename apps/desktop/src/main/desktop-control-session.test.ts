import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_CONTROL_LEADER_ACCENT,
  DESKTOP_CONTROL_LEADER_LABEL,
  DESKTOP_CONTROL_WORKER_ACCENTS as SHARED_WORKER_ACCENTS,
  desktopControlMarkSchema,
  desktopControlWorkerAccent,
} from '@sprint-coder/contracts';
import {
  DESKTOP_CONTROL_AGENT_ID_VARIABLE,
  DESKTOP_CONTROL_SESSION_VARIABLE,
  desktopControlArgvRefusal,
  desktopControlEnvironment,
  desktopControlMainOnlyOptionRefusal,
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
  desktopControlWorkerToolOffer,
  endDesktopControlSession,
  endDesktopControlSessions,
  ensureDesktopControlSession,
  markDesktopControlWorker,
  resetDesktopControlSessions,
  retireDesktopControlWorkerCursor,
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
      // A batch entry's own session, which the executable reads per entry.
      ['batch', JSON.stringify([{ command: 'click', session: 'x', args: { ref_id: '@s1:e1' } }])],
      [
        'batch',
        JSON.stringify([
          { command: 'snapshot', args: {} },
          { command: 'click', session: 'x', args: { ref_id: '@s1:e1' } },
        ]),
      ],
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
      ['batch', JSON.stringify([{ command: 'click', args: { ref_id: '@s1:e1' } }])],
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

  it('keeps how long the cursors stay drawn Main’s alone, whether the Team’s cursors are on or off', () => {
    const lookup = { platform: 'win32' as const, realpath: (path: string) => path };
    for (const argv of [
      ['cursor-overlay', 'enable', '--label', 'X', '--linger-ms', '30000'],
      ['cursor-overlay', 'enable', '--linger-ms=120000'],
    ]) {
      expect(desktopControlMainOnlyOptionRefusal(argv)).toBe(
        'デスクトップ操作の実行を拒否した: --linger-ms は付けない。',
      );
      // Main's own run of the same argv is judged on the table alone, which accepts it.
      expect(desktopControlArgvRefusal(argv, [], lookup)).toBeNull();
    }
    for (const argv of [
      ['cursor-overlay', 'enable', '--label', 'X', '--dwell-ms', '50'],
      ['click', '@s1:e1'],
      ['type', '@s1:e1', '--', '--linger-ms'],
    ])
      expect(desktopControlMainOnlyOptionRefusal(argv)).toBeNull();
  });
});

describe('the Task’s desktop-control session', () => {
  it('is off until Main turns it on, and off (`=0`) never runs anything', async () => {
    const { run } = ownRuns();
    expect(desktopControlTeamCursors()).toBe(false);
    configureDesktopControlTeamCursors(false);
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
        argv: [
          'cursor-overlay',
          'enable',
          '--label',
          'Leader',
          '--accent',
          '#2563EB',
          '--linger-ms',
          '30000',
        ],
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

  it('ends an archived Task’s session only after its runs were stopped, with or without a session', async () => {
    configureDesktopControlTeamCursors(true);
    const { run } = ownRuns('run-a');
    await ensureDesktopControlSession('task-1', run);
    const order: string[] = [];
    run.mockImplementation(async (argv) => {
      order.push(argv.join(' '));
      return '{"ok":true}';
    });
    let stopped = (): void => undefined;
    const ending = endDesktopControlSession(
      'task-1',
      () =>
        new Promise<void>((resolve) => {
          order.push('stopping');
          // The Task's session is no longer the one its runs read from.
          expect(desktopControlSessionReadScope('task-1', ['click', '@s1:e1'])).toBeNull();
          stopped = () => {
            order.push('stopped');
            resolve();
          };
        }),
    );
    await Promise.resolve();
    expect(order).toEqual(['stopping']);
    stopped();
    await ending;
    expect(order).toEqual(['stopping', 'stopped', 'session end run-a']);
    // A stop that could not be confirmed does not keep the session from ending.
    const second = ownRuns('run-b');
    await ensureDesktopControlSession('task-1', second.run);
    await endDesktopControlSession('task-1', () => Promise.reject(new Error('unconfirmed')));
    expect(second.run).toHaveBeenLastCalledWith(['session', 'end', 'run-b']);
    // Without a session (team cursors off), the runs are still stopped.
    configureDesktopControlTeamCursors(false);
    const stop = vi.fn(() => Promise.resolve());
    await endDesktopControlSession('task-3', stop);
    expect(stop).toHaveBeenCalledOnce();
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
    // Read only with the cursors on.
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

  it('never makes a label the Team’s contract refuses, whatever the role holds', () => {
    // A role of characters outside the basic plane is twice as long in UTF-16 units as in
    // characters; the contract counts units, the label counts characters.
    for (const role of ['😀'.repeat(21), '😀'.repeat(24), '😀'.repeat(100), '係'.repeat(100), ' '])
      expect(() =>
        desktopControlMarkSchema.parse({
          label: desktopControlWorkerLabel(role, 0),
          colorIndex: 0,
        }),
      ).not.toThrow();
    expect(Array.from(desktopControlWorkerLabel('😀'.repeat(100), 0))).toHaveLength(24);
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
      'cursor-overlay enable --label Leader --accent #2563EB --linger-ms 30000',
      'cursor-overlay enable --label Checker --accent #EA580C --linger-ms 30000',
    ]);
    expect(calls[3]!.session).toEqual({ id, agentId: 'agent-b' });
    // The cursors are drawn with the palette the Renderer marks the same agents with.
    expect(DESKTOP_CONTROL_WORKER_ACCENTS).toBe(SHARED_WORKER_ACCENTS);
    expect(calls[2]!.argv).toContain(DESKTOP_CONTROL_LEADER_ACCENT);
    expect(calls[2]!.argv).toContain(DESKTOP_CONTROL_LEADER_LABEL);
    expect(calls[3]!.argv).toContain(desktopControlWorkerAccent(worker.colorIndex));
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

describe('a Worker marked again, and the marks of an archived Task', () => {
  it('keeps the first mark of a Worker marked again, and styles its cursor only once, as first named', async () => {
    configureDesktopControlTeamCursors(true);
    const first = markDesktopControlWorker('task-1', 'agent-a', '画面の確認係');
    const { run, calls, id } = ownRuns();
    const worker = desktopControlWorker('task-1', 'agent-a')!;
    await expect(ensureDesktopControlSession('task-1', run, worker)).resolves.toEqual({
      id,
      agentId: 'agent-a',
    });
    // Marked again with another role, while at work and while not known to be: the same mark, the
    // same label and accent, and no second place in the bound.
    expect(markDesktopControlWorker('task-1', 'agent-a', 'renamed')).toEqual(first);
    expect(markDesktopControlWorker('task-1', 'agent-a', 'renamed', new Set(['agent-a']))).toEqual(
      first,
    );
    expect(desktopControlWorker('task-1', 'agent-a')).toBe(worker);
    await ensureDesktopControlSession('task-1', run, desktopControlWorker('task-1', 'agent-a'));
    expect(
      calls.filter(({ argv }) => argv[0] === 'cursor-overlay').map(({ argv }) => argv.join(' ')),
    ).toEqual([
      'cursor-overlay enable --label Leader --accent #2563EB --linger-ms 30000',
      'cursor-overlay enable --label 画面の確認係 --accent #16A34A --linger-ms 30000',
    ]);
    for (const other of ['agent-b', 'agent-c'])
      expect(markDesktopControlWorker('task-1', other, other)).toHaveProperty('worker');
    expect(markDesktopControlWorker('task-1', 'agent-d', 'd')).toHaveProperty('refusal');
  });

  it('never marks the empty Worker id, which a run that names no Worker carries', () => {
    configureDesktopControlTeamCursors(true);
    expect(markDesktopControlWorker('task-1', '', 'nobody')).toHaveProperty('refusal');
    expect(desktopControlWorker('task-1', '')).toBeUndefined();
    // It took no place in the bound either.
    for (const id of ['agent-a', 'agent-b', 'agent-c'])
      expect(markDesktopControlWorker('task-1', id, id)).toHaveProperty('worker');
  });

  it('forgets every mark of a Task when the Task is archived, with or without its session', async () => {
    configureDesktopControlTeamCursors(true);
    for (const id of ['a', 'b', 'c']) markDesktopControlWorker('task-1', id, id);
    markDesktopControlWorker('task-2', 'a', 'a');
    markDesktopControlWorker('task-3', 'a', 'a');
    const { run } = ownRuns();
    await ensureDesktopControlSession('task-1', run, desktopControlWorker('task-1', 'a'));
    await endDesktopControlSession('task-1');
    expect(run).toHaveBeenLastCalledWith(['session', 'end', expect.any(String)]);
    for (const id of ['a', 'b', 'c']) expect(desktopControlWorker('task-1', id)).toBeUndefined();
    // A Task that never started a session loses its marks too.
    await endDesktopControlSession('task-2');
    expect(desktopControlWorker('task-2', 'a')).toBeUndefined();
    // Another Task keeps its own.
    expect(desktopControlWorker('task-3', 'a')).toMatchObject({ workerId: 'a', colorIndex: 0 });
    // The archived Task's places are free again, from the first accent.
    expect(markDesktopControlWorker('task-1', 'd', 'd')).toMatchObject({
      worker: { workerId: 'd', colorIndex: 0 },
    });
  });
});

describe('the desktop Workers of a Task at once', () => {
  it('drops the marks of Workers no longer at work, and gives the freed accent to the next', () => {
    for (const id of ['a', 'b', 'c']) markDesktopControlWorker('task-1', id, id);
    expect(markDesktopControlWorker('task-1', 'd', 'd', new Set(['a', 'b', 'c', 'd']))).toEqual({
      refusal: expect.stringContaining('同時に 3 人まで'),
    });
    expect(markDesktopControlWorker('task-1', 'd', 'd', new Set(['a', 'c', 'd']))).toMatchObject({
      worker: { workerId: 'd', colorIndex: 1 },
    });
    configureDesktopControlTeamCursors(true);
    expect(desktopControlWorker('task-1', 'b')).toBeUndefined();
    expect(desktopControlWorker('task-1', 'a')).toMatchObject({ colorIndex: 0 });
    // Without knowing who is at work, nothing is dropped (only refusing more).
    expect(markDesktopControlWorker('task-1', 'e', 'e')).toMatchObject({
      refusal: expect.any(String),
    });
  });
});

describe('the cursor of a Worker no longer at work', () => {
  const lookup = { platform: 'win32' as const, realpath: (path: string) => path };

  async function workerWithCursor() {
    configureDesktopControlTeamCursors(true);
    const runs = ownRuns();
    const marked = markDesktopControlWorker('task-1', 'agent-b', 'Checker');
    if (!('worker' in marked)) throw new Error('the Worker was not marked');
    const other = markDesktopControlWorker('task-1', 'agent-c', 'Typist');
    if (!('worker' in other)) throw new Error('the other Worker was not marked');
    await ensureDesktopControlSession('task-1', runs.run, marked.worker);
    await ensureDesktopControlSession('task-1', runs.run, other.worker);
    runs.calls.length = 0;
    runs.run.mockClear();
    return { ...runs, worker: marked.worker };
  }

  it('is taken down once, by Main, as that Worker in the Task’s session', async () => {
    const { run, calls, id } = await workerWithCursor();
    await retireDesktopControlWorkerCursor('task-1', 'agent-b');
    expect(calls).toEqual([
      { argv: ['cursor-overlay', 'retire'], session: { id, agentId: 'agent-b' } },
    ]);
    // The same end seen again runs nothing more.
    await retireDesktopControlWorkerCursor('task-1', 'agent-b');
    expect(run).toHaveBeenCalledOnce();
  });

  it('goes on when the run fails, and only logs it', async () => {
    const { run } = await workerWithCursor();
    run.mockImplementationOnce(async () => {
      throw new Error('retire failed');
    });
    await expect(retireDesktopControlWorkerCursor('task-1', 'agent-b')).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
  });

  it('runs nothing for a Worker without a mark, without a cursor, or with the cursors off', async () => {
    const { run } = await workerWithCursor();
    await retireDesktopControlWorkerCursor('task-1', 'never-marked');
    await retireDesktopControlWorkerCursor('task-2', 'agent-b');
    await retireDesktopControlWorkerCursor('task-1', '');
    // Marked, but it never drew its cursor in the session.
    markDesktopControlWorker('task-1', 'agent-d', 'Reader');
    await retireDesktopControlWorkerCursor('task-1', 'agent-d');
    configureDesktopControlTeamCursors(false);
    await retireDesktopControlWorkerCursor('task-1', 'agent-b');
    expect(run).not.toHaveBeenCalled();
  });

  it('is taken down again after the Worker draws its cursor once more', async () => {
    const { run, worker } = await workerWithCursor();
    await retireDesktopControlWorkerCursor('task-1', 'agent-b');
    await ensureDesktopControlSession('task-1', run, worker);
    await retireDesktopControlWorkerCursor('task-1', 'agent-b');
    expect(run.mock.calls.map(([argv]) => argv.join(' '))).toEqual([
      'cursor-overlay retire',
      `cursor-overlay enable --label Checker --accent ${desktopControlWorkerAccent(0)} --linger-ms 30000`,
      'cursor-overlay retire',
    ]);
  });

  it('is Main’s alone: refused to the agent, with or without the Team’s cursors, and allowed to Main', () => {
    for (const argv of [
      ['cursor-overlay', 'retire'],
      ['cursor-overlay', 'retire', '--agent-id', 'agent-c'],
      ['cursor-overlay', 'retire', '--help'],
    ])
      expect(desktopControlMainOnlyOptionRefusal(argv)).toBe(
        'デスクトップ操作の実行を拒否した: cursor-overlay retire は使えない（Sprint Coder だけが使う）。',
      );
    expect(desktopControlSessionArgvRefusal(['cursor-overlay', 'retire'])).not.toBeNull();
    // Main's own run is judged on the table alone, which accepts it.
    expect(desktopControlArgvRefusal(['cursor-overlay', 'retire'], [], lookup)).toBeNull();
    expect(desktopControlMainOnlyOptionRefusal(['cursor-overlay', 'disable'])).toBeNull();
  });
});

describe('whether a Worker can be given desktop control in this Main', () => {
  it('needs both the command tool and the shipped executable, read afresh each time', () => {
    let tool = true;
    let executable: string | null = 'C:\\app\\sprint-coder-desktop-control.exe';
    const offered = desktopControlWorkerToolOffer(
      () => tool,
      () => executable,
    );
    expect(offered()).toBe(true);
    // A development run that has not built the executable: no Worker is marked.
    executable = null;
    expect(offered()).toBe(false);
    executable = 'C:\\app\\sprint-coder-desktop-control.exe';
    expect(offered()).toBe(true);
    // Without the command sandbox, as before.
    tool = false;
    expect(offered()).toBe(false);
  });
});
