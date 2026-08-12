import { describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  IPC_CHANNELS,
  anthropicConnectionCreateInputSchema,
  approvalResolveInputSchema,
  canvasViewSaveInputSchema,
  commandEnvelopeSchema,
  commandOutputPageInputSchema,
  commandOutputTailInputSchema,
  connectionIdSchema,
  emptyPayloadSchema,
  geminiConnectionCreateInputSchema,
  generatedImageRefSchema,
  goalControlInputSchema,
  goalResumeInputSchema,
  goalStartInputSchema,
  imageAttachmentRemoveInputSchema,
  modelCatalogQueryInputSchema,
  modelCatalogSelectionSetInputSchema,
  openAIConnectionCreateInputSchema,
  openRouterConnectionCreateInputSchema,
  permissionSetInputSchema,
  providerConnectionRateLimitLowerInputSchema,
  providerConnectionModelReleaseUpdateInputSchema,
  providerProfileConnectionCreateInputSchema,
  projectAssignTaskInputSchema,
  projectContextManifestGetInputSchema,
  projectContextManifestsListInputSchema,
  projectCreateInputSchema,
  projectFoldersListInputSchema,
  projectFoldersReplaceInputSchema,
  projectGetInputSchema,
  projectInstructionSetInputSchema,
  projectMemoriesListInputSchema,
  projectMemoryCreateInputSchema,
  projectMemoryUpdateInputSchema,
  projectReferenceAddInputSchema,
  projectReferencePickInputSchema,
  projectReferenceRemoveInputSchema,
  projectReferencesListInputSchema,
  projectReferenceUpdateInputSchema,
  projectUnassignTaskInputSchema,
  projectUpdateInputSchema,
  runtimeCodexEffortSetInputSchema,
  runtimeEffortSetInputSchema,
  runtimeFailureDiagnosticQuerySchema,
  runtimeModelSetInputSchema,
  runtimeSetInputSchema,
  sprintCoderPrePromptSetInputSchema,
  skillCandidateInputSchema,
  skillDraftCreateInputSchema,
  skillDraftIdInputSchema,
  skillDraftInstallInputSchema,
  skillEnabledInputSchema,
  skillImportInputSchema,
  skillInstalledInputSchema,
  createdSkillEnabledInputSchema,
  createdSkillMutationInputSchema,
  taskSkillSelectionInputSchema,
  taskArchivedInputSchema,
  taskCreateInputSchema,
  taskDraftInputSchema,
  taskGoalInputSchema,
  taskIdPayloadSchema,
  filePathPayloadSchema,
  fileSaveInputSchema,
  taskPinnedInputSchema,
  taskRenameInputSchema,
  teamHireWorkerInputSchema,
  teamModelSelectionGuidanceSetInputSchema,
  teamResumeMissionInputSchema,
  teamResumeExecutionIntegrationInputSchema,
  teamPolicySchema,
  teamPolicyUpdateInputSchema,
  teamModelResearchSettingsSetInputSchema,
  codexUserConfigSettingsSetInputSchema,
  teamModelRestrictionSetInputSchema,
  teamSendMessageInputSchema,
  teamSubscriptionInputSchema,
  teamWorkerRefSchema,
  turnCancelInputSchema,
  turnQueueInputSchema,
  turnStartInputSchema,
  turnSteerInputSchema,
  turnStopAndSendInputSchema,
  turnSubscriptionInputSchema,
  xAIConnectionCreateInputSchema,
  type EffectiveWorkspaceSet,
  type CodexModelOption,
  type ProviderModel,
} from '@sprint-coder/contracts';
import {
  clampCodexEffort,
  confirmFullAccessOnce,
  contextFragmentsForRuntime,
  cancelRuntimeWithFinalCleanup,
  fileEditTrackingKey,
  IpcRouter,
  invalidModelUserMessage,
  isCommittedProviderWorkspaceChange,
  isCommittedProviderWorkspaceMutation,
  isTrustedIpcSender,
  leaderMcpCapabilities,
  listAvailableTeamRuntimeModels,
  shouldBlockProviderLeaderCompletion,
  providerWorkspaceToolsEligible,
  providerModelsForBuiltin,
  requireExplicitProviderCommandApproval,
  requiredTeamWorkerFailure,
  shouldRetryProviderWithoutTools,
  shouldFailRequiredTeamTurn,
  requiresHomeDirectoryConfirmation,
  runBestEffortCancellation,
  resolveEffectiveWorkspaceRoot,
  verifyTurnWorkspaceIdentities,
  toPublicError,
} from './ipc';

import { ModelCatalogService } from './model-catalog-service';
import { ImageAttachmentValidationError } from './image-attachment-store';
import { ImageAttachmentAcceptanceError, ImageAttachmentLimitError } from './persistence';
import {
  buildImageAttachmentSelectionIdentity,
  imageAttachmentSelectionIdentityDigest,
  type ImageAttachmentRuntimeSnapshot,
} from './image-attachment-capability';
import { BUILTIN_CODEX_CONNECTION_ID } from './connection-identity';
import { requiresTeamWorkersInput } from './team-tools';
import { RuntimeFailureDiagnosticCollector } from '../runtime-host/runtime-failure-diagnostics';
import { secureLogger } from './secure-logger';
import { SPRINT_CODER_IDENTITY_PROMPT } from './context-ledger';

describe('file edit tracking identity', () => {
  it('deduplicates Windows relative paths that differ only by casing', () => {
    expect(fileEditTrackingKey('turn', 'root', 'Src/App.ts', 'win32')).toBe(
      fileEditTrackingKey('turn', 'root', 'src/app.ts', 'win32'),
    );
  });
});

describe('Codex selected Skill delivery', () => {
  const fragments = [
    {
      id: 'system',
      source: 'system' as const,
      trust: 'system' as const,
      authority: 'system' as const,
      content: SPRINT_CODER_IDENTITY_PROMPT,
    },
    {
      id: 'selected-skill',
      source: 'skill' as const,
      trust: 'user' as const,
      authority: 'user' as const,
      content: 'UNIQUE_SELECTED_SKILL_BODY',
    },
  ];

  it('removes selected Skill bodies from Codex application context only', () => {
    expect(contextFragmentsForRuntime('codex', fragments).map(({ id }) => id)).toEqual(['system']);
    expect(contextFragmentsForRuntime('claude', fragments)).toEqual(fragments);
    expect(contextFragmentsForRuntime('provider', fragments)).toEqual(fragments);
    for (const runtime of ['codex', 'claude', 'provider'] as const)
      expect(contextFragmentsForRuntime(runtime, fragments)[0]?.content).toBe(
        SPRINT_CODER_IDENTITY_PROMPT,
      );
  });
});

