import { expect, it, vi } from 'vitest';
import { IpcRouter } from './ipc';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  clipboard: {},
  dialog: {},
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), removeListener: vi.fn() },
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

it('stops reading the Provider stream after a completed event so the connection is released', async () => {
  const taskId = 'task-658';
  const turnId = 'turn-658';
  const userMessageId = 'message-658';
  const connection = {
    id: 'profile:ollama-658',
    providerId: 'ollama',
    runtimeKind: 'openai_compatible',
    displayName: 'terminal',
    enabled: true,
    secretReference: null,
    verification: {
      status: 'verified',
      verifiedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      message: null,
    },
    rateLimit: {
      mode: 'auto',
      maxConcurrentRequests: null,
      requestsPerMinute: null,
      tokensPerMinute: null,
      lastObservedRateLimitHeaders: null,
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  let readAfterCompleted = false;
  let streamClosed = false;
  const execute = vi.fn(() =>
    (async function* () {
      try {
        yield { type: 'output_delta' as const, text: 'done' };
        yield { type: 'completed' as const, stopReason: 'completed' };
        // Only reached when the caller asks for another event after the terminal one.
        readAfterCompleted = true;
        await new Promise(() => undefined);
      } finally {
        streamClosed = true;
      }
    })(),
  );
  const fakeRouter = Object.create(IpcRouter.prototype) as Record<string, unknown>;
  Object.assign(fakeRouter, {
    canceledRuntimeTurns: new Set<string>(),
    turnRuntimes: new Map([[turnId, 'provider']]),
    providerAbortByTurn: new Map(),
    providerExecutionIdByTurn: new Map(),
    turnMessageIds: new Map(),
    managedWorkerTurn: new Map(),
    managedWorkerCall: new Map(),
    providerVerification: { requireVerifiedForExecution: vi.fn().mockResolvedValue(connection) },
    providerRegistry: { resolve: vi.fn(() => ({ execute, cancel: vi.fn() })) },
    modelCatalog: { find: vi.fn(() => ({ toolCalling: { value: false } })) },
    permissionBroker: {
      evaluate: vi.fn(() => ({
        decision: 'allow',
        reason: 'test_allow',
        policyEpoch: 1,
        evaluationTrace: ['test-allow'],
        permit: { id: 'test-permit' },
      })),
      revalidate: vi.fn(() => ({ valid: true, reason: 'test_valid' })),
    },
    persistence: {
      getTask: () => ({ id: taskId, projectId: null, localOnly: false }),
      getProviderConnection: () => connection,
      getPermissionPolicy: () => ({ policyEpoch: 1 }),
      getActiveTurnId: () => turnId,
      readTurnWorkspaceSetForTask: () => null,
      changeStage: vi.fn(() => ({ type: 'stage.changed' })),
      appendDelta: vi.fn(() => ({ type: 'message.delta' })),
    },
    mailbox: { run: async (_taskId: string, action: () => unknown) => action() },
    publish: vi.fn(),
    ensureProviderEndpointConsent: vi.fn().mockResolvedValue(undefined),
    prepareContext: vi.fn(() => ({
      fragments: [
        {
          id: 'current',
          taskId,
          source: 'history',
          trust: 'user',
          tokenEstimate: 1,
          content: 'hello',
          createdAt: new Date(0).toISOString(),
          messageId: userMessageId,
        },
      ],
      projectItems: [],
      projectSnapshotDigest: null,
    })),
    prepareProviderTurnImageAttachments: vi.fn(() => undefined),
    providerImageAttachmentStillValid: vi.fn().mockResolvedValue(true),
    providerEgressTrustForConnection: () => 'trusted-local',
    teamCoordinator: { hasUnfinishedTeamWork: () => false },
    applyProviderTurnEvent: vi.fn(),
    captureProviderToolImageBinding: vi.fn().mockResolvedValue(null),
    beginProviderSynthesis: vi.fn().mockResolvedValue(undefined),
    completeProviderTeamTurn: vi.fn().mockResolvedValue('completed'),
    finishAndAdvance: vi.fn(),
    cancelProviderExecution: vi.fn().mockResolvedValue(undefined),
  });
  const started = {
    turnId,
    text: 'hello',
    skills: [],
    event: { type: 'turn.accepted', taskId, userMessage: { id: userMessageId } },
    modelSelection: {
      connectionId: connection.id,
      requestedProvider: connection.providerId,
      requestedModel: 'model-658',
    },
    workspaceSet: { digest: 'workspace-digest', roots: [] },
  };
  const startProviderTurn = Reflect.get(IpcRouter.prototype, 'startProviderTurn') as (
    this: typeof fakeRouter,
    started: unknown,
    connectionId: string,
    teamTurn: boolean,
    autoSkills: readonly unknown[],
  ) => Promise<void>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      startProviderTurn.call(fakeRouter, started, connection.id, false, []),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Provider Turn still waiting after completed')),
          1_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  expect(execute).toHaveBeenCalledOnce();
  expect(readAfterCompleted).toBe(false);
  expect(streamClosed).toBe(true);
});
