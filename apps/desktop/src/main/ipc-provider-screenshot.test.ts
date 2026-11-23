import { expect, it, vi } from 'vitest';
import { dialog } from 'electron';
import type { ProviderExecutionRequest } from '@sprint-coder/contracts';
import { IpcRouter } from './ipc';
import {
  holdScreenshotPicture,
  screenshotCallKey,
  SCREENSHOT_PICTURE_UNAVAILABLE,
} from './desktop-control-screenshot';
import { createHash } from 'node:crypto';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  clipboard: {},
  dialog: { showMessageBox: vi.fn() },
  ipcMain: {},
  BrowserWindow: class {},
  MessageChannelMain: class {},
  shell: {},
  utilityProcess: {},
  nativeImage: {},
  session: {},
  safeStorage: {},
  screen: {},
  globalShortcut: {},
}));

it.each([
  'grant',
  'deny',
  'change-model',
  'no-image',
  'local',
  'cli-grant',
  'cli-deny',
  'cli-change-model',
  'cli-no-image',
  'cli-local-only',
])('delivers a captured image only to its approved API destination: %s', async (mode) => {
  const taskId = 'screenshot-task',
    turnId = 'screenshot-turn',
    modelId = 'vision-model';
  const local = mode === 'local';
  const cli = mode.startsWith('cli-');
  const variant = mode.replace('cli-', '');
  const connection = {
    id: cli ? 'builtin:antigravity-cli' : 'test-api',
    providerId: cli ? 'antigravity' : local ? 'ollama' : 'anthropic',
    runtimeKind: cli ? 'builtin_cli' : local ? 'openai_compatible' : 'official_api',
    enabled: true,
    secretReference: 'ref',
    verification: {
      status: 'verified',
      verifiedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  };
  const selection = {
    connectionId: connection.id,
    requestedProvider: connection.providerId,
    requestedModel: modelId,
  };
  let activeSelection = selection;
  const started = {
    event: { type: 'turn.accepted', taskId, userMessage: { id: 'u' } },
    turnId,
    skills: [],
    text: 'read it',
    modelSelection: selection,
    workspaceSet: { digest: 'workspace', roots: [{ rootId: 'r', path: '/fixture' }] },
  };
  const bytes = Buffer.from('private picture marker'),
    base64 = bytes.toString('base64');
  const picture = {
    mimeType: 'image/jpeg' as const,
    byteLength: bytes.length,
    dataUrl: 'data:image/jpeg;base64,' + base64,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const requests: ProviderExecutionRequest[] = [];
  const runtime = {
    cloudScreenshotUrl: 'https://api.anthropic.com/v1/messages',
    async *execute(_connection: unknown, request: ProviderExecutionRequest) {
      requests.push(request);
      if (requests.length === 1)
        yield { type: 'tool_call', callId: 'capture', name: 'exec_command', input: {} };
      else yield { type: 'output_delta', text: 'finished' };
      yield { type: 'completed', stopReason: requests.length === 1 ? 'tool_calls' : 'completed' };
    },
  };
  const evaluate = vi.fn(() => ({
    decision: 'allow',
    reason: 'fixture',
    policyEpoch: 1,
    evaluationTrace: [],
    permit: { id: 'allowed' },
  }));
  const prompt = vi.mocked(dialog.showMessageBox);
  prompt.mockReset();
  prompt.mockImplementation(async () => {
    if (variant === 'change-model') activeSelection = { ...selection, requestedModel: 'different' };
    return { response: variant === 'deny' ? 0 : 1, checkboxChecked: false };
  });
  const router = Object.create(IpcRouter.prototype);
  const publish = vi.fn(),
    appendDelta = vi.fn(() => ({ type: 'message.delta' })),
    recordDiagnostic = vi.fn();
  Object.assign(router, {
    providerAbortByTurn: new Map(),
    providerExecutionIdByTurn: new Map(),
    turnMessageIds: new Map(),
    turnRuntimes: new Map([[turnId, 'provider']]),
    canceledRuntimeTurns: new Set(),
    managedWorkerTurn: new Map(),
    managedWorkerCall: new Map(),
    window: { isDestroyed: () => false },
    providerVerification: { requireVerifiedForExecution: async () => connection },
    ensureProviderEndpointConsent: async () => {},
    providerRegistry: { resolve: () => runtime },
    providerSecrets: { get: () => 'fixture-credential' },
    modelCatalog: {
      find: () => ({
        modelId,
        connectionId: connection.id,
        providerId: connection.providerId,
        available: true,
        multimodalInput: { value: variant !== 'no-image', source: 'runtime_metadata' },
        imageInput: { value: mode !== 'no-image', source: 'provider_api' },
        toolCalling: { value: true },
      }),
    },
    providerEndpointPolicy: { prepareRequestUrl: async () => ({ trust: 'trusted-remote' }) },
    permissionBroker: { evaluate, revalidate: () => ({ valid: true, reason: 'ok' }) },
    persistence: {
      getTask: () => ({ id: taskId, localOnly: variant === 'local-only', projectId: null }),
      getProviderConnection: () => connection,
      getTaskModelSelection: () => activeSelection,
      getPermissionPolicy: () => ({ policyEpoch: 1 }),
      getActiveTurnId: () => turnId,
      readTurnWorkspaceSetForTask: () => null,
      changeStage: () => ({ type: 'stage.changed' }),
      appendDelta,
      recordRuntimeFailureDiagnostic: recordDiagnostic,
    },
    managedCodingHarness: {
      finishTurn: vi.fn(),
      startTurn: () => ({
        digest: 'a'.repeat(64),
        entries: [
          { providerName: 'exec_command', inputSchema: { type: 'object', properties: {} } },
        ],
      }),
      broker: {
        dispatch: async () => {
          holdScreenshotPicture(screenshotCallKey(taskId, turnId, 'capture'), picture);
          return {
            picture: SCREENSHOT_PICTURE_UNAVAILABLE,
            stdout: JSON.stringify({ ok: true, data: { sha256: picture.sha256 } }),
          };
        },
      },
    },
    mailbox: { run: async (_id: string, fn: () => unknown) => fn() },
    publish,
    prepareContext: () => ({ fragments: [], projectItems: [], projectSnapshotDigest: null }),
    prepareProviderTurnImageAttachments: () => undefined,
    providerEgressTrustForConnection: () => (local ? 'trusted-local' : 'trusted-remote'),
    captureProviderToolImageBinding: async () => (local ? { connectionDigest: 'test' } : null),
    revalidateProviderToolImageBinding: async () => ({ trust: 'trusted-local' }),
    providerToolImageFinalStateMatches: () => true,
    teamCoordinator: { hasUnfinishedTeamWork: () => false },
    applyProviderTurnEvent: vi.fn(),
    beginProviderSynthesis: vi.fn(),
    completeProviderTeamTurn: async () => 'completed',
    finishAndAdvance: vi.fn(),
    cancelProviderExecution: vi.fn(),
  });
  await router.startProviderTurn(started, connection.id);
  expect(prompt).toHaveBeenCalledTimes(
    local || variant === 'no-image' || variant === 'local-only' ? 0 : 1,
  );
  if (!local && variant !== 'no-image' && variant !== 'local-only')
    expect(prompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        detail: expect.stringContaining(
          cli ? 'Antigravity CLI' : 'https://api.anthropic.com/v1/messages',
        ),
        cancelId: 0,
        defaultId: 0,
      }),
    );
  expect(requests).toHaveLength(variant === 'change-model' ? 1 : 2);
  const images = requests.flatMap((r) => r.messages.flatMap((m) => m.inlineImages ?? []));
  expect(images).toEqual(
    variant === 'grant' || local ? [{ mimeType: picture.mimeType, base64 }] : [],
  );
  expect(
    JSON.stringify([
      ...evaluate.mock.calls,
      ...appendDelta.mock.calls,
      ...recordDiagnostic.mock.calls,
      ...publish.mock.calls,
      ...prompt.mock.calls,
    ]),
  ).not.toContain(base64);
});