describe('Main runtime failure diagnostics', () => {
  function createRuntimeFailureHarness(diagnosticId = 'diagnostic-main-protocol') {
    const recordRuntimeFailureDiagnostic = vi.fn().mockReturnValue({ diagnosticId });
    const pushRuntimeStatus = vi.fn();
    const turnRuntimes = new Map([['turn-protocol', 'codex']]);
    const runtimeDiagnosticContextByTurn = new Map([
      [
        'turn-protocol',
        { startedAtMs: Date.now() - 10, runtimeKind: 'codex', teamMcpEnabled: true },
      ],
    ]);
    let activeTurnId: string | null = 'turn-protocol';
    const finishAndAdvance = vi.fn((_taskId: string, turnId: string) => {
      turnRuntimes.delete(turnId);
      runtimeDiagnosticContextByTurn.delete(turnId);
      activeTurnId = null;
    });
    const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    Object.assign(router, {
      mailbox: {
        run: vi.fn((_taskId: string, action: () => unknown) => Promise.resolve(action())),
      },
      canceledRuntimeTurns: new Set<string>(),
      turnRuntimes,
      turnLogCategoryByTurn: new Map([['turn-protocol', 'chat']]),
      turnLogStartedAtByTurn: new Map([['turn-protocol', Date.now() - 10]]),
      turnLogRuntimeByTurn: new Map([
        ['turn-protocol', { runtime: 'codex' as const, provider: 'openai' }],
      ]),
      runtimeDiagnosticContextByTurn,
      attachmentCustodyByTurn: new Map(),
      persistence: {
        getActiveTurnId: vi.fn(() => activeTurnId),
        recordRuntimeFailureDiagnostic,
      },
      pushRuntimeStatus,
      finishAndAdvance,
    });
    return {
      probe: router as unknown as {
        handleRuntimeFailure(
          kind: 'codex',
          taskId: string,
          turnId: string,
          error: { code: string; userMessage: string; retryable: boolean },
          diagnostic?: ReturnType<RuntimeFailureDiagnosticCollector['snapshot']>,
        ): void;
      },
      recordRuntimeFailureDiagnostic,
      pushRuntimeStatus,
      finishAndAdvance,
      dropTransientRuntime: () => turnRuntimes.delete('turn-protocol'),
    };
  }

  it('persists one fallback for a missing protocol diagnostic and relays its id', async () => {
    const harness = createRuntimeFailureHarness();
    const log = vi.spyOn(secureLogger, 'error');

    harness.probe.handleRuntimeFailure('codex', 'task-protocol', 'turn-protocol', {
      code: 'RUNTIME_PROTOCOL_ERROR',
      userMessage: 'safe public message',
      retryable: true,
    });

    await vi.waitFor(() => expect(harness.finishAndAdvance).toHaveBeenCalledOnce());
    expect(harness.recordRuntimeFailureDiagnostic).toHaveBeenCalledOnce();
    expect(harness.recordRuntimeFailureDiagnostic).toHaveBeenCalledWith(
      'task-protocol',
      'turn-protocol',
      expect.objectContaining({
        runtimeKind: 'codex',
        failureStage: 'protocol_error',
        teamMcp: { enabled: true, status: 'configured' },
      }),
    );
    expect(harness.pushRuntimeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ diagnosticId: 'diagnostic-main-protocol' }),
    );
    expect(log).toHaveBeenCalledWith(
      'Runtime failed',
      expect.objectContaining({ diagnosticId: 'diagnostic-main-protocol' }),
      expect.objectContaining({
        category: 'chat',
        event: 'turn.runtime.failed',
        taskId: 'task-protocol',
        turnId: 'turn-protocol',
        status: 'failed',
      }),
    );
    expect(harness.finishAndAdvance).toHaveBeenCalledWith(
      'task-protocol',
      'turn-protocol',
      'failed',
    );
    log.mockRestore();
  });

  it('keeps adapter diagnostics and does not invent diagnostics for non-protocol failures', async () => {
    const existing = new RuntimeFailureDiagnosticCollector(
      'codex',
      '0.2.3',
      'codex 1.2.3',
      false,
    ).snapshot('protocol_error');
    const existingHarness = createRuntimeFailureHarness(existing.diagnosticId);
    existingHarness.probe.handleRuntimeFailure(
      'codex',
      'task-protocol',
      'turn-protocol',
      { code: 'RUNTIME_PROTOCOL_ERROR', userMessage: 'safe', retryable: true },
      existing,
    );
    await vi.waitFor(() => expect(existingHarness.finishAndAdvance).toHaveBeenCalledOnce());
    expect(existingHarness.recordRuntimeFailureDiagnostic).toHaveBeenCalledWith(
      'task-protocol',
      'turn-protocol',
      existing,
    );

    const nonProtocolHarness = createRuntimeFailureHarness();
    nonProtocolHarness.probe.handleRuntimeFailure('codex', 'task-protocol', 'turn-protocol', {
      code: 'RUNTIME_FAILED',
      userMessage: 'safe',
      retryable: true,
    });
    await vi.waitFor(() => expect(nonProtocolHarness.finishAndAdvance).toHaveBeenCalledOnce());
    expect(nonProtocolHarness.recordRuntimeFailureDiagnostic).not.toHaveBeenCalled();
    expect(nonProtocolHarness.pushRuntimeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ diagnosticId: null }),
    );
  });

  it('ignores a duplicate protocol failure after the Turn is terminalized', async () => {
    const harness = createRuntimeFailureHarness();
    const error = {
      code: 'RUNTIME_PROTOCOL_ERROR',
      userMessage: 'safe',
      retryable: true,
    };

    harness.probe.handleRuntimeFailure('codex', 'task-protocol', 'turn-protocol', error);
    await vi.waitFor(() => expect(harness.finishAndAdvance).toHaveBeenCalledOnce());
    harness.probe.handleRuntimeFailure('codex', 'task-protocol', 'turn-protocol', error);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.recordRuntimeFailureDiagnostic).toHaveBeenCalledOnce();
    expect(harness.finishAndAdvance).toHaveBeenCalledOnce();
  });

  it('persists a late protocol diagnostic while the durable Turn is still active', async () => {
    const harness = createRuntimeFailureHarness('diagnostic-late-protocol');
    harness.dropTransientRuntime();

    harness.probe.handleRuntimeFailure('codex', 'task-protocol', 'turn-protocol', {
      code: 'RUNTIME_PROTOCOL_ERROR',
      userMessage: 'safe',
      retryable: true,
    });

    await vi.waitFor(() => expect(harness.finishAndAdvance).toHaveBeenCalledOnce());
    expect(harness.recordRuntimeFailureDiagnostic).toHaveBeenCalledOnce();
    expect(harness.pushRuntimeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ diagnosticId: 'diagnostic-late-protocol' }),
    );
  });
});

describe('built-in subscription model capabilities', () => {
  it('pages fallback candidates within the catalog limit and preserves the allowlist', () => {
    const runtimeMetadata = { value: true, source: 'runtime_metadata' as const };
    const catalog = new ModelCatalogService();
    const claudeModels: ProviderModel[] = Array.from({ length: 101 }, (_, index) => ({
      connectionId: 'builtin:claude-cli',
      providerId: 'anthropic',
      modelId: `claude-${String(index).padStart(3, '0')}`,
      displayName: `Claude ${index}`,
      available: true,
      availabilityCheckedAt: '2026-08-09T00:00:00.000Z',
      contextWindow: { value: null, source: 'unknown' },
      maxOutputTokens: { value: null, source: 'unknown' },
      toolCalling: runtimeMetadata,
      structuredOutput: runtimeMetadata,
      multimodalInput: runtimeMetadata,
      reasoning: runtimeMetadata,
    }));
    const codexModels: ProviderModel[] = [
      {
        connectionId: 'builtin:codex-cli',
        providerId: 'openai',
        modelId: 'gpt-test',
        displayName: 'GPT Test',
        available: true,
        availabilityCheckedAt: '2026-08-09T00:00:00.000Z',
        contextWindow: { value: null, source: 'unknown' },
        maxOutputTokens: { value: null, source: 'unknown' },
        toolCalling: runtimeMetadata,
        structuredOutput: runtimeMetadata,
        multimodalInput: runtimeMetadata,
        reasoning: runtimeMetadata,
      },
      {
        connectionId: 'builtin:codex-cli',
        providerId: 'openai',
        modelId: 'gpt-excluded',
        displayName: 'GPT Excluded',
        available: true,
        availabilityCheckedAt: '2026-08-09T00:00:00.000Z',
        contextWindow: { value: null, source: 'unknown' },
        maxOutputTokens: { value: null, source: 'unknown' },
        toolCalling: runtimeMetadata,
        structuredOutput: runtimeMetadata,
        multimodalInput: runtimeMetadata,
        reasoning: runtimeMetadata,
      },
    ];
    const allowed = new Set(
      [...claudeModels, codexModels[0]!].map(
        ({ connectionId, providerId, modelId }) =>
          `${connectionId}\u0000${providerId}\u0000${modelId}`,
      ),
    );
    catalog.replaceCatalog([...claudeModels, ...codexModels]);

    const candidates = listAvailableTeamRuntimeModels(catalog, 'task-1', allowed);

    expect(candidates).toHaveLength(102);
    expect(candidates.some(({ modelId }) => modelId === 'gpt-test')).toBe(true);
    expect(candidates.some(({ modelId }) => modelId === 'gpt-excluded')).toBe(false);
  });

  it('preserves CLI and curated capability evidence in the shared model catalog', () => {
    const runtimeMetadata = { value: true, source: 'runtime_metadata' as const };
    const models: CodexModelOption[] = [
      {
        id: 'gpt-test',
        displayName: 'GPT Test',
        description: '',
        capabilities: {
          toolCalling: runtimeMetadata,
          structuredOutput: runtimeMetadata,
          multimodalInput: runtimeMetadata,
          reasoning: runtimeMetadata,
        },
      },
    ];

    const builtinModels = providerModelsForBuiltin(
      'builtin:codex-cli',
      'Codex CLI',
      'openai',
      models,
      true,
      '2026-08-09T00:00:00.000Z',
    );
    expect(builtinModels[0]).toMatchObject({
      toolCalling: runtimeMetadata,
      structuredOutput: runtimeMetadata,
      multimodalInput: runtimeMetadata,
      reasoning: runtimeMetadata,
    });

    const catalog = new ModelCatalogService();
    catalog.replaceCatalog(builtinModels, new Set(['builtin:codex-cli']));
    expect(
      catalog.query({
        taskId: 'task-1',
        text: '',
        connectionIds: [],
        providerIds: [],
        accessTypes: ['subscription'],
        capabilities: ['toolCalling', 'structuredOutput', 'multimodalInput', 'reasoning'],
        availableOnly: true,
        cursor: null,
        limit: 10,
      }).items,
    ).toHaveLength(1);
  });
});

