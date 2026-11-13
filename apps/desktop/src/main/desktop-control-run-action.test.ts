import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createExecutionSpec } from '@sprint-coder/domain';
import { desktopControlRunAction } from './default-tools';
import type * as DesktopControl from './desktop-control';
import type * as DesktopControlSession from './desktop-control-session';
import { SqlitePersistenceClient } from './persistence';

// Where the parts are read from, as Main's session of the Task would give it, and the recorded
// command taken as the shipped binary's (the timeline describes no other).
const scope = vi.hoisted(() => ({ value: {} as Readonly<{ stateRoot?: string }> | null }));
vi.mock('./desktop-control-session', async (original) => ({
  ...(await original<typeof DesktopControlSession>()),
  desktopControlSessionReadScope: () => scope.value,
}));
vi.mock('./desktop-control', async (original) => ({
  ...(await original<typeof DesktopControl>()),
  isShippedDesktopControlPath: () => true,
}));

let directory: string;
let stateRoot: string;

beforeAll(() => {
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'sc-dc-run-action-')));
  stateRoot = join(directory, 'state');
  const folder = join(stateRoot, 'snapshots', 's1abc');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'refmap.json'),
    JSON.stringify({
      inner: {
        '@e7': {
          role: 'button',
          name: 'L-1',
          source_app: 'pkgaapp.exe',
          source_window_id: 'w-30084868',
          source_window_title: 'pkgA',
        },
      },
      counter: 1,
    }),
  );
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

function startExecutingTurn(persistence: SqlitePersistenceClient, taskId: string) {
  const started = persistence.startTurn(taskId, 'desktop run');
  persistence.changeStage(taskId, started.turnId, 'understanding');
  persistence.changeStage(taskId, started.turnId, 'planning');
  persistence.changeStage(taskId, started.turnId, 'executing');
  return started;
}

function prepareClick(persistence: SqlitePersistenceClient, id: string, argv: readonly string[]) {
  const task = persistence.createTask();
  const turn = startExecutingTurn(persistence, task.id);
  persistence.prepareCommand({
    id,
    taskId: task.id,
    turnId: turn.turnId,
    callId: `call-${id}`,
    spec: createExecutionSpec({
      absoluteExecutable: process.execPath,
      executionIdentityDigest: 'c'.repeat(64),
      argv: [...argv],
      cwdIdentity: { canonicalPath: process.cwd(), identityDigest: 'a'.repeat(64) },
      envDelta: {},
      stdinMode: 'closed',
      shell: 'none',
    }),
    purpose: 'クリックします',
    risk: 'high',
    createdAt: new Date().toISOString(),
  });
  return task.id;
}

describe('the timeline row of a desktop-control run allowed without a card', () => {
  it('names the part as its card would, read as the run starts', () => {
    scope.value = { stateRoot };
    const action = desktopControlRunAction('task-1', ['click', '@s1abc:e7']);
    expect(action?.target).toMatchObject({ resolved: true, app: 'pkgaapp.exe', name: 'L-1' });
  });

  it('names nothing the records cannot place, and nothing for a run that only prints', () => {
    scope.value = { stateRoot };
    expect(desktopControlRunAction('task-1', ['click', '@s1zzz:e7'])?.target).toEqual({
      resolved: false,
      reference: '@s1zzz:e7',
    });
    // A session whose snapshots cannot be read yet names no part.
    scope.value = null;
    expect(desktopControlRunAction('task-1', ['click', '@s1abc:e7'])?.target).toEqual({
      resolved: false,
      reference: '@s1abc:e7',
    });
    scope.value = { stateRoot };
    expect(desktopControlRunAction('task-1', ['skills', 'get', 'desktop'])).toBeUndefined();
  });

  it('keeps the names recorded as the run started, across a restart', () => {
    scope.value = { stateRoot };
    const path = join(directory, 'named.sqlite3');
    const persistence = new SqlitePersistenceClient(path);
    const argv = ['click', '@s1abc:e7'];
    prepareClick(persistence, 'named', argv);
    // Before it starts, the row reads no snapshot.
    expect(persistence.getCommand('named').desktopAction?.target).toEqual({
      resolved: false,
      reference: '@s1abc:e7',
    });
    const started = persistence.beginCommand('named', desktopControlRunAction('task-1', argv));
    expect(started.desktopAction?.target).toMatchObject({ resolved: true, name: 'L-1' });
    persistence.close();
    // The snapshot is gone; the row still names the part.
    rmSync(join(stateRoot, 'snapshots', 's1abc', 'refmap.json'), { force: true });
    const reopened = new SqlitePersistenceClient(path);
    expect(reopened.getCommand('named').desktopAction?.target).toMatchObject({
      resolved: true,
      name: 'L-1',
    });
    reopened.close();
  });

  it('describes a run that brought no names, or names in no known shape, as before', () => {
    const persistence = new SqlitePersistenceClient(join(directory, 'plain.sqlite3'));
    prepareClick(persistence, 'plain', ['click', '@s1abc:e7']);
    expect(persistence.beginCommand('plain').desktopAction?.target).toEqual({
      resolved: false,
      reference: '@s1abc:e7',
    });
    prepareClick(persistence, 'made-up', ['click', '@s1abc:e7']);
    expect(
      persistence.beginCommand('made-up', { kind: 'made-up' } as never).desktopAction?.target,
    ).toEqual({ resolved: false, reference: '@s1abc:e7' });
    persistence.close();
  });
});
