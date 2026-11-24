import { TurnStreamingResources } from './turn-streaming-resources';
import { expect, it, vi } from 'vitest';
import { IpcRouter } from './ipc';
import { ProviderVerificationRequiredError } from './provider-verification';
import { LIST_WORKSPACE_TOOL, SKILL_DRAFT_TOOL } from './provider-workspace-tools';
import { ToolRegistry } from '@sprint-coder/domain';
import type { ProviderExecutionRequest } from '@sprint-coder/contracts';

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

it.each([
  { reasoning: false },
  { reasoning: true },
  { reasoning: false, verificationFailure: 'api_credentials' },
  { reasoning: false, verificationFailure: 'api_network' },
  { reasoning: false, verificationFailure: 'api_timeout' },
  { reasoning: false, rejectTools: 'draft' },
  { reasoning: false, rejectTools: 'ordinary' },
] as const)(
  'settles the Provider Turn ($reasoning, $verificationFailure, $rejectTools)',
  async ({ reasoning, ...options }) => {
    const verificationFailure =
      'verificationFailure' in options ? options.verificationFailure : undefined;
    const rejectTools = 'rejectTools' in options ? options.rejectTools : undefined;
    const registry = new ToolRegistry();
    if (rejectTools !== undefined)
      registry.register(rejectTools === 'draft' ? SKILL_DRAFT_TOOL : LIST_WORKSPACE_TOOL);
    const toolSnapshot = registry.createSnapshot({
      providerId: 'ollama',
      workspaceId: rejectTools === 'ordinary' ? 'workspace-digest' : null,
    });
    const recordTurnToolsDisabled = vi.fn();
    const taskId = 'task-658';
    const turnId = 'turn-658';
    const userMessageId = 'message-658';
    const emit = vi.fn();
    const resources = new TurnStreamingResources(emit);
    if (reasoning) resources.begin(taskId, turnId);
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
    const execute = vi.fn((_connection: unknown, request: ProviderExecutionRequest) =>
      (async function* () {
        try {
          if (rejectTools !== undefined && request.tools?.length) {
            yield {
              type: 'error' as const,
              error: {
                category: 'invalid_request' as const,
                message: 'fixture does not accept tools',
                retryable: false,
                retryAfterMs: null,
                providerCode: null,
              },
            };
            return;
          }
          if (reasoning) {
            yield { type: 'reasoning_delta' as const, text: 'safe before release\n' };
            resources.release(turnId);
            yield { type: 'reasoning_delta' as const, text: 'late after release\n' };
          }
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
    const appendDelta = vi.fn(() => ({ type: 'message.delta' }));
    const fakeRouter = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    Object.assign(fakeRouter, {
      turnStreamingResources: resources,
      canceledRuntimeTurns: new Set<string>(),
      turnRuntimes: new Map([[turnId, 'provider']]),
      providerAbortByTurn: new Map(),
      providerExecutionIdByTurn: new Map(),
      turnMessageIds: new Map(),
      managedWorkerTurn: new Map(),
      managedWorkerCall: new Map(),
      providerVerification: {
        requireVerifiedForExecution:
          verificationFailure === undefined
            ? vi.fn().mockResolvedValue(connection)
            : vi
                .fn()
                .mockRejectedValue(
                  new ProviderVerificationRequiredError('raw-placeholder', verificationFailure),
                ),
      },
      providerRegistry: { resolve: vi.fn(() => ({ execute, cancel: vi.fn() })) },
      modelCatalog: {
        find: vi.fn(() => ({ toolCalling: { value: rejectTools === undefined ? false : null } })),
      },
      managedCodingHarness: { startTurn: () => toolSnapshot, finishTurn: vi.fn() },
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
        appendDelta,
        recordTurnToolsDisabled,
        recordRuntimeFailureDiagnostic: vi.fn(() => ({ diagnosticId: 'fixture' })),
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
      skills:
        rejectTools === 'draft'
          ? [{ selection: { ref: { source: 'builtin', skillId: 'skill-creator' } } }]
          : [],
      event: { type: 'turn.accepted', taskId, userMessage: { id: userMessageId } },
      modelSelection: {
        connectionId: connection.id,
        requestedProvider: connection.providerId,
        requestedModel: 'model-658',
      },
      workspaceSet: {
        digest: 'workspace-digest',
        roots:
          rejectTools === 'ordinary'
            ? [{ rootId: 'root', label: 'fixture', path: '/fixture', role: 'primary' }]
            : [],
      },
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
      resources.dispose();
    }
    if (verificationFailure !== undefined) {
      expect(execute).not.toHaveBeenCalled();
      expect(fakeRouter.finishAndAdvance).toHaveBeenCalledExactlyOnceWith(
        taskId,
        turnId,
        'failed',
        undefined,
        verificationFailure,
      );
      expect(appendDelta).not.toHaveBeenCalled();
      return;
    }
    if (rejectTools === 'draft') {
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[1].tools?.map(({ name }) => name)).toEqual([
        'skill_draft_create',
      ]);
      expect(execute.mock.calls[0]?.[1].messages).toContainEqual(
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('Skillの下書きは、利用できる skill_draft_create'),
        }),
      );
      expect(recordTurnToolsDisabled).not.toHaveBeenCalled();
      expect(fakeRouter.finishAndAdvance).toHaveBeenCalledWith(taskId, turnId, 'failed');
      expect(appendDelta).toHaveBeenCalledWith(
        taskId,
        turnId,
        expect.any(String),
        expect.stringContaining('この接続ではSkillを作れません'),
      );
      return;
    }
    if (rejectTools === 'ordinary') {
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls[0]?.[1].tools?.map(({ name }) => name)).toEqual(['list_workspace']);
      expect(execute.mock.calls[1]?.[1].tools).toBeUndefined();
      expect(recordTurnToolsDisabled).toHaveBeenCalledOnce();
      return;
    }
    expect(execute).toHaveBeenCalledOnce();
    expect(readAfterCompleted).toBe(false);
    expect(streamClosed).toBe(true);
    expect(resources.size).toBe(0);
    if (reasoning)
      expect(emit).toHaveBeenCalledExactlyOnceWith(taskId, turnId, {
        text: 'safe before release\n',
        truncated: false,
      });
    else expect(emit).not.toHaveBeenCalled();
  },
);