describe('Turn cancellation boundary', () => {
  it('continues after a runtime stop cannot be confirmed', async () => {
    const onFailure = vi.fn();
    const finalize = vi.fn();

    const stopped = await runBestEffortCancellation(async () => {
      throw new Error('runtime host exited before stop acknowledgement');
    }, onFailure);
    finalize();

    expect(stopped).toBe(false);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
  });
});

describe('Project home-directory confirmation', () => {
  const home = join(dirname(process.cwd()), 'home-owner');

  it('requires confirmation for the home directory and any selected ancestor', () => {
    expect(requiresHomeDirectoryConfirmation(home, home)).toBe(true);
    expect(requiresHomeDirectoryConfirmation(dirname(home), home)).toBe(true);
  });

  it('does not warn for a child or path-component sibling of home', () => {
    expect(requiresHomeDirectoryConfirmation(join(home, 'project'), home)).toBe(false);
    expect(requiresHomeDirectoryConfirmation(`${home}-other`, home)).toBe(false);
  });
});

describe('Full Access confirmation', () => {
  it('asks once and remembers the confirmation for later Tasks', async () => {
    let acknowledged = false;
    const persistence = {
      hasAcknowledgedFullAccessRisk: vi.fn(() => acknowledged),
      acknowledgeFullAccessRisk: vi.fn(() => {
        acknowledged = true;
      }),
    };
    const confirm = vi.fn().mockResolvedValue(true);

    await confirmFullAccessOnce(persistence, confirm);
    await confirmFullAccessOnce(persistence, confirm);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(persistence.acknowledgeFullAccessRisk).toHaveBeenCalledTimes(1);
  });

  it('does not remember a declined confirmation', async () => {
    const persistence = {
      hasAcknowledgedFullAccessRisk: vi.fn().mockReturnValue(false),
      acknowledgeFullAccessRisk: vi.fn(),
    };

    await expect(
      confirmFullAccessOnce(persistence, vi.fn().mockResolvedValue(false)),
    ).rejects.toThrow();
    expect(persistence.acknowledgeFullAccessRisk).not.toHaveBeenCalled();
  });
});

