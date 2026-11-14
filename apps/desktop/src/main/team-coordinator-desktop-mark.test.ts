import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamDetail } from '@sprint-coder/contracts';
import { SqlitePersistenceClient } from './persistence';
import { DeterministicTeamWorkerRuntime, TeamCoordinator } from './team-coordinator';
import {
  configureDesktopControlTeamCursors,
  ensureDesktopControlSession,
  markDesktopControlWorker,
  resetDesktopControlSessions,
  type DesktopControlOwnRun,
} from './desktop-control-session';

const cleanup: (() => void)[] = [];
afterEach(() => {
  resetDesktopControlSessions();
  for (const step of cleanup.splice(0).reverse()) step();
});

async function teamWithWorker() {
  const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-desktop-mark-'));
  const persistence = new SqlitePersistenceClient(join(directory, 'test.sqlite3'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanup.push(() => persistence.close());
  const task = persistence.createTask('Desktop Team');
  persistence.promoteTaskToTeam(task.id);
  const published: TeamDetail[] = [];
  const coordinator = new TeamCoordinator(
    persistence,
    new DeterministicTeamWorkerRuntime(),
    (_taskId, detail) => {
      if (detail !== null) published.push(detail);
    },
  );
  const worker = await coordinator.hireWorker({
    taskId: task.id,
    role: '画面の確認係',
    objective: '窓を確かめる',
    contextInheritancePolicy: 'none',
    writeCapable: false,
  });
  return { persistence, coordinator, published, taskId: task.id, workerId: worker.id };
}

const workerOf = (detail: TeamDetail | null | undefined, id: string) =>
  detail?.workers.find((worker) => worker.id === id);

describe('the Team detail’s desktop-control mark of a Worker', () => {
  it('carries only the cursor’s label and color, and publishes the Team when marked', async () => {
    const { coordinator, published, taskId, workerId } = await teamWithWorker();
    configureDesktopControlTeamCursors(true);
    markDesktopControlWorker(taskId, workerId, '画面の確認係');
    published.length = 0;
    coordinator.notifyDesktopControlMarked(taskId);
    expect(published).toHaveLength(1);
    expect(workerOf(published[0], workerId)?.desktopControl).toEqual({
      label: '画面の確認係',
      colorIndex: 0,
    });
    // Nothing Main alone holds (the agent id the runs carry, the session) reaches the Renderer.
    expect(Object.keys(workerOf(coordinator.get(taskId), workerId)!.desktopControl!)).toEqual([
      'label',
      'colorIndex',
    ]);
  });

  it('is absent, and nothing more is published, while the cursors are off', async () => {
    const { coordinator, published, taskId, workerId } = await teamWithWorker();
    configureDesktopControlTeamCursors(false);
    // A mark recorded with the cursors off (it is only read with them on) changes nothing.
    markDesktopControlWorker(taskId, workerId, '画面の確認係');
    published.length = 0;
    coordinator.notifyDesktopControlMarked(taskId);
    expect(published).toHaveLength(0);
    const worker = workerOf(coordinator.get(taskId), workerId)!;
    expect(worker).not.toHaveProperty('desktopControl');
  });

  it('is absent for a Worker no longer at work, whose color may go to the next one', async () => {
    const { coordinator, taskId, workerId } = await teamWithWorker();
    configureDesktopControlTeamCursors(true);
    markDesktopControlWorker(taskId, workerId, '画面の確認係');
    expect(workerOf(coordinator.get(taskId), workerId)).toHaveProperty('desktopControl');
    await coordinator.stopWorker(taskId, workerId);
    const stopped = workerOf(coordinator.get(taskId), workerId)!;
    expect(stopped.state).toBe('stopped');
    expect(stopped).not.toHaveProperty('desktopControl');
  });
});

describe('the cursor of a marked Worker that ends', () => {
  const started = JSON.stringify({ ok: true, data: { session_id: 'run-1' } });

  function ownRun() {
    return vi.fn<DesktopControlOwnRun>(async (argv) =>
      argv[0] === 'session' && argv[1] === 'start' ? started : '{"ok":true}',
    );
  }

  it('is taken down once, by Main, when the Worker stops', async () => {
    const { coordinator, taskId, workerId } = await teamWithWorker();
    configureDesktopControlTeamCursors(true);
    const marked = markDesktopControlWorker(taskId, workerId, '画面の確認係');
    if (!('worker' in marked)) throw new Error('the Worker was not marked');
    const run = ownRun();
    await ensureDesktopControlSession(taskId, run, marked.worker);
    run.mockClear();
    await coordinator.stopWorker(taskId, workerId);
    coordinator.get(taskId);
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    expect(run.mock.calls).toEqual([
      [['cursor-overlay', 'retire'], { id: 'run-1', agentId: marked.worker.agentId }],
    ]);
  });

  it('runs nothing for a Worker without a mark', async () => {
    const { coordinator, taskId, workerId } = await teamWithWorker();
    configureDesktopControlTeamCursors(true);
    const run = ownRun();
    await ensureDesktopControlSession(taskId, run);
    run.mockClear();
    await coordinator.stopWorker(taskId, workerId);
    coordinator.get(taskId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run).not.toHaveBeenCalled();
  });
});
