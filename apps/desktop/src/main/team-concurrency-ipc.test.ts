import { describe, expect, it, vi } from 'vitest';
import {
  IPC_CHANNELS,
  teamConcurrencySettingsSchema,
  teamConcurrencySettingsSetInputSchema,
} from '@sprint-coder/contracts';
import { IpcRouter } from './ipc';

vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  dialog: {},
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  MessageChannelMain: class {},
}));

type CapturedHandler = (input: unknown, event: unknown, envelope: unknown) => unknown;

/** Registers the real handlers on a router whose collaborators are stubs, so the Settings > Team
 * concurrency wiring (schemas, persistence, scheduler notification) is what the test observes. */
function captureHandlers() {
  const router = Object.create(IpcRouter.prototype) as IpcRouter & Record<string, unknown>;
  const handlers = new Map<string, CapturedHandler>();
  const schemas = new Map<string, { input: unknown; output: unknown }>();
  const capture = (...args: unknown[]): void => {
    const channel = args[0];
    const handler = args[3];
    if (typeof channel !== 'string' || typeof handler !== 'function')
      throw new Error('Unexpected IPC handler registration');
    handlers.set(channel, handler as CapturedHandler);
    schemas.set(channel, { input: args[1], output: args[2] });
  };
  let saved = 50;
  const persistence = {
    getTeamMaxConcurrentExecutions: vi.fn(() => saved),
    setTeamMaxConcurrentExecutions: vi.fn((limit: number) => {
      saved = limit;
    }),
  };
  const teamCoordinator = {
    hasBusyWorkers: vi.fn(() => false),
    notifyConcurrencyLimitChanged: vi.fn(),
  };
  Object.assign(router, {
    handle: capture,
    handleMutation: capture,
    window: { id: 42, webContents: { once: vi.fn() } },
    teamCoordinator,
    runMutation: (
      _event: unknown,
      _envelope: unknown,
      _taskId: string,
      _channel: string,
      action: () => unknown,
    ) => ({ value: action(), executed: true }),
    persistence,
  });
  router.register();
  return { handlers, schemas, persistence, teamCoordinator };
}

describe('Settings > Team concurrency IPC', () => {
  it('reads and saves the app-wide limit and wakes the scheduler without a restart', async () => {
    const fixture = captureHandlers();
    expect(fixture.schemas.get(IPC_CHANNELS.settingsGetTeamConcurrency)?.output).toBe(
      teamConcurrencySettingsSchema,
    );
    expect(fixture.schemas.get(IPC_CHANNELS.settingsSetTeamConcurrency)?.input).toBe(
      teamConcurrencySettingsSetInputSchema,
    );
    const get = fixture.handlers.get(IPC_CHANNELS.settingsGetTeamConcurrency)!;
    const set = fixture.handlers.get(IPC_CHANNELS.settingsSetTeamConcurrency)!;

    expect(await get({}, {}, {})).toEqual({ maxConcurrentExecutions: 50 });
    await set({ maxConcurrentExecutions: 80 }, {}, {});
    expect(fixture.persistence.setTeamMaxConcurrentExecutions).toHaveBeenLastCalledWith(80);
    expect(fixture.teamCoordinator.notifyConcurrencyLimitChanged).toHaveBeenCalledTimes(1);
    expect(await get({}, {}, {})).toEqual({ maxConcurrentExecutions: 80 });
  });

  it('accepts 1 to 100 Workers and nothing outside it', () => {
    for (const valid of [1, 50, 100])
      expect(
        teamConcurrencySettingsSetInputSchema.safeParse({ maxConcurrentExecutions: valid }).success,
      ).toBe(true);
    for (const invalid of [0, 101, 2.5, '50', null])
      expect(
        teamConcurrencySettingsSetInputSchema.safeParse({ maxConcurrentExecutions: invalid })
          .success,
      ).toBe(false);
    expect(
      teamConcurrencySettingsSetInputSchema.safeParse({ maxConcurrentExecutions: 50, extra: 1 })
        .success,
    ).toBe(false);
  });
});