describe('image attachment public errors', () => {
  it('keeps validation errors actionable without leaking selected paths', () => {
    const error = new ImageAttachmentValidationError('invalid_image');
    Object.assign(error, { selectedPath: '/Users/private/secret.png' });
    const result = toPublicError(error);
    expect(result).toEqual({
      code: 'INVALID_REQUEST',
      userMessage: 'PNG・JPEG・WebPの静止画像を選んでください。',
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain('/Users/private');
  });

  it('maps count and aggregate limits to a fixed non-retryable message', () => {
    expect(toPublicError(new ImageAttachmentLimitError('internal aggregate details'))).toEqual({
      code: 'INVALID_REQUEST',
      userMessage: '画像は4枚まで、合計16MB以下にしてください。',
      retryable: false,
    });
  });

  it('maps acceptance races and unsupported runtimes without leaking custody details', () => {
    expect(toPublicError(new ImageAttachmentAcceptanceError('unsupported'))).toEqual({
      code: 'INVALID_REQUEST',
      userMessage: '選択中のRuntimeでは画像添付を送信できません。',
      retryable: false,
    });
    expect(toPublicError(new ImageAttachmentAcceptanceError('stale'))).toEqual({
      code: 'INVALID_REQUEST',
      userMessage: '画像添付の状態が変わりました。最新の一覧を確認してください。',
      retryable: false,
    });
  });
});

describe('Main image attachment dispatch boundary', () => {
  it('passes canonical accepted bytes through custody and exact Runtime preparation, then releases', async () => {
    const taskId = 'task-image-main';
    const turnId = 'turn-image-main';
    const selection = {
      taskId,
      runtimeKind: 'codex' as const,
      model: 'gpt-5',
      modelSelection: {
        connectionId: BUILTIN_CODEX_CONNECTION_ID,
        requestedProvider: 'openai',
        requestedModel: 'gpt-5',
      },
    };
    const snapshot: ImageAttachmentRuntimeSnapshot = {
      runtimeKind: 'codex',
      available: true,
      readiness: 'ready',
      runtimeInstanceId: 'runtime-image-main',
      readinessRevision: 7,
      catalogRevision: 'catalog-image-main',
      modelIds: ['gpt-5'],
      capturedAtMs: Date.now(),
    };
    const identity = buildImageAttachmentSelectionIdentity(selection, snapshot)!;
    const selectionIdentity = imageAttachmentSelectionIdentityDigest(identity);
    const bytes = Buffer.from('canonical-image');
    const attachment = {
      id: 'attachment-image-main',
      fileName: 'image.png',
      mimeType: 'image/png' as const,
      byteLength: bytes.byteLength,
      sha256: 'a'.repeat(64),
      bytes,
      createdAt: '2026-08-05T00:00:00.000Z',
    };
    const lease = Object.freeze({
      turnId,
      operationId: 'custody-image-main',
      manifest: Object.freeze([
        {
          id: attachment.id,
          mimeType: attachment.mimeType,
          byteLength: attachment.byteLength,
          sha256: attachment.sha256,
        },
      ]),
      manifestDigest: 'b'.repeat(64),
      paths: Object.freeze(['/private/custody/001.png']),
    });
    const prepareCustody = vi.fn().mockResolvedValue(lease);
    const releaseCustody = vi.fn().mockResolvedValue(true);
    const prepareRuntime = vi.fn().mockResolvedValue(
      Object.freeze({
        runtimeInstanceId: snapshot.runtimeInstanceId,
        taskId,
        turnId,
        operationId: 'runtime-operation-image-main',
        selectionIdentity,
        manifestDigest: lease.manifestDigest,
        decodedByteLength: attachment.byteLength,
      }),
    );
    const current = {
      runtimeKind: 'codex' as const,
      runtimeInstanceId: snapshot.runtimeInstanceId,
      readinessRevision: snapshot.readinessRevision,
      catalogRevision: snapshot.catalogRevision,
    };
    const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    Object.assign(router, {
      persistence: {
        getAcceptedImageAttachments: vi.fn().mockReturnValue([attachment]),
        getImageAttachmentAcceptanceSelection: vi.fn().mockReturnValue(selection),
      },
      codexRuntime: {
        captureImageAttachmentCapability: vi.fn().mockResolvedValue(snapshot),
        currentImageAttachmentCapability: vi.fn().mockReturnValue(current),
        prepareImageAttachments: prepareRuntime,
      },
      attachmentCustodyStore: { prepare: prepareCustody, release: releaseCustody },
      attachmentCapabilityByTurn: new Map([
        [turnId, Object.freeze({ snapshot, selectionIdentity })],
      ]),
      attachmentCustodyByTurn: new Map(),
      turnRuntimes: new Map([[turnId, 'codex']]),
    });
    const probe = router as unknown as {
      prepareTurnImageAttachments(
        started: unknown,
        kind: 'codex',
      ): Promise<{
        receipt: { selectionIdentity: string };
        manifestDigest: string;
        byteCount: number;
      }>;
      releaseTurnAttachmentCustody(turnId: string): Promise<void>;
    };
    const started = { turnId, event: { taskId } };

    const prepared = await probe.prepareTurnImageAttachments(started, 'codex');

    expect(prepareCustody).toHaveBeenCalledWith({
      turnId,
      attachments: [
        {
          id: attachment.id,
          mimeType: attachment.mimeType,
          byteLength: attachment.byteLength,
          sha256: attachment.sha256,
          bytes,
        },
      ],
    });
    expect(prepareRuntime).toHaveBeenCalledWith({
      taskId,
      turnId,
      selectionIdentity,
      manifest: lease.manifest,
      paths: lease.paths,
      manifestDigest: lease.manifestDigest,
    });
    expect(prepared).toMatchObject({
      receipt: { selectionIdentity },
      manifestDigest: lease.manifestDigest,
      byteCount: attachment.byteLength,
    });

    await probe.releaseTurnAttachmentCustody(turnId);
    expect(releaseCustody).toHaveBeenCalledWith(lease);
  });

  it('releases custody in finally when forced Runtime cancellation rejects', async () => {
    const calls: string[] = [];
    const cancel = vi.fn().mockImplementation(async () => {
      calls.push('cancel');
      throw new Error('forced restart after unconfirmed stop');
    });
    const release = vi.fn().mockImplementation(async () => {
      calls.push('release');
    });

    await expect(cancelRuntimeWithFinalCleanup(cancel, release)).rejects.toThrow(
      'forced restart after unconfirmed stop',
    );
    expect(calls).toEqual(['cancel', 'release']);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('Turn Workspace health gate', () => {
  const workspace: EffectiveWorkspaceSet = {
    source: 'project',
    projectId: 'project-1',
    primaryRootId: 'root-a',
    roots: [
      {
        rootId: 'root-a',
        path: '/workspace/a',
        label: 'a',
        role: 'primary',
        status: 'available',
      },
      {
        rootId: 'root-b',
        path: '/workspace/b',
        label: 'b',
        role: 'secondary',
        status: 'available',
      },
    ],
    digest: 'a'.repeat(64),
  };

  it('accepts only the identities sealed for every root', async () => {
    const expected = new Map([
      ['root-a', 'identity-a'],
      ['root-b', 'identity-b'],
    ]);
    await expect(
      verifyTurnWorkspaceIdentities(workspace, expected, async (path) => ({
        rootIdentityDigest: path.endsWith('/a') ? 'identity-a' : 'identity-b',
      })),
    ).resolves.toBeUndefined();
    await expect(
      verifyTurnWorkspaceIdentities(workspace, expected, async () => ({
        rootIdentityDigest: 'replacement',
      })),
    ).rejects.toThrow('identity changed');
  });

  it('fails closed when an identity is absent or a root cannot be read', async () => {
    await expect(
      verifyTurnWorkspaceIdentities(workspace, new Map([['root-a', 'identity-a']]), async () => ({
        rootIdentityDigest: 'identity-a',
      })),
    ).rejects.toThrow('identity set is incomplete');
    await expect(
      verifyTurnWorkspaceIdentities(
        workspace,
        new Map([
          ['root-a', 'identity-a'],
          ['root-b', 'identity-b'],
        ]),
        async () => {
          throw new Error('ENOENT');
        },
      ),
    ).rejects.toThrow('ENOENT');
  });
});

describe('root-aware file selection', () => {
  const workspace: EffectiveWorkspaceSet = {
    source: 'project',
    projectId: 'project-1',
    primaryRootId: 'root-a',
    roots: [
      {
        rootId: 'root-a',
        path: '/workspace/a',
        label: 'a',
        role: 'primary',
        status: 'available',
      },
      {
        rootId: 'root-b',
        path: '/workspace/b',
        label: 'b',
        role: 'secondary',
        status: 'available',
      },
    ],
    digest: 'b'.repeat(64),
  };

  it('selects an explicit Secondary and rejects unknown roots', () => {
    expect(resolveEffectiveWorkspaceRoot(workspace, 'root-b')?.path).toBe('/workspace/b');
    expect(resolveEffectiveWorkspaceRoot(workspace, 'not-a-root')).toBeNull();
  });

  it('maps replayed legacy requests only to the current Primary', () => {
    expect(resolveEffectiveWorkspaceRoot(workspace, 'legacy-primary')?.rootId).toBe('root-a');
  });
});

describe('Provider Team completion and model errors', () => {
  it('derives Leader MCP Team capability only from the sealed Team Turn contract', () => {
    expect(leaderMcpCapabilities(true)).toEqual({ allowTeamTools: true });
    expect(leaderMcpCapabilities(false)).toEqual({ allowTeamTools: false });
  });

  it('does not mislabel an external Provider model error as a Codex CLI error', () => {
    expect(invalidModelUserMessage('provider')).toBe(
      '選択したモデルは現在のProvider Connectionで利用できません。',
    );
    expect(invalidModelUserMessage('provider')).not.toContain('Codex CLI');
  });

  it('blocks only Team Leader completion while Team work remains unfinished', () => {
    expect(shouldBlockProviderLeaderCompletion(true, true)).toBe(true);
    expect(shouldBlockProviderLeaderCompletion(true, false)).toBe(false);
    expect(shouldBlockProviderLeaderCompletion(false, true)).toBe(false);
  });

  it('fails closed when an explicit Team turn completes without creating a Worker', () => {
    expect(shouldFailRequiredTeamTurn(true, 0)).toBe(true);
    expect(shouldFailRequiredTeamTurn(true, 1)).toBe(false);
    expect(shouldFailRequiredTeamTurn(false, 0)).toBe(false);
  });

  it('classifies missing required Workers as a policy failure, not a runtime protocol error', () => {
    expect(requiredTeamWorkerFailure(false, 0)).toBeNull();
    expect(requiredTeamWorkerFailure(true, 1)).toBeNull();
    expect(requiredTeamWorkerFailure(true, 0)).toEqual({
      code: 'RUNTIME_FAILED',
      userMessage:
        'Team MCP Workerが1名も作成されませんでした。外部のsubagent機能へfallbackせず終了します。',
      retryable: true,
    });
  });

  it('settles Provider completion through its real terminal adapter', async () => {
    const finishAndAdvance = vi.fn();
    const appendDelta = vi.fn(() => ({ type: 'message.delta' }));
    const publish = vi.fn();
    const fakeRouter = {
      teamCoordinator: { get: () => ({ workers: [] }) },
      persistence: { recordTurnProviderUsage: vi.fn(), appendDelta },
      mailbox: { run: async (_taskId: string, action: () => unknown) => action() },
      turnRuntimes: new Map([['turn-191', 'provider']]),
      finishAndAdvance,
      publish,
    };
    const completeProviderTeamTurn = Reflect.get(
      IpcRouter.prototype,
      'completeProviderTeamTurn',
    ) as (
      this: typeof fakeRouter,
      taskId: string,
      turnId: string,
      input: string,
      messageId: string,
      synthesizing: boolean,
      usage: undefined,
    ) => Promise<'completed' | 'failed'>;

    const diagnosticInput =
      'そもそもなぜsprint-coder-teamが使えないのか調査して。ログファイルを見て';
    await expect(
      completeProviderTeamTurn.call(
        fakeRouter,
        'task-191',
        'turn-191',
        diagnosticInput,
        'message-191',
        true,
        undefined,
      ),
    ).resolves.toBe('completed');
    expect(finishAndAdvance).toHaveBeenLastCalledWith('task-191', 'turn-191', 'completed');
    expect(appendDelta).not.toHaveBeenCalled();

    finishAndAdvance.mockClear();
    await expect(
      completeProviderTeamTurn.call(
        fakeRouter,
        'task-191',
        'turn-191',
        'Teamで原因を調査して',
        'message-191',
        true,
        undefined,
      ),
    ).resolves.toBe('failed');
    expect(appendDelta).toHaveBeenCalledWith(
      'task-191',
      'turn-191',
      'message-191',
      expect.stringContaining('Team MCP Workerが1名も作成されませんでした'),
    );
    expect(publish).toHaveBeenCalled();
    expect(finishAndAdvance).toHaveBeenLastCalledWith('task-191', 'turn-191', 'failed');
  });

  it('settles CLI canonical completion through its real terminal adapter', async () => {
    const finishAndAdvance = vi.fn();
    const handleRuntimeFailure = vi.fn();
    const teamRequiredTurns = new Set<string>();
    const fakeRouter = {
      teamRequiredTurns,
      teamCoordinator: { get: () => ({ workers: [] }) },
      resolvedModelByTurn: new Map<string, string>(),
      finishAndAdvance,
      handleRuntimeFailure,
    };
    const completeCanonicalTeamTurn = Reflect.get(
      IpcRouter.prototype,
      'completeCanonicalTeamTurn',
    ) as (
      this: typeof fakeRouter,
      kind: 'codex' | 'claude',
      taskId: string,
      turnId: string,
      resolvedModel: string | undefined,
      finalText: string | undefined,
    ) => Promise<'completed' | 'failed'>;

    const diagnosticInput =
      'そもそもなぜsprint-coder-teamが使えないのか調査して。ログファイルを見て';
    expect(requiresTeamWorkersInput(diagnosticInput)).toBe(false);
    await expect(
      completeCanonicalTeamTurn.call(
        fakeRouter,
        'codex',
        'task-191',
        'turn-191',
        'gpt-5.6-sol',
        '調査結果',
      ),
    ).resolves.toBe('completed');
    expect(finishAndAdvance).toHaveBeenLastCalledWith(
      'task-191',
      'turn-191',
      'completed',
      '調査結果',
    );
    expect(handleRuntimeFailure).not.toHaveBeenCalled();

    finishAndAdvance.mockClear();
    teamRequiredTurns.add('turn-191');
    await expect(
      completeCanonicalTeamTurn.call(
        fakeRouter,
        'codex',
        'task-191',
        'turn-191',
        undefined,
        '部分回答',
      ),
    ).resolves.toBe('failed');
    expect(finishAndAdvance).not.toHaveBeenCalled();
    expect(handleRuntimeFailure).toHaveBeenCalledWith(
      'codex',
      'task-191',
      'turn-191',
      expect.objectContaining({ code: 'RUNTIME_FAILED' }),
    );
    expect(handleRuntimeFailure).not.toHaveBeenCalledWith(
      'codex',
      'task-191',
      'turn-191',
      expect.objectContaining({ code: 'RUNTIME_PROTOCOL_ERROR' }),
    );
  });
});

describe('Provider workspace tool capability fallback', () => {
  it('records directory changes without treating them as Edit Saga assurance subjects', () => {
    const directory = {
      rootId: 'root-1',
      path: 'generated',
      state: 'committed',
      kind: 'add',
    } as const;
    const file = { ...directory, path: 'generated/file.ts', sagaId: 'saga-1' } as const;

    expect(isCommittedProviderWorkspaceChange(directory)).toBe(true);
    expect(isCommittedProviderWorkspaceMutation(directory)).toBe(false);
    expect(isCommittedProviderWorkspaceChange(file)).toBe(true);
    expect(isCommittedProviderWorkspaceMutation(file)).toBe(true);
  });

  it('publishes tools for supported or unknown protocols, but never explicit unsupported models', () => {
    expect(providerWorkspaceToolsEligible(false, 1, true)).toBe(true);
    expect(providerWorkspaceToolsEligible(false, 1, null)).toBe(true);
    expect(providerWorkspaceToolsEligible(false, 1, undefined)).toBe(true);
    expect(providerWorkspaceToolsEligible(false, 1, false)).toBe(false);
    expect(providerWorkspaceToolsEligible(true, 1, true)).toBe(false);
    expect(providerWorkspaceToolsEligible(false, 0, true)).toBe(false);
  });

  it('retries unknown capability exactly once without tools only on a side-effect-free invalid request', () => {
    const base = {
      ordinal: 1,
      workspaceToolsBound: true,
      toolCalling: null,
      errorCategory: 'invalid_request' as const,
      toolCallCount: 0,
      outputLength: 0,
    };
    expect(shouldRetryProviderWithoutTools(base)).toBe(true);
    expect(shouldRetryProviderWithoutTools({ ...base, ordinal: 2 })).toBe(false);
    expect(shouldRetryProviderWithoutTools({ ...base, toolCalling: true })).toBe(false);
    expect(shouldRetryProviderWithoutTools({ ...base, toolCallCount: 1 })).toBe(false);
    expect(shouldRetryProviderWithoutTools({ ...base, outputLength: 1 })).toBe(false);
    expect(shouldRetryProviderWithoutTools({ ...base, errorCategory: 'rate_limited' })).toBe(false);
  });

  it('preserves policy denial and upgrades only command allows to explicit approval', () => {
    expect(
      requireExplicitProviderCommandApproval({ decision: 'deny', reason: 'immutable_deny' }, true),
    ).toEqual({ decision: 'deny', reason: 'immutable_deny' });
    const beforeExecute = () => true;
    expect(
      requireExplicitProviderCommandApproval(
        { decision: 'allow', reason: 'preset_full', beforeExecute },
        true,
      ),
    ).toEqual({
      decision: 'approval_required',
      reason: 'provider_command_requires_explicit_approval',
      beforeExecute,
    });
  });
});

// Adversarial IPC hardening (Phase 7, IMPLEMENTATION_PLAN §10.4, NFR-SEC-03). Two independent
// properties are proven here without needing a live BrowserWindow/WebContents:
//
// 1. Sender/frame authenticity (`isTrustedIpcSender`) — the exact pure predicate `IpcRouter`'s
//    private `validateSender` delegates to (see ipc.ts). Electron's real IPC transport cannot be
//    driven headlessly in a unit test, so this predicate is extracted specifically so its logic
//    is directly testable; end-to-end wiring is exercised by the app's e2e suite through a real
//    window (owned by a concurrent workstream — not duplicated here).
// 2. Envelope/payload schema validation — the *exact* zod schemas `IpcRouter.handle`/
//    `handleMutation` feed every registered channel's payload through via
//    `commandEnvelopeSchema(inputSchema).parse(raw)`. `CHANNEL_INPUT_SCHEMAS` below mirrors each
//    `this.handle(...)`/`this.handleMutation(...)` registration in ipc.ts's `register()`; a meta
//    test asserts this map's key set never silently drifts out of sync with IPC_CHANNELS.

describe('isTrustedIpcSender', () => {
  const expected = { expectedSenderId: 7, trustedRendererOrigin: 'app://bundle' };

  it('trusts the exact window sender on its own top main frame at the pinned app:// origin', () => {
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: true, frameUrl: 'app://bundle/index.html' },
        expected,
      ),
    ).toBe(true);
  });

  it('rejects a different sender id (a foreign WebContents, e.g. a devtools or hidden window)', () => {
    expect(
      isTrustedIpcSender(
        { senderId: 99, isMainFrame: true, frameUrl: 'app://bundle/index.html' },
        expected,
      ),
    ).toBe(false);
  });

  it('rejects a null senderFrame (frame already destroyed / detached)', () => {
    expect(isTrustedIpcSender({ senderId: 7, isMainFrame: true, frameUrl: null }, expected)).toBe(
      false,
    );
  });

  it('rejects a non-top (child/iframe) frame even from the trusted sender id', () => {
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: false, frameUrl: 'app://bundle/index.html' },
        expected,
      ),
    ).toBe(false);
  });

  it('rejects an app:// URL at any host other than the pinned "bundle" host', () => {
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: true, frameUrl: 'app://evil/index.html' },
        expected,
      ),
    ).toBe(false);
  });

  it('rejects a dev-server origin string smuggled as an app:// URL', () => {
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: true, frameUrl: 'app://bundle.evil.test/index.html' },
        expected,
      ),
    ).toBe(false);
  });

  it('rejects an http(s) origin even when the host substring matches (no substring/prefix matching)', () => {
    const httpExpected = { expectedSenderId: 7, trustedRendererOrigin: 'http://localhost:5173' };
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: true, frameUrl: 'http://localhost:51730/' },
        httpExpected,
      ),
    ).toBe(false);
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: true, frameUrl: 'http://evil.test/?http://localhost:5173' },
        httpExpected,
      ),
    ).toBe(false);
  });

  it('rejects a scheme swap (https instead of the pinned app://) even with a matching host', () => {
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: true, frameUrl: 'https://bundle/index.html' },
        expected,
      ),
    ).toBe(false);
  });

  it('rejects a differing dev-server port (origin must match exactly)', () => {
    const httpExpected = { expectedSenderId: 7, trustedRendererOrigin: 'http://localhost:5173' };
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: true, frameUrl: 'http://localhost:5174/' },
        httpExpected,
      ),
    ).toBe(false);
  });

  it('denies (never throws) on a structurally unparsable frame URL', () => {
    expect(() =>
      isTrustedIpcSender({ senderId: 7, isMainFrame: true, frameUrl: 'not a url' }, expected),
    ).not.toThrow();
    expect(
      isTrustedIpcSender({ senderId: 7, isMainFrame: true, frameUrl: 'not a url' }, expected),
    ).toBe(false);
  });

  it('rejects a data: URL frame (never a legitimate renderer origin)', () => {
    expect(
      isTrustedIpcSender(
        { senderId: 7, isMainFrame: true, frameUrl: 'data:text/html,<h1>hi</h1>' },
        expected,
      ),
    ).toBe(false);
  });
});

