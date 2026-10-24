import { afterEach, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveWorkspaceSet } from '@sprint-coder/contracts';
import type { RuntimeCanonicalEvent } from '../runtime-host/protocol';
import { IpcRouter } from './ipc';
import { TurnStreamingResources } from './turn-streaming-resources';
import { watchWorkspace } from './workspace-watcher';
import { readWorkspaceTextFile } from './workspace-file';
import type * as WorkspaceWatcherModule from './workspace-watcher';
import type * as WorkspaceFileModule from './workspace-file';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  clipboard: {},
  dialog: {},
  ipcMain: {},
  MessageChannelMain: class {},
  BrowserWindow: class {},
  nativeImage: {},
  shell: {},
  utilityProcess: {},
  session: {},
  safeStorage: {},
  screen: {},
  globalShortcut: {},
}));
vi.mock('./workspace-watcher', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspaceWatcherModule>()),
  watchWorkspace: vi.fn(),
}));
vi.mock('./workspace-file', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspaceFileModule>()),
  readWorkspaceTextFile: vi.fn(() => 'current preview'),
}));

type Router = {
  pushReasoning(taskId: string, turnId: string, text: string): void;
  startWorkspaceWatch(taskId: string, turnId: string, workspace: EffectiveWorkspaceSet): void;
  handleRuntimeEvent(
    kind: 'codex',
    taskId: string,
    turnId: string,
    event: RuntimeCanonicalEvent,
  ): void;
};

const resourcesToDispose: TurnStreamingResources[] = [];
function fixture() {
  const emit = vi.fn();
  const resources = new TurnStreamingResources(emit);
  resourcesToDispose.push(resources);
  const router = Object.create(IpcRouter.prototype) as Router;
  const pushFileEdit = vi.fn();
  Object.assign(router, {
    turnStreamingResources: resources,
    mailbox: { run: (_task: string, action: () => unknown) => Promise.resolve(action()) },
    canceledRuntimeTurns: new Set(),
    turnRuntimes: new Map([['turn', 'codex']]),
    pushFileEdit,
  });
  return { resources, router, emit, pushFileEdit };
}

afterEach(() => {
  for (const resources of resourcesToDispose.splice(0)) resources.dispose();
  vi.clearAllMocks();
  vi.useRealTimers();
});

it('uses get-only reasoning for the Mock sink and late CLI events even while runtime ownership remains', async () => {
  vi.useFakeTimers();
  const { resources, router, emit } = fixture();
  // MockRuntimeAdapter's reasoning callback delegates directly to this same router method.
  const mockSink = (text: string) => router.pushReasoning('task', 'turn', text);
  mockSink('not started\n');
  expect(resources.size).toBe(0);
  resources.begin('task', 'turn');
  mockSink('safe before close\n');
  resources.release('turn');
  mockSink('late Mock input\n');
  router.handleRuntimeEvent('codex', 'task', 'turn', {
    type: 'reasoning',
    text: 'late CLI input\n',
  });
  await Promise.resolve();
  expect(emit).toHaveBeenCalledExactlyOnceWith('task', 'turn', {
    text: 'safe before close\n',
    truncated: false,
  });
  expect(resources.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('checks captured watcher-group validity before reading files after replace, release or dispose', () => {
  const { resources, router, pushFileEdit } = fixture();
  const callbacks: Array<(path: string) => void> = [];
  const stops: ReturnType<typeof vi.fn>[] = [];
  vi.mocked(watchWorkspace).mockImplementation((_path, callback) => {
    callbacks.push(callback);
    const stop = vi.fn();
    stops.push(stop);
    return { stop };
  });
  const workspace: EffectiveWorkspaceSet = {
    source: 'task',
    projectId: null,
    primaryRootId: 'root',
    digest: 'workspace',
    roots: [
      {
        rootId: 'root',
        role: 'primary',
        label: 'root',
        status: 'available',
        path: join(tmpdir(), 'stream-preview'),
      },
    ],
  };
  router.startWorkspaceWatch('task', 'turn', workspace);
  expect(watchWorkspace).not.toHaveBeenCalled();
  resources.begin('task', 'turn');
  router.startWorkspaceWatch('task', 'turn', workspace);
  callbacks[0]!('file.txt');
  expect(readWorkspaceTextFile).toHaveBeenCalledTimes(1);
  expect(pushFileEdit).toHaveBeenCalledTimes(1);
  router.startWorkspaceWatch('task', 'turn', workspace);
  callbacks[0]!('stale.txt');
  expect(readWorkspaceTextFile).toHaveBeenCalledTimes(1);
  expect(stops[0]).toHaveBeenCalledTimes(1);
  resources.release('turn');
  callbacks[1]!('released.txt');
  expect(readWorkspaceTextFile).toHaveBeenCalledTimes(1);
  resources.begin('task', 'turn');
  router.startWorkspaceWatch('task', 'turn', workspace);
  callbacks[1]!('old-generation.txt');
  resources.dispose();
  callbacks[2]!('disposed.txt');
  router.startWorkspaceWatch('task', 'turn', workspace);
  expect(watchWorkspace).toHaveBeenCalledTimes(3);
  expect(readWorkspaceTextFile).toHaveBeenCalledTimes(1);
  expect(pushFileEdit).toHaveBeenCalledTimes(1);
  expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
  expect(resources.size).toBe(0);
});