// Mirrors ipc.ts `register()`'s `this.handle(IPC_CHANNELS.x, xInputSchema, ...)` /
// `this.handleMutation(IPC_CHANNELS.x, xInputSchema, ...)` calls exactly. teamsEvent, turnsPort and
// tasksUpdated, reasoningEvent, fileEditEvent and runtimeStatusEvent are push-only (webContents.send / MessagePort transfer) — they
// are never bound to an ipcMain.handle input schema, so they are deliberately excluded and
// asserted absent below.
const CHANNEL_INPUT_SCHEMAS: Record<string, z.ZodType> = {
  [IPC_CHANNELS.appGetInfo]: emptyPayloadSchema,
  [IPC_CHANNELS.runtimeFailureDiagnosticGet]: runtimeFailureDiagnosticQuerySchema,
  [IPC_CHANNELS.settingsGetRuntime]: emptyPayloadSchema,
  [IPC_CHANNELS.settingsSetRuntime]: runtimeSetInputSchema,
  [IPC_CHANNELS.settingsSetModel]: runtimeModelSetInputSchema,
  [IPC_CHANNELS.settingsSetEffort]: runtimeEffortSetInputSchema,
  [IPC_CHANNELS.settingsSkillsScan]: emptyPayloadSchema,
  [IPC_CHANNELS.settingsSkillsPreview]: skillCandidateInputSchema,
  [IPC_CHANNELS.settingsSkillsImport]: skillImportInputSchema,
  [IPC_CHANNELS.settingsSkillsUpdate]: skillImportInputSchema,
  [IPC_CHANNELS.settingsSkillsSetEnabled]: skillEnabledInputSchema,
  [IPC_CHANNELS.settingsSkillsRemove]: skillInstalledInputSchema,
  [IPC_CHANNELS.skillsList]: emptyPayloadSchema,
  [IPC_CHANNELS.skillsGetDraftSelection]: taskIdPayloadSchema,
  [IPC_CHANNELS.skillsSetDraftSelection]: taskSkillSelectionInputSchema,
  [IPC_CHANNELS.skillsListDrafts]: emptyPayloadSchema,
  [IPC_CHANNELS.skillsCreateDraft]: skillDraftCreateInputSchema,
  [IPC_CHANNELS.skillsInstallDraft]: skillDraftInstallInputSchema,
  [IPC_CHANNELS.skillsDiscardDraft]: skillDraftIdInputSchema,
  [IPC_CHANNELS.skillsRemoveCreated]: createdSkillMutationInputSchema,
  [IPC_CHANNELS.skillsSetCreatedEnabled]: createdSkillEnabledInputSchema,
  [IPC_CHANNELS.skillsExportCreated]: createdSkillMutationInputSchema,
  [IPC_CHANNELS.filesList]: taskIdPayloadSchema,
  [IPC_CHANNELS.filesPick]: taskIdPayloadSchema,
  [IPC_CHANNELS.filesOpen]: filePathPayloadSchema,
  [IPC_CHANNELS.filesRecover]: filePathPayloadSchema,
  [IPC_CHANNELS.filesSave]: fileSaveInputSchema,
  [IPC_CHANNELS.imagesList]: taskIdPayloadSchema,
  [IPC_CHANNELS.imagesRead]: generatedImageRefSchema,
  [IPC_CHANNELS.attachmentsCapability]: taskIdPayloadSchema,
  [IPC_CHANNELS.attachmentsPick]: taskIdPayloadSchema,
  [IPC_CHANNELS.attachmentsListDraft]: taskIdPayloadSchema,
  [IPC_CHANNELS.attachmentsRemove]: imageAttachmentRemoveInputSchema,
  [IPC_CHANNELS.settingsSetCodexEffort]: runtimeCodexEffortSetInputSchema,
  [IPC_CHANNELS.modelsCatalogQuery]: modelCatalogQueryInputSchema,
  [IPC_CHANNELS.modelsSetSelection]: modelCatalogSelectionSetInputSchema,
  [IPC_CHANNELS.providersListConnections]: emptyPayloadSchema,
  [IPC_CHANNELS.providersListProfiles]: emptyPayloadSchema,
  [IPC_CHANNELS.providersCreateOpenAIConnection]: openAIConnectionCreateInputSchema,
  [IPC_CHANNELS.providersCreateOpenRouterConnection]: openRouterConnectionCreateInputSchema,
  [IPC_CHANNELS.providersCreateAnthropicConnection]: anthropicConnectionCreateInputSchema,
  [IPC_CHANNELS.providersCreateGeminiConnection]: geminiConnectionCreateInputSchema,
  [IPC_CHANNELS.providersCreateXAIConnection]: xAIConnectionCreateInputSchema,
  [IPC_CHANNELS.providersCreateProfileConnection]: providerProfileConnectionCreateInputSchema,
  [IPC_CHANNELS.providersVerifyConnection]: z.object({ connectionId: connectionIdSchema }).strict(),
  [IPC_CHANNELS.providersLowerRateLimits]: providerConnectionRateLimitLowerInputSchema,
  [IPC_CHANNELS.providersSetAutomaticModelRelease]: providerConnectionModelReleaseUpdateInputSchema,
  [IPC_CHANNELS.permissionsGet]: taskIdPayloadSchema,
  [IPC_CHANNELS.permissionsListAutoDecisions]: taskIdPayloadSchema,
  [IPC_CHANNELS.permissionsSet]: permissionSetInputSchema,
  [IPC_CHANNELS.approvalsListPending]: taskIdPayloadSchema,
  [IPC_CHANNELS.approvalsListRecent]: taskIdPayloadSchema,
  [IPC_CHANNELS.approvalsResolve]: approvalResolveInputSchema,
  [IPC_CHANNELS.commandsList]: taskIdPayloadSchema,
  [IPC_CHANNELS.commandsOutputPage]: commandOutputPageInputSchema,
  [IPC_CHANNELS.commandsOutputTail]: commandOutputTailInputSchema,
  [IPC_CHANNELS.tasksList]: emptyPayloadSchema,
  [IPC_CHANNELS.tasksCreate]: taskCreateInputSchema,
  [IPC_CHANNELS.tasksMessages]: taskIdPayloadSchema,
  [IPC_CHANNELS.tasksRename]: taskRenameInputSchema,
  [IPC_CHANNELS.tasksSetPinned]: taskPinnedInputSchema,
  [IPC_CHANNELS.tasksSetArchived]: taskArchivedInputSchema,
  [IPC_CHANNELS.tasksSetGoal]: taskGoalInputSchema,
  [IPC_CHANNELS.goalsStart]: goalStartInputSchema,
  [IPC_CHANNELS.goalsPause]: goalControlInputSchema,
  [IPC_CHANNELS.goalsResume]: goalResumeInputSchema,
  [IPC_CHANNELS.goalsClear]: goalControlInputSchema,
  [IPC_CHANNELS.tasksGetDraft]: taskIdPayloadSchema,
  [IPC_CHANNELS.tasksSetDraft]: taskDraftInputSchema,
  [IPC_CHANNELS.projectsList]: emptyPayloadSchema,
  [IPC_CHANNELS.projectsPickFolders]: emptyPayloadSchema,
  [IPC_CHANNELS.projectsFoldersList]: projectFoldersListInputSchema,
  [IPC_CHANNELS.projectsFoldersReplace]: projectFoldersReplaceInputSchema,
  [IPC_CHANNELS.projectsGet]: projectGetInputSchema,
  [IPC_CHANNELS.projectsSetInstruction]: projectInstructionSetInputSchema,
  [IPC_CHANNELS.projectsListContextManifests]: projectContextManifestsListInputSchema,
  [IPC_CHANNELS.projectsGetContextManifest]: projectContextManifestGetInputSchema,
  [IPC_CHANNELS.projectsReferencesList]: projectReferencesListInputSchema,
  [IPC_CHANNELS.projectsReferencesPick]: projectReferencePickInputSchema,
  [IPC_CHANNELS.projectsReferencesAdd]: projectReferenceAddInputSchema,
  [IPC_CHANNELS.projectsReferencesUpdate]: projectReferenceUpdateInputSchema,
  [IPC_CHANNELS.projectsReferencesRemove]: projectReferenceRemoveInputSchema,
  [IPC_CHANNELS.projectsMemoriesList]: projectMemoriesListInputSchema,
  [IPC_CHANNELS.projectsMemoriesCreate]: projectMemoryCreateInputSchema,
  [IPC_CHANNELS.projectsMemoriesUpdate]: projectMemoryUpdateInputSchema,
  [IPC_CHANNELS.projectsCreate]: projectCreateInputSchema,
  [IPC_CHANNELS.projectsUpdate]: projectUpdateInputSchema,
  [IPC_CHANNELS.projectsAssignTask]: projectAssignTaskInputSchema,
  [IPC_CHANNELS.projectsUnassignTask]: projectUnassignTaskInputSchema,
  [IPC_CHANNELS.teamsPromote]: taskIdPayloadSchema,
  [IPC_CHANNELS.teamsGet]: taskIdPayloadSchema,
  [IPC_CHANNELS.teamsUpdatePolicy]: teamPolicyUpdateInputSchema,
  [IPC_CHANNELS.teamsHireWorker]: teamHireWorkerInputSchema,
  [IPC_CHANNELS.teamsResumeMission]: teamResumeMissionInputSchema,
  [IPC_CHANNELS.teamsResumeExecutionIntegration]: teamResumeExecutionIntegrationInputSchema,
  [IPC_CHANNELS.teamsSend]: teamSendMessageInputSchema,
  [IPC_CHANNELS.teamsStopWorker]: teamWorkerRefSchema,
  [IPC_CHANNELS.teamsStopAll]: taskIdPayloadSchema,
  [IPC_CHANNELS.teamsSubscribe]: teamSubscriptionInputSchema,
  [IPC_CHANNELS.teamsUnsubscribe]: teamSubscriptionInputSchema,
  [IPC_CHANNELS.teamsGetCanvasView]: taskIdPayloadSchema,
  [IPC_CHANNELS.teamsSaveCanvasView]: canvasViewSaveInputSchema,
  [IPC_CHANNELS.workspaceGet]: taskIdPayloadSchema,
  [IPC_CHANNELS.workspaceGetEffective]: taskIdPayloadSchema,
  [IPC_CHANNELS.workspaceSelect]: taskIdPayloadSchema,
  [IPC_CHANNELS.settingsGetCodexUserConfig]: emptyPayloadSchema,
  [IPC_CHANNELS.settingsSetCodexUserConfig]: codexUserConfigSettingsSetInputSchema,
  [IPC_CHANNELS.settingsGetTeamModelResearch]: emptyPayloadSchema,
  [IPC_CHANNELS.settingsSetTeamModelResearch]: teamModelResearchSettingsSetInputSchema,
  [IPC_CHANNELS.settingsGetTeamModelSelectionGuidance]: emptyPayloadSchema,
  [IPC_CHANNELS.settingsSetTeamModelSelectionGuidance]: teamModelSelectionGuidanceSetInputSchema,
  [IPC_CHANNELS.settingsGetSprintCoderPrePrompt]: emptyPayloadSchema,
  [IPC_CHANNELS.settingsSetSprintCoderPrePrompt]: sprintCoderPrePromptSetInputSchema,
  [IPC_CHANNELS.settingsGetTeamModelSettings]: emptyPayloadSchema,
  [IPC_CHANNELS.settingsSetTeamModelRestriction]: teamModelRestrictionSetInputSchema,
  [IPC_CHANNELS.settingsGetDefaultTeamPolicy]: emptyPayloadSchema,
  [IPC_CHANNELS.settingsSetDefaultTeamPolicy]: teamPolicySchema,
  [IPC_CHANNELS.turnsStart]: turnStartInputSchema,
  [IPC_CHANNELS.turnsQueue]: turnQueueInputSchema,
  [IPC_CHANNELS.turnsSteer]: turnSteerInputSchema,
  [IPC_CHANNELS.turnsStopAndSend]: turnStopAndSendInputSchema,
  [IPC_CHANNELS.turnsCancel]: turnCancelInputSchema,
  [IPC_CHANNELS.turnsSnapshot]: taskIdPayloadSchema,
  [IPC_CHANNELS.turnsSubscribe]: turnSubscriptionInputSchema,
};
const PUSH_ONLY_CHANNELS = new Set<string>([
  IPC_CHANNELS.tasksUpdated,
  IPC_CHANNELS.teamsEvent,
  IPC_CHANNELS.turnsPort,
  IPC_CHANNELS.reasoningEvent,
  IPC_CHANNELS.fileEditEvent,
  IPC_CHANNELS.runtimeStatusEvent,
]);

describe('IPC channel registry stays in sync with the adversarial fuzz table', () => {
  it('covers every IPC_CHANNELS entry exactly once, split between handled and push-only', () => {
    const allChannels = new Set(Object.values(IPC_CHANNELS));
    const handled = new Set(Object.keys(CHANNEL_INPUT_SCHEMAS));
    for (const channel of allChannels) {
      const isHandled = handled.has(channel);
      const isPushOnly = PUSH_ONLY_CHANNELS.has(channel);
      expect(isHandled !== isPushOnly).toBe(true);
    }
    expect(handled.size + PUSH_ONLY_CHANNELS.size).toBe(allChannels.size);
  });
});

describe('every registered IPC channel rejects adversarial envelopes', () => {
  const channels = Object.entries(CHANNEL_INPUT_SCHEMAS);

  it.each(channels)(
    'parses a well-formed minimal envelope shape check for %s (schema is invocable)',
    (_channel, schema) => {
      // Not every schema accepts `{}` — this just proves `commandEnvelopeSchema` composes with
      // each registered schema without throwing during construction (a broken schema composition
      // would throw here, before any adversarial input is even tried).
      expect(() => commandEnvelopeSchema(schema)).not.toThrow();
    },
  );

  it.each(channels)(
    'rejects a prototype-pollution-shaped envelope for %s without polluting Object.prototype',
    (_channel, schema) => {
      const envelopeSchema = commandEnvelopeSchema(schema);
      // Simulates the real IPC wire shape: JSON.parse gives "__proto__"/"constructor" as ordinary
      // own-enumerable string keys (never the special object-literal prototype setter), which is
      // exactly what a hostile renderer or a compromised preload would actually transmit.
      const hostile = JSON.parse(
        JSON.stringify({
          requestId: 'r1',
          operationId: 'o1',
          taskId: 'polluted-task',
          payload: {
            __proto__: { polluted: true },
            constructor: { prototype: { polluted: true } },
          },
        }),
      ) as unknown;

      const result = envelopeSchema.safeParse(hostile);
      expect(result.success).toBe(false);
      expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    },
  );

  it.each(channels)(
    'rejects an oversized requestId/operationId for %s (envelope-level bound applies to every channel)',
    (_channel, schema) => {
      const envelopeSchema = commandEnvelopeSchema(schema);
      const oversized = 'x'.repeat(1_000_000);

      expect(
        envelopeSchema.safeParse({ requestId: oversized, operationId: 'o1', payload: {} }).success,
      ).toBe(false);
      expect(
        envelopeSchema.safeParse({ requestId: 'r1', operationId: oversized, payload: {} }).success,
      ).toBe(false);
    },
  );

  it.each(channels)(
    'rejects wrong-typed envelope fields for %s (number/array/null instead of string/object)',
    (_channel, schema) => {
      const envelopeSchema = commandEnvelopeSchema(schema);

      expect(
        envelopeSchema.safeParse({ requestId: 12345, operationId: 'o1', payload: {} }).success,
      ).toBe(false);
      expect(
        envelopeSchema.safeParse({ requestId: 'r1', operationId: ['array'], payload: {} }).success,
      ).toBe(false);
      expect(
        envelopeSchema.safeParse({ requestId: 'r1', operationId: 'o1', payload: null }).success,
      ).toBe(false);
      expect(
        envelopeSchema.safeParse({ requestId: 'r1', operationId: 'o1', payload: 'a string' })
          .success,
      ).toBe(false);
      expect(
        envelopeSchema.safeParse({ requestId: 'r1', operationId: 'o1', payload: [1, 2, 3] })
          .success,
      ).toBe(false);
    },
  );

  it.each(channels)(
    'rejects a completely missing payload/envelope for %s rather than crashing',
    (_channel, schema) => {
      const envelopeSchema = commandEnvelopeSchema(schema);

      for (const garbage of [undefined, null, 'a string', 42, [], true, () => undefined]) {
        expect(() => envelopeSchema.safeParse(garbage)).not.toThrow();
        expect(envelopeSchema.safeParse(garbage).success).toBe(false);
      }
    },
  );

  it.each(channels)(
    'never throws synchronously for %s on a deeply nested or cyclic-looking adversarial payload',
    (_channel, schema) => {
      const envelopeSchema = commandEnvelopeSchema(schema);
      let deep: unknown = 'leaf';
      for (let index = 0; index < 2_000; index += 1) deep = { nested: deep };
      const throwingGetterPayload = {};
      Object.defineProperty(throwingGetterPayload, 'boom', {
        enumerable: true,
        get(): never {
          throw new Error('adversarial getter');
        },
      });

      expect(() =>
        envelopeSchema.safeParse({ requestId: 'r1', operationId: 'o1', payload: deep }),
      ).not.toThrow();
      // A throwing getter on the payload is allowed to surface as a thrown error (zod must read
      // the property to validate it) — the contract here is only that the envelope schema itself
      // does not corrupt state or hang; callers (ipc.ts's `handle`) already wrap the whole parse in
      // try/catch and convert any thrown error into a typed PublicError.
      expect(() =>
        envelopeSchema.safeParse({
          requestId: 'r1',
          operationId: 'o1',
          payload: throwingGetterPayload,
        }),
      ).not.toThrow(RangeError);
    },
  );

  it.each(channels)(
    'rejects an extra unrecognized top-level envelope key for %s (strict envelope)',
    (_channel, schema) => {
      const envelopeSchema = commandEnvelopeSchema(schema);
      expect(
        envelopeSchema.safeParse({
          requestId: 'r1',
          operationId: 'o1',
          payload: {},
          extraHostileField: 'smuggled',
        }).success,
      ).toBe(false);
    },
  );
});

describe('taskId cross-check adversarial cases (mirrors ipc.ts handle() hasTaskId guard)', () => {
  it('a taskId-bearing payload schema rejects a payload/envelope taskId mismatch at the payload level already via its own field validation', () => {
    // hasTaskId()/the envelope.taskId !== envelope.payload.taskId check in ipc.ts's `handle()`
    // is exercised end-to-end by the app's e2e suite (needs a live IpcRouter+BrowserWindow); this
    // asserts the schema-level precondition it depends on: payload.taskId is always the strict
    // idSchema, so it cannot be smuggled as an object, array, or oversized string either.
    const envelopeSchema = commandEnvelopeSchema(taskIdPayloadSchema);
    expect(
      envelopeSchema.safeParse({
        requestId: 'r1',
        operationId: 'o1',
        taskId: 'task-a',
        payload: { taskId: { nested: 'task-b' } },
      }).success,
    ).toBe(false);
  });
});

describe('clampCodexEffort (issue #6)', () => {
  // The valid reasoning levels are per-model and published by the CLI in models_cache.json, and
  // Codex does NOT degrade gracefully — an unsupported level makes the API answer 400 and
  // `codex exec` exit 1, killing the whole turn. So a stored level has to be narrowed to the
  // selected model's advertised set before it can ever reach the CLI.
  const models = [
    { id: 'auto', displayName: 'Auto', description: '' },
    {
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6-Sol',
      description: '',
      defaultEffort: 'low',
      efforts: [
        { id: 'low', description: '' },
        { id: 'high', description: '' },
        { id: 'ultra', description: '' },
      ],
    },
    {
      id: 'gpt-5.5',
      displayName: 'GPT-5.5',
      description: '',
      defaultEffort: 'medium',
      efforts: [
        { id: 'low', description: '' },
        { id: 'medium', description: '' },
        { id: 'high', description: '' },
      ],
    },
    { id: 'no-levels', displayName: 'No Levels', description: '' },
  ];

  it('keeps a level the selected model advertises', () => {
    expect(clampCodexEffort('ultra', models, 'gpt-5.6-sol')).toBe('ultra');
    expect(clampCodexEffort('medium', models, 'gpt-5.5')).toBe('medium');
  });

  it("falls back to the model's own default when the stored level is unsupported", () => {
    // The real regression this guards: raise effort to `ultra` on Sol, switch to GPT-5.5, send.
    // Passing `ultra` through would fail the turn outright.
    expect(clampCodexEffort('ultra', models, 'gpt-5.5')).toBe('medium');
  });

  it('sends no override for the auto sentinel', () => {
    // The CLI picks the concrete model itself, so there is no advertised set to validate against
    // and its own per-model default is the right thing to leave in place.
    expect(clampCodexEffort('ultra', models, 'auto')).toBe('');
  });

  it('sends no override for a model that publishes no levels, or an unknown model', () => {
    expect(clampCodexEffort('high', models, 'no-levels')).toBe('');
    expect(clampCodexEffort('high', models, 'never-heard-of-it')).toBe('');
    expect(clampCodexEffort('high', [], 'gpt-5.5')).toBe('');
  });

  it('passes an empty stored level straight through', () => {
    expect(clampCodexEffort('', models, 'gpt-5.6-sol')).toBe('');
  });
});
