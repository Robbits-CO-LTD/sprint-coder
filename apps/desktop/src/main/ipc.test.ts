import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
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
  imageAttachmentPreviewInputSchema,
  imageAttachmentRemoveInputSchema,
  installedLocalModelInputSchema,
  managedLocalLaunchSettingsGetInputSchema,
  managedLocalLaunchSettingsSetInputSchema,
  managedLocalInferenceSettingsGetInputSchema,
  managedLocalInferenceSettingsSetInputSchema,
  localDownloadCancelInputSchema,
  localDownloadJobInputSchema,
  localModelInstallInputSchema,
  localModelFitInputSchema,
  modelCatalogQueryInputSchema,
  modelCatalogSelectionSetInputSchema,
  openAIConnectionCreateInputSchema,
  openRouterConnectionCreateInputSchema,
  orcaRouterConnectionCreateInputSchema,
  permissionSetInputSchema,
  providerConnectionRateLimitLowerInputSchema,
  providerConnectionModelReleaseUpdateInputSchema,
  providerProfileConnectionCreateInputSchema,
  publicModelCatalogDetailInputSchema,
  publicModelCatalogQuerySchema,
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
  skillDraftCreateInputSchema,
  skillDraftIdInputSchema,
  skillDraftInstallInputSchema,
  createdSkillEnabledInputSchema,
  skillActivationPolicyInputSchema,
  skillExportInputSchema,
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
  authorizationTurnIsActive,
  invalidModelUserMessage,
  isCommittedProviderWorkspaceChange,
  isCommittedProviderWorkspaceMutation,
  isCompleteProviderWorkspaceRead,
  isTrustedIpcSender,
  leaderMcpCapabilities,
  listAvailableTeamRuntimeModels,
  managedLocalForcedRoundMessages,
  managedLocalInitialToolChoice,
  managedLocalToolChoiceSequence,
  managedLocalWorkspaceToolUseRequired,
  shouldBlockProviderLeaderCompletion,
  providerWorkspaceToolsEligible,
  providerModelsForBuiltin,
  providerMessagesFromContext,
  providerMessagesForEgressPolicy,
  providerEventsWithSafeFailure,
  providerWorkspaceToolFailure,
  requireExplicitProviderCommandApproval,
  requiredTeamWorkerFailure,
  shouldRetryProviderWithoutTools,
  shouldFailRequiredTeamTurn,
  requiresHomeDirectoryConfirmation,
  runBestEffortCancellation,
  sandboxProfileForToolAuthorization,
  shouldStartNextQueuedAfterCancel,
  resolveEffectiveWorkspaceRoot,
  verifyTurnWorkspaceIdentities,
  toPublicError,
} from './ipc';

import { ModelCatalogService } from './model-catalog-service';
import {
  canonicalizeProviderToolImage,
  ImageAttachmentValidationError,
} from './image-attachment-store';
import { ImageAttachmentAcceptanceError, ImageAttachmentLimitError } from './persistence';
import {
  buildImageAttachmentSelectionIdentity,
  buildProviderImageAttachmentSelectionIdentity,
  imageAttachmentSelectionIdentityDigest,
  type ImageAttachmentRuntimeSnapshot,
} from './image-attachment-capability';
import { BUILTIN_CODEX_CONNECTION_ID } from './connection-identity';
import { requiresTeamWorkersInput } from './team-tools';
import { RuntimeFailureDiagnosticCollector } from '../runtime-host/runtime-failure-diagnostics';
import { secureLogger } from './secure-logger';
import { SPRINT_CODER_IDENTITY_PROMPT } from './context-ledger';
import { SkillSettingsError } from './skill-settings-service';
import { ToolImageBridge } from './tool-image-bridge';
import { ProviderEndpointPolicy } from './provider-endpoint-policy';
import { digestCanonical } from './context-compiler';
import { openAICompatibleChatCompletionRequest } from './openai-compatible-provider-client';
import { managedLocalConnection } from './managed-local-provider-runtime';
import sharp from 'sharp';

describe('file edit tracking identity', () => {
  it('deduplicates Windows relative paths that differ only by casing', () => {
    expect(fileEditTrackingKey('turn', 'root', 'Src/App.ts', 'win32')).toBe(
      fileEditTrackingKey('turn', 'root', 'src/app.ts', 'win32'),
    );
  });
});

describe('Provider Skill Draft failures', () => {
  it('preserves bounded public Skill validation details for the model', () => {
    expect(
      JSON.parse(
        providerWorkspaceToolFailure(
          new SkillSettingsError('INVALID_SKILL', 'skillId: Invalid input'),
        ),
      ),
    ).toEqual({
      ok: false,
      error: { code: 'INVALID_SKILL', message: 'skillId: Invalid input' },
    });

    const bounded = JSON.parse(
      providerWorkspaceToolFailure(new SkillSettingsError('INVALID_SKILL', 'x'.repeat(600))),
    ) as { error: { message: string } };
    expect(bounded.error.message.length).toBeLessThanOrEqual(500);
    expect(bounded.error.message.endsWith('…')).toBe(true);

    const redacted = providerWorkspaceToolFailure(
      new SkillSettingsError('INVALID_SKILL', 'token=FAKE_PRIVATE_CANARY'),
    );
    expect(redacted).not.toContain('FAKE_PRIVATE_CANARY');
  });

  it('keeps unexpected validation failures generic', () => {
    const log = vi.spyOn(secureLogger, 'error').mockImplementation(() => undefined);
    try {
      const content = providerWorkspaceToolFailure(
        new Error('C:\\Users\\example\\private\\secret.txt token=FAKE_PRIVATE_CANARY'),
      );
      expect(content).toContain('Workspace tool execution failed');
      expect(content).not.toContain('secret.txt');
      expect(content).not.toContain('FAKE_PRIVATE_CANARY');
    } finally {
      log.mockRestore();
    }
  });
});

describe('tool authorization sandbox profiles', () => {
  it('records unsandboxed command runners as full so Task grants can be revalidated', () => {
    expect(sandboxProfileForToolAuthorization('command-runner', 'shell.execute')).toBe('full');
    expect(sandboxProfileForToolAuthorization('built-in', 'workspace.write')).toBe(
      'workspace-write',
    );
    expect(sandboxProfileForToolAuthorization('built-in', 'workspace.read')).toBe('read-only');
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
    {
      id: 'skill-catalog',
      source: 'background' as const,
      trust: 'assistant' as const,
      authority: 'none' as const,
      content: '{"schema":"sprint-coder.skill-catalog.v1","authority":"none"}',
    },
  ];

  it('removes selected Skill bodies from Codex application context only', () => {
    expect(contextFragmentsForRuntime('codex', fragments).map(({ id }) => id)).toEqual([
      'system',
      'skill-catalog',
    ]);
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
    catalog.replaceCatalog(builtinModels, new Map([['builtin:codex-cli', 'subscription']]));
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

  it('keeps queued input dormant when Team stop-all cancels its Leader', () => {
    expect(shouldStartNextQueuedAfterCancel(false, true, true)).toBe(false);
    expect(shouldStartNextQueuedAfterCancel(undefined, true, true)).toBe(true);
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
      userMessage: '選択中の接続またはモデルでは画像添付を送信できません。',
      retryable: false,
    });
    expect(toPublicError(new ImageAttachmentAcceptanceError('stale'))).toEqual({
      code: 'INVALID_REQUEST',
      userMessage: '画像添付の状態が変わりました。最新の一覧を確認してください。',
      retryable: false,
    });
  });
});

describe('Skill Draft public errors', () => {
  it('clips actionable validation details to the public message limit', () => {
    const result = toPublicError(new SkillSettingsError('INVALID_SKILL', 'x'.repeat(600)));

    expect(result.code).toBe('INVALID_REQUEST');
    expect(result.userMessage).toHaveLength(500);
    expect(result.userMessage.endsWith('…')).toBe(true);
    expect(result.retryable).toBe(false);
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
        [turnId, Object.freeze({ kind: 'codex_cli', snapshot, selectionIdentity })],
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

  it('projects accepted Provider images once in DB order without exposing bytes to policy scan', async () => {
    const taskId = 'task-provider-image';
    const turnId = 'turn-provider-image';
    const selection = {
      taskId,
      runtimeKind: 'codex' as const,
      model: 'gpt-5',
      modelSelection: {
        connectionId: 'ollama:local',
        requestedProvider: 'ollama',
        requestedModel: 'gemma4:12b',
      },
    };
    const snapshot = {
      runtimeKind: 'provider' as const,
      connectionId: 'ollama:local',
      providerId: 'ollama',
      modelId: 'gemma4:12b',
      value: true,
      revision: 'vision-revision-1',
      capturedAtMs: Date.now(),
    };
    const selectionIdentity = imageAttachmentSelectionIdentityDigest(
      buildProviderImageAttachmentSelectionIdentity(selection, snapshot)!,
    );
    const attachments = [
      {
        id: 'image-a',
        fileName: 'a.png',
        mimeType: 'image/png' as const,
        byteLength: 3,
        sha256: 'a'.repeat(64),
        bytes: Buffer.from('one'),
        createdAt: '2026-08-22T00:00:00.000Z',
      },
      {
        id: 'image-b',
        fileName: 'b.webp',
        mimeType: 'image/webp' as const,
        byteLength: 3,
        sha256: 'b'.repeat(64),
        bytes: Buffer.from('two'),
        createdAt: '2026-08-22T00:00:01.000Z',
      },
    ];
    const current = { ...snapshot, capturedAtMs: Date.now() };
    const captureProviderImageAttachmentCapability = vi.fn().mockResolvedValue(current);
    const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    Object.assign(router, {
      persistence: {
        getAcceptedImageAttachments: vi.fn().mockReturnValue(attachments),
        getImageAttachmentAcceptanceSelection: vi.fn().mockReturnValue(selection),
      },
      attachmentCapabilityByTurn: new Map([
        [
          turnId,
          Object.freeze({
            kind: 'provider_inline',
            snapshot,
            selectionIdentity,
          }),
        ],
      ]),
      captureProviderImageAttachmentCapability,
    });
    const probe = router as unknown as {
      prepareProviderTurnImageAttachments(
        started: unknown,
        connection: unknown,
      ): {
        binding: unknown;
        inlineImages: Array<{
          mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
          base64: string;
        }>;
        auditImages: Array<{
          id?: string;
          mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
          byteLength: number;
          sha256: string;
        }>;
        manifestDigest: string;
        byteCount: number;
      };
      providerImageAttachmentStillValid(
        started: unknown,
        connection: unknown,
        binding: unknown,
        signal: AbortSignal,
      ): Promise<boolean>;
    };
    const started = {
      turnId,
      event: { taskId },
      modelSelection: selection.modelSelection,
    };
    const connection = { id: 'ollama:local', providerId: 'ollama' };

    const prepared = probe.prepareProviderTurnImageAttachments(started, connection);

    expect(prepared.inlineImages).toEqual([
      { mimeType: 'image/png', base64: Buffer.from('one').toString('base64') },
      { mimeType: 'image/webp', base64: Buffer.from('two').toString('base64') },
    ]);
    expect(prepared.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.byteCount).toBe(6);
    expect(prepared.auditImages).toEqual([
      { id: 'image-a', mimeType: 'image/png', byteLength: 3, sha256: 'a'.repeat(64) },
      { id: 'image-b', mimeType: 'image/webp', byteLength: 3, sha256: 'b'.repeat(64) },
    ]);
    expect(JSON.stringify(prepared.auditImages)).not.toContain('b25l');
    await expect(
      probe.providerImageAttachmentStillValid(
        started,
        connection,
        prepared.binding,
        new AbortController().signal,
      ),
    ).resolves.toBe(true);
    captureProviderImageAttachmentCapability.mockResolvedValueOnce({
      ...current,
      revision: 'vision-revision-2',
    });
    await expect(
      probe.providerImageAttachmentStillValid(
        started,
        connection,
        prepared.binding,
        new AbortController().signal,
      ),
    ).resolves.toBe(false);

    const messages = [
      {
        role: 'user' as const,
        content: 'describe these images',
        inlineImages: prepared.inlineImages,
      },
    ];
    const policyProjection = JSON.stringify(providerMessagesForEgressPolicy(messages));
    expect(policyProjection).toContain('describe these images');
    expect(policyProjection).toContain('redacted-image-bytes');
    for (const image of prepared.inlineImages) expect(policyProjection).not.toContain(image.base64);
    expect(messages[0]?.inlineImages).toEqual(prepared.inlineImages);

    const contextMessages = providerMessagesFromContext(
      [
        {
          id: 'past',
          taskId,
          source: 'history',
          trust: 'user',
          tokenEstimate: 1,
          content: 'past user message',
          createdAt: '2026-08-22T00:00:00.000Z',
          messageId: 'message-past',
        },
        {
          id: 'current',
          taskId,
          source: 'history',
          trust: 'user',
          tokenEstimate: 1,
          content: 'current user message',
          createdAt: '2026-08-22T00:00:01.000Z',
          messageId: 'message-current',
        },
        {
          id: 'background',
          taskId,
          source: 'background',
          trust: 'assistant',
          tokenEstimate: 1,
          content: 'untrusted background',
          createdAt: '2026-08-22T00:00:02.000Z',
          messageId: null,
        },
      ],
      'message-current',
      prepared.inlineImages,
    );
    expect(contextMessages.filter((message) => message.inlineImages !== undefined)).toEqual([
      expect.objectContaining({
        content: 'current user message',
        inlineImages: prepared.inlineImages,
      }),
    ]);
    expect(() => providerMessagesFromContext([], 'message-current', prepared.inlineImages)).toThrow(
      'Provider image attachment binding is stale',
    );
  });

  it('rejects an initially non-OpenAI-compatible tool image connection', () => {
    const taskId = 'task-tool-image-model-drift';
    const startedSelection = {
      connectionId: 'connection-official',
      requestedProvider: 'openai',
      requestedModel: 'qwen3-vl:4b-instruct-q4_K_M',
    };
    const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    Object.assign(router, {
      persistence: {
        getProviderConnection: vi.fn().mockReturnValue({
          id: startedSelection.connectionId,
          providerId: startedSelection.requestedProvider,
          runtimeKind: 'official_api',
          displayName: 'Official API',
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
        }),
        getTaskModelSelection: vi.fn().mockReturnValue(startedSelection),
      },
    });
    const probe = router as unknown as {
      readProviderToolImageState(started: unknown, connectionId: string, modelId: string): unknown;
    };

    expect(
      probe.readProviderToolImageState(
        { event: { taskId }, modelSelection: startedSelection },
        startedSelection.connectionId,
        startedSelection.requestedModel,
      ),
    ).toBeNull();
  });

  it('rejects a pre-aborted Provider image capability probe before touching runtime state', async () => {
    const controller = new AbortController();
    controller.abort(new Error('turn already canceled'));
    const getProviderConnection = vi.fn();
    const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    Object.assign(router, { persistence: { getProviderConnection } });
    const probe = router as unknown as {
      captureProviderImageAttachmentCapability(
        selection: unknown,
        signal: AbortSignal,
      ): Promise<unknown>;
    };

    await expect(
      probe.captureProviderImageAttachmentCapability(
        {
          taskId: 'task-pre-aborted-image-capability',
          runtimeKind: 'provider',
          model: 'vision-model',
          modelSelection: {
            connectionId: 'ollama:pre-aborted',
            requestedProvider: 'ollama',
            requestedModel: 'vision-model',
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow('turn already canceled');
    expect(getProviderConnection).not.toHaveBeenCalled();
  });

  it('binds only the exact verified loopback connection used by the executing round', async () => {
    const taskId = 'task-tool-image-loopback';
    const baseUrl = 'http://127.0.0.1:11434/v1';
    const endpointPolicy = new ProviderEndpointPolicy();
    const endpointDigest = endpointPolicy.digestForBaseUrl(baseUrl);
    const selection = {
      connectionId: 'ollama:loopback',
      requestedProvider: 'ollama',
      requestedModel: 'qwen3-vl:4b-instruct-q4_K_M',
    };
    const connection = {
      id: selection.connectionId,
      providerId: selection.requestedProvider,
      runtimeKind: 'openai_compatible' as const,
      displayName: 'Ollama loopback',
      enabled: true,
      secretReference: 'provider-secret:00000000-0000-4000-8000-000000000000',
      verification: {
        status: 'verified' as const,
        verifiedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        message: null,
      },
      rateLimit: {
        mode: 'auto' as const,
        maxConcurrentRequests: null,
        requestsPerMinute: null,
        tokensPerMinute: null,
        lastObservedRateLimitHeaders: null,
      },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const profile = {
      id: 'ollama',
      displayName: 'Ollama',
      baseUrl,
      baseUrlConfigurable: true,
      computeLocation: 'local' as const,
      nativeModelLifecycle: 'ollama' as const,
      protocol: 'chat_completions' as const,
      modelsPath: '/models',
      curatedModels: [],
      verificationModel: null,
      authentication: { headerName: 'Authorization', scheme: 'Bearer' },
      requiredCredentialFields: [],
      errorOverrides: [],
      sourceReference: 'https://ollama.com/',
      reviewedAt: new Date(0).toISOString(),
    };
    const compatibleRuntime = {};
    const acceptanceSelection = {
      taskId,
      runtimeKind: 'provider' as const,
      model: selection.requestedModel,
      modelSelection: selection,
    };
    const capabilitySnapshot = {
      runtimeKind: 'provider' as const,
      connectionId: selection.connectionId,
      providerId: selection.requestedProvider,
      modelId: selection.requestedModel,
      value: true as const,
      revision: 'vision-revision-loopback',
      capturedAtMs: Date.now(),
    };
    const captureProviderImageAttachmentCapability = vi.fn().mockResolvedValue(capabilitySnapshot);
    const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    Object.assign(router, {
      persistence: {
        getProviderConnection: vi.fn().mockReturnValue(connection),
        getTaskModelSelection: vi.fn().mockReturnValue(selection),
        getImageAttachmentAcceptanceSelection: vi.fn().mockReturnValue(acceptanceSelection),
      },
      providerRegistry: { resolve: vi.fn().mockReturnValue(compatibleRuntime) },
      compatibleRuntime,
      providerProfiles: { get: vi.fn().mockReturnValue(profile) },
      providerSecrets: {
        get: vi
          .fn()
          .mockReturnValue(
            JSON.stringify({ baseUrl, endpointDigest, localConsentDigest: endpointDigest }),
          ),
      },
      providerEndpointPolicy: endpointPolicy,
      modelCatalog: {
        revision: 7,
        find: vi.fn().mockReturnValue({
          connectionId: selection.connectionId,
          providerId: selection.requestedProvider,
          modelId: selection.requestedModel,
        }),
      },
      captureProviderImageAttachmentCapability,
    });
    const probe = router as unknown as {
      readProviderToolImageState(started: unknown, connectionId: string, modelId: string): unknown;
      captureProviderToolImageBinding(
        started: unknown,
        connection: unknown,
        modelId: string,
        signal: AbortSignal,
      ): Promise<unknown>;
      revalidateProviderToolImageBinding(
        started: unknown,
        binding: unknown,
        signal: AbortSignal,
      ): Promise<unknown>;
      providerToolImageFinalStateMatches(
        started: unknown,
        binding: unknown,
        executionConnection: unknown,
      ): boolean;
    };
    const started = { event: { taskId }, modelSelection: selection };

    const state = probe.readProviderToolImageState(
      started,
      selection.connectionId,
      selection.requestedModel,
    );

    expect(state).toMatchObject({
      binding: {
        connectionId: selection.connectionId,
        providerId: selection.requestedProvider,
        modelId: selection.requestedModel,
        requestUrl: `${baseUrl}/chat/completions`,
        modelCatalogRevision: 7,
      },
    });
    expect(JSON.stringify(state)).not.toContain('apiKey');
    const binding = await probe.captureProviderToolImageBinding(
      started,
      connection,
      selection.requestedModel,
      new AbortController().signal,
    );
    expect(binding).toMatchObject({ connectionDigest: expect.any(String) });
    expect(probe.providerToolImageFinalStateMatches(started, binding, connection)).toBe(true);
    expect(
      probe.providerToolImageFinalStateMatches(started, binding, {
        ...connection,
        displayName: 'Same identity, different execution object',
      }),
    ).toBe(false);
    await expect(
      probe.revalidateProviderToolImageBinding(started, binding, new AbortController().signal),
    ).resolves.toMatchObject({ trust: 'trusted-local' });
    await expect(
      probe.captureProviderToolImageBinding(
        started,
        {
          ...connection,
          secretReference: 'provider-secret:00000000-0000-4000-8000-000000000099',
          updatedAt: new Date(1).toISOString(),
        },
        selection.requestedModel,
        new AbortController().signal,
      ),
    ).resolves.toBeNull();
    expect(captureProviderImageAttachmentCapability).toHaveBeenCalledTimes(3);

    const originalUpdatedAt = connection.updatedAt;
    connection.updatedAt = new Date(2).toISOString();
    await expect(
      probe.revalidateProviderToolImageBinding(started, binding, new AbortController().signal),
    ).resolves.toBeNull();
    connection.updatedAt = originalUpdatedAt;

    const originalConfigurable = profile.baseUrlConfigurable;
    profile.baseUrlConfigurable = false;
    await expect(
      probe.revalidateProviderToolImageBinding(started, binding, new AbortController().signal),
    ).resolves.toBeNull();
    profile.baseUrlConfigurable = originalConfigurable;

    captureProviderImageAttachmentCapability
      .mockResolvedValueOnce(capabilitySnapshot)
      .mockResolvedValueOnce({ ...capabilitySnapshot, revision: 'vision-revision-drifted' });
    await expect(
      probe.revalidateProviderToolImageBinding(started, binding, new AbortController().signal),
    ).resolves.toBeNull();

    const remotePrepared = await new ProviderEndpointPolicy(async () => [
      { address: '8.8.8.8', family: 4 },
    ]).prepareRequestUrl('https://provider.example/v1/chat/completions');
    const prepareRequestUrl = vi
      .spyOn(endpointPolicy, 'prepareRequestUrl')
      .mockResolvedValueOnce(remotePrepared);
    await expect(
      probe.revalidateProviderToolImageBinding(started, binding, new AbortController().signal),
    ).resolves.toBeNull();
    expect(prepareRequestUrl).toHaveBeenCalledWith(`${baseUrl}/chat/completions`);

    const localhostBaseUrl = 'http://localhost:11434/v1';
    profile.baseUrl = localhostBaseUrl;
    captureProviderImageAttachmentCapability.mockReset().mockResolvedValue(capabilitySnapshot);
    const providerSecretsGet = (router['providerSecrets'] as { get: ReturnType<typeof vi.fn> }).get;
    const dnsCases = [
      {
        name: 'all-loopback',
        final: [{ address: '::1', family: 6 }],
        accepted: true,
      },
      {
        name: 'LAN',
        final: [{ address: '192.168.1.20', family: 4 }],
        accepted: false,
      },
      {
        name: 'public IPv6',
        final: [{ address: '2001:4860:4860::8888', family: 6 }],
        accepted: false,
      },
      {
        name: 'ULA',
        final: [{ address: 'fd00::1', family: 6 }],
        accepted: false,
      },
      {
        name: 'mixed loopback and non-loopback',
        final: [
          { address: '127.0.0.1', family: 4 },
          { address: '8.8.8.8', family: 4 },
        ],
        accepted: false,
      },
    ] as const;
    for (const dnsCase of dnsCases) {
      const lookup = vi
        .fn()
        .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
        .mockResolvedValueOnce(dnsCase.final);
      const policy = new ProviderEndpointPolicy(lookup);
      router['providerEndpointPolicy'] = policy;
      const localhostDigest = policy.digestForBaseUrl(localhostBaseUrl);
      providerSecretsGet.mockReturnValue(
        JSON.stringify({
          baseUrl: localhostBaseUrl,
          endpointDigest: localhostDigest,
          localConsentDigest: localhostDigest,
        }),
      );
      const localhostBinding = await probe.captureProviderToolImageBinding(
        started,
        connection,
        selection.requestedModel,
        new AbortController().signal,
      );
      expect(localhostBinding, dnsCase.name).not.toBeNull();
      const revalidated = await probe.revalidateProviderToolImageBinding(
        started,
        localhostBinding,
        new AbortController().signal,
      );
      expect(revalidated !== null, dnsCase.name).toBe(dnsCase.accepted);
      expect(lookup, dnsCase.name).toHaveBeenCalledTimes(2);
    }

    const captureLocalBinding = async () => {
      const policy = new ProviderEndpointPolicy(async () => [{ address: '127.0.0.1', family: 4 }]);
      router['providerEndpointPolicy'] = policy;
      const localhostDigest = policy.digestForBaseUrl(localhostBaseUrl);
      providerSecretsGet.mockReturnValue(
        JSON.stringify({
          baseUrl: localhostBaseUrl,
          endpointDigest: localhostDigest,
          localConsentDigest: localhostDigest,
        }),
      );
      captureProviderImageAttachmentCapability.mockReset().mockResolvedValue(capabilitySnapshot);
      const captured = await probe.captureProviderToolImageBinding(
        started,
        connection,
        selection.requestedModel,
        new AbortController().signal,
      );
      expect(captured).not.toBeNull();
      return captured;
    };
    const dnsDriftCases = [
      {
        name: 'persisted connection during DNS',
        mutate: () => {
          connection.updatedAt = new Date(3).toISOString();
        },
        restore: () => {
          connection.updatedAt = originalUpdatedAt;
        },
      },
      {
        name: 'registry profile during DNS',
        mutate: () => {
          profile.authentication.scheme = 'Token';
        },
        restore: () => {
          profile.authentication.scheme = 'Bearer';
        },
      },
      {
        name: 'task model during DNS',
        mutate: () => {
          selection.requestedModel = 'qwen3-vl:drifted';
        },
        restore: () => {
          selection.requestedModel = 'qwen3-vl:4b-instruct-q4_K_M';
        },
      },
    ];
    for (const driftCase of dnsDriftCases) {
      const localhostBinding = await captureLocalBinding();
      let resolveLookup!: (value: readonly Readonly<{ address: string; family: 4 | 6 }>[]) => void;
      let markLookupStarted!: () => void;
      const lookupStarted = new Promise<void>((resolve) => {
        markLookupStarted = resolve;
      });
      const lookupResult = new Promise<readonly Readonly<{ address: string; family: 4 | 6 }>[]>(
        (resolve) => {
          resolveLookup = resolve;
        },
      );
      router['providerEndpointPolicy'] = new ProviderEndpointPolicy(() => {
        markLookupStarted();
        return lookupResult;
      });
      const pending = probe.revalidateProviderToolImageBinding(
        started,
        localhostBinding,
        new AbortController().signal,
      );
      await lookupStarted;
      driftCase.mutate();
      resolveLookup([{ address: '127.0.0.1', family: 4 }]);
      await expect(pending, driftCase.name).resolves.toBeNull();
      driftCase.restore();
    }

    const cancellationBinding = await captureLocalBinding();
    let resolveCanceledLookup!: (
      value: readonly Readonly<{ address: string; family: 4 | 6 }>[],
    ) => void;
    let markCanceledLookupStarted!: () => void;
    const canceledLookupStarted = new Promise<void>((resolve) => {
      markCanceledLookupStarted = resolve;
    });
    const canceledLookup = new Promise<readonly Readonly<{ address: string; family: 4 | 6 }>[]>(
      (resolve) => {
        resolveCanceledLookup = resolve;
      },
    );
    router['providerEndpointPolicy'] = new ProviderEndpointPolicy(() => {
      markCanceledLookupStarted();
      return canceledLookup;
    });
    const cancellation = new AbortController();
    const canceledRevalidation = probe.revalidateProviderToolImageBinding(
      started,
      cancellationBinding,
      cancellation.signal,
    );
    await canceledLookupStarted;
    cancellation.abort(new Error('canceled during DNS'));
    resolveCanceledLookup([{ address: '127.0.0.1', family: 4 }]);
    await expect(canceledRevalidation).resolves.toBeNull();

    for (const finalCapability of [
      { ...capabilitySnapshot, value: false as const },
      { ...capabilitySnapshot, value: null },
      { ...capabilitySnapshot, revision: 'vision-revision-final-drift' },
      { ...capabilitySnapshot, capturedAtMs: Date.now() - 5_001 },
    ]) {
      const localhostBinding = await captureLocalBinding();
      router['providerEndpointPolicy'] = new ProviderEndpointPolicy(async () => [
        { address: '127.0.0.1', family: 4 },
      ]);
      captureProviderImageAttachmentCapability
        .mockReset()
        .mockResolvedValueOnce(capabilitySnapshot)
        .mockResolvedValueOnce(finalCapability);
      await expect(
        probe.revalidateProviderToolImageBinding(
          started,
          localhostBinding,
          new AbortController().signal,
        ),
      ).resolves.toBeNull();
    }

    const finalProbeDrifts = [
      {
        name: 'persisted connection during final capability',
        mutate: () => {
          connection.updatedAt = new Date(4).toISOString();
        },
        restore: () => {
          connection.updatedAt = originalUpdatedAt;
        },
      },
      {
        name: 'registry profile during final capability',
        mutate: () => {
          profile.baseUrlConfigurable = false;
        },
        restore: () => {
          profile.baseUrlConfigurable = true;
        },
      },
      {
        name: 'task model during final capability',
        mutate: () => {
          selection.requestedModel = 'qwen3-vl:final-drift';
        },
        restore: () => {
          selection.requestedModel = 'qwen3-vl:4b-instruct-q4_K_M';
        },
      },
    ];
    for (const driftCase of finalProbeDrifts) {
      const localhostBinding = await captureLocalBinding();
      router['providerEndpointPolicy'] = new ProviderEndpointPolicy(async () => [
        { address: '127.0.0.1', family: 4 },
      ]);
      let resolveCapability!: (value: typeof capabilitySnapshot) => void;
      let markCapabilityStarted!: () => void;
      const capabilityStarted = new Promise<void>((resolve) => {
        markCapabilityStarted = resolve;
      });
      const finalCapability = new Promise<typeof capabilitySnapshot>((resolve) => {
        resolveCapability = resolve;
      });
      captureProviderImageAttachmentCapability
        .mockReset()
        .mockResolvedValueOnce(capabilitySnapshot)
        .mockImplementationOnce(() => {
          markCapabilityStarted();
          return finalCapability;
        });
      const pending = probe.revalidateProviderToolImageBinding(
        started,
        localhostBinding,
        new AbortController().signal,
      );
      await capabilityStarted;
      driftCase.mutate();
      resolveCapability(capabilitySnapshot);
      await expect(pending, driftCase.name).resolves.toBeNull();
      driftCase.restore();
    }
  });

  it('fails closed for every acceptance-time connection, profile, credential, and model drift', () => {
    const createHarness = () => {
      const taskId = 'task-tool-image-acceptance-matrix';
      const modelId = 'qwen3-vl:4b-instruct-q4_K_M';
      const baseUrl = 'http://127.0.0.1:11434/v1';
      const endpointPolicy = new ProviderEndpointPolicy();
      const endpointDigest = endpointPolicy.digestForBaseUrl(baseUrl);
      const selection = {
        connectionId: 'ollama:acceptance-matrix',
        requestedProvider: 'ollama',
        requestedModel: modelId,
      };
      const startedSelection = { ...selection };
      const connection = {
        id: selection.connectionId,
        providerId: selection.requestedProvider,
        runtimeKind: 'openai_compatible',
        displayName: 'Ollama loopback',
        enabled: true,
        secretReference: 'provider-secret:00000000-0000-4000-8000-000000000010' as string | null,
        verification: {
          status: 'verified',
          verifiedAt: new Date(Date.now() - 60_000).toISOString() as string | null,
          expiresAt: new Date(Date.now() + 60_000).toISOString() as string | null,
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
      const profile = {
        id: 'ollama',
        displayName: 'Ollama',
        baseUrl,
        baseUrlConfigurable: true,
        computeLocation: 'local',
        nativeModelLifecycle: 'ollama',
        protocol: 'chat_completions',
        modelsPath: '/models',
        curatedModels: [],
        verificationModel: null,
        authentication: { headerName: 'Authorization', scheme: 'Bearer' },
        requiredCredentialFields: [] as string[],
        errorOverrides: [],
        sourceReference: 'https://ollama.com/',
        reviewedAt: new Date(0).toISOString(),
      };
      const credential: Record<string, unknown> = {
        baseUrl,
        endpointDigest,
        localConsentDigest: endpointDigest,
      };
      const model = {
        connectionId: selection.connectionId,
        providerId: selection.requestedProvider,
        modelId,
      };
      const compatibleRuntime = {};
      const providerSecretsGet = vi.fn(() => JSON.stringify(credential));
      const registryResolve = vi.fn(() => compatibleRuntime);
      const modelFind = vi.fn((): typeof model | undefined => model);
      const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
      Object.assign(router, {
        persistence: {
          getProviderConnection: () => connection,
          getTaskModelSelection: () => selection,
        },
        providerRegistry: { resolve: registryResolve },
        compatibleRuntime,
        providerProfiles: { get: () => profile },
        providerSecrets: { get: providerSecretsGet },
        providerEndpointPolicy: endpointPolicy,
        modelCatalog: { revision: 7, find: modelFind },
      });
      const started = { event: { taskId }, modelSelection: startedSelection };
      const read = () =>
        (
          router as unknown as {
            readProviderToolImageState(
              started: unknown,
              connectionId: string,
              modelId: string,
            ): unknown;
          }
        ).readProviderToolImageState(started, connection.id, modelId);
      return {
        connection,
        credential,
        endpointDigest,
        model,
        modelFind,
        profile,
        providerSecretsGet,
        read,
        registryResolve,
        selection,
        startedSelection,
      };
    };
    const cases: ReadonlyArray<
      readonly [string, (harness: ReturnType<typeof createHarness>) => void]
    > = [
      ['responses protocol', ({ profile }) => Object.assign(profile, { protocol: 'responses' })],
      ['profile id lookalike', ({ profile }) => Object.assign(profile, { id: 'ollamI' })],
      [
        'required empty api key',
        ({ credential, profile }) => {
          profile.requiredCredentialFields = ['api_key'];
          credential['apiKey'] = ' ';
        },
      ],
      [
        'required empty account id',
        ({ credential, profile }) => {
          profile.requiredCredentialFields = ['account_id'];
          credential['accountId'] = ' ';
        },
      ],
      [
        'credential resolution exception',
        ({ providerSecretsGet }) =>
          providerSecretsGet.mockImplementation(() => {
            throw new Error('credential unavailable');
          }),
      ],
      [
        'missing endpoint digest',
        ({ credential }) => void Reflect.deleteProperty(credential, 'endpointDigest'),
      ],
      [
        'mismatched endpoint digest',
        ({ credential }) => void (credential['endpointDigest'] = 'f'.repeat(64)),
      ],
      [
        'missing local consent digest',
        ({ credential }) => void Reflect.deleteProperty(credential, 'localConsentDigest'),
      ],
      [
        'mismatched local consent digest',
        ({ credential }) => void (credential['localConsentDigest'] = 'e'.repeat(64)),
      ],
      ['missing verifiedAt', ({ connection }) => void (connection.verification.verifiedAt = null)],
      [
        'invalid verifiedAt',
        ({ connection }) => void (connection.verification.verifiedAt = 'not-a-timestamp'),
      ],
      [
        'verifiedAt in future',
        ({ connection }) =>
          void (connection.verification.verifiedAt = new Date(Date.now() + 60_000).toISOString()),
      ],
      ['missing expiresAt', ({ connection }) => void (connection.verification.expiresAt = null)],
      [
        'expiresAt equals verifiedAt',
        ({ connection }) =>
          void (connection.verification.expiresAt = connection.verification.verifiedAt),
      ],
      [
        'expiresAt equals now',
        ({ connection }) =>
          void (connection.verification.expiresAt = new Date(Date.now()).toISOString()),
      ],
      [
        'expiresAt in past',
        ({ connection }) =>
          void (connection.verification.expiresAt = new Date(Date.now() - 1).toISOString()),
      ],
      ['disabled connection', ({ connection }) => void (connection.enabled = false)],
      [
        'unverified connection',
        ({ connection }) => void (connection.verification.status = 'unverified'),
      ],
      [
        'not-required connection',
        ({ connection }) => void (connection.verification.status = 'not_required'),
      ],
      ['missing secret reference', ({ connection }) => void (connection.secretReference = null)],
      [
        'non-compatible runtime kind',
        ({ connection }) => void (connection.runtimeKind = 'official_api'),
      ],
      [
        'connection id lookalike selection',
        ({ selection }) => void (selection.connectionId = 'ollama:acceptance-matrix-lookalike'),
      ],
      [
        'provider selection drift',
        ({ selection }) => void (selection.requestedProvider = 'ollamI'),
      ],
      [
        'model selection drift',
        ({ selection }) => void (selection.requestedModel = 'qwen3-vl:other'),
      ],
      [
        'started model drift',
        ({ startedSelection }) => void (startedSelection.requestedModel = 'qwen3-vl:other'),
      ],
      ['runtime registry mismatch', ({ registryResolve }) => registryResolve.mockReturnValue({})],
      ['missing model', ({ modelFind }) => modelFind.mockReturnValue(undefined)],
      ['model connection drift', ({ model }) => void (model.connectionId = 'ollama:model-drift')],
      ['model provider drift', ({ model }) => void (model.providerId = 'ollamI')],
      ['model identity drift', ({ model }) => void (model.modelId = 'qwen3-vl:other')],
      [
        'LAN credential',
        ({ credential, profile }) => {
          const lanUrl = 'http://192.168.1.50:11434/v1';
          profile.baseUrl = lanUrl;
          credential['baseUrl'] = lanUrl;
          credential['endpointDigest'] = '0'.repeat(64);
          credential['localConsentDigest'] = '0'.repeat(64);
        },
      ],
      [
        'trusted remote credential',
        ({ credential, profile }) => {
          const remoteUrl = 'https://provider.example/v1';
          profile.baseUrl = remoteUrl;
          credential['baseUrl'] = remoteUrl;
          credential['endpointDigest'] = '0'.repeat(64);
          credential['localConsentDigest'] = '0'.repeat(64);
        },
      ],
    ];

    expect(createHarness().read()).not.toBeNull();
    for (const [name, mutate] of cases) {
      const harness = createHarness();
      mutate(harness);
      expect(harness.read(), name).toBeNull();
    }
  });

  it('denies generic view_image callbacks before broker execution', async () => {
    const brokerDispatch = vi.fn();
    const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    Object.assign(router, { managedCodingHarness: { broker: { dispatch: brokerDispatch } } });
    const probe = router as unknown as {
      dispatchManagedRuntimeTool(
        taskId: string,
        turnId: string,
        request: unknown,
        signal: AbortSignal,
      ): Promise<unknown>;
    };

    const result = await probe.dispatchManagedRuntimeTool(
      'task-generic-image',
      'turn-generic-image',
      { callId: 'call-generic', toolName: 'view_image', arguments: { path: 'image.png' } },
      new AbortController().signal,
    );

    expect(brokerDispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: 'provider_image_tool',
      accepted: false,
      toolMessage: {
        toolCallId: 'call-generic',
        content: expect.stringContaining('VIEW_IMAGE_NOT_PERMITTED'),
      },
    });
    expect(JSON.stringify(result)).not.toContain('data:image/');
  });

  it('contains hostile broker thenable failures inside the provider image bridge', async () => {
    const leak = 'data:image/png;base64,HOSTILE_THENABLE_LEAK';
    const thenable = Object.defineProperty({}, 'then', {
      get: () => {
        throw new Error(leak);
      },
    });
    const brokerDispatch = vi.fn(() => thenable);
    const logger = vi.spyOn(secureLogger, 'error');
    const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    Object.assign(router, {
      managedWorkerTurn: new Map(),
      managedCodingHarness: { broker: { dispatch: brokerDispatch } },
    });
    const probe = router as unknown as {
      dispatchManagedRuntimeTool(
        taskId: string,
        turnId: string,
        request: unknown,
        signal: AbortSignal,
        bridge: ToolImageBridge,
      ): Promise<unknown>;
    };

    const result = await probe.dispatchManagedRuntimeTool(
      'task-provider-image',
      'turn-provider-image',
      { callId: 'call-hostile', toolName: 'view_image', arguments: { path: 'image.png' } },
      new AbortController().signal,
      new ToolImageBridge(),
    );

    expect(brokerDispatch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      kind: 'provider_image_tool',
      accepted: false,
      toolMessage: {
        toolCallId: 'call-hostile',
        content: expect.stringContaining('INVALID_TOOL_RESULT'),
      },
    });
    expect(JSON.stringify(result)).not.toContain(leak);
    expect(logger.mock.calls.flat().join('\n')).not.toContain(leak);
    logger.mockRestore();
  });

  it('propagates cancellation while a provider image tool is executing', async () => {
    const controller = new AbortController();
    const cancellation = new Error('turn canceled');
    const brokerDispatch = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(cancellation), { once: true });
        }),
    );
    const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    Object.assign(router, {
      managedWorkerTurn: new Map(),
      managedCodingHarness: { broker: { dispatch: brokerDispatch } },
    });
    const probe = router as unknown as {
      dispatchManagedRuntimeTool(
        taskId: string,
        turnId: string,
        request: unknown,
        signal: AbortSignal,
        bridge: ToolImageBridge,
      ): Promise<unknown>;
    };

    const pending = probe.dispatchManagedRuntimeTool(
      'task-provider-image-cancel',
      'turn-provider-image-cancel',
      { callId: 'call-cancel', toolName: 'view_image', arguments: { path: 'image.png' } },
      controller.signal,
      new ToolImageBridge(),
    );
    controller.abort();

    await expect(pending).rejects.toBe(cancellation);
    expect(brokerDispatch).toHaveBeenCalledOnce();
  });

  it('discards a valid provider image that resolves after cancellation', async () => {
    const source = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    })
      .png()
      .toBuffer();
    const canonical = await canonicalizeProviderToolImage(source);
    const validResult = {
      path: 'image.png',
      mimeType: canonical.mimeType,
      byteLength: canonical.bytes.byteLength,
      sha256: canonical.sha256,
      dataUrl: `data:${canonical.mimeType};base64,${canonical.bytes.toString('base64')}`,
    };
    const controller = new AbortController();
    const cancellation = new Error('turn canceled after tool completion');
    const brokerDispatch = vi.fn(
      async (_request: unknown, consume: (value: unknown) => Promise<unknown>) => {
        const metadata = await consume(validResult);
        controller.abort(cancellation);
        return metadata;
      },
    );
    const bridge = new ToolImageBridge();
    const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    Object.assign(router, {
      managedWorkerTurn: new Map(),
      managedCodingHarness: { broker: { dispatch: brokerDispatch } },
    });
    const probe = router as unknown as {
      dispatchManagedRuntimeTool(
        taskId: string,
        turnId: string,
        request: unknown,
        signal: AbortSignal,
        bridge: ToolImageBridge,
      ): Promise<unknown>;
    };

    const pending = probe.dispatchManagedRuntimeTool(
      'task-provider-image-late-cancel',
      'turn-provider-image-late-cancel',
      { callId: 'call-late-cancel', toolName: 'view_image', arguments: { path: 'image.png' } },
      controller.signal,
      bridge,
    );
    await expect(pending).rejects.toBe(cancellation);
    expect(bridge.consumeForNextDispatch({ baseMessages: [], directImages: [] }).hasToolImage).toBe(
      false,
    );
  });

  it('commits provider image bytes and publishes their binding before dispatch resolves', async () => {
    const source = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: { r: 60, g: 100, b: 140 },
      },
    })
      .png()
      .toBuffer();
    const canonical = await canonicalizeProviderToolImage(source);
    const validResult = {
      path: 'image.png',
      mimeType: canonical.mimeType,
      byteLength: canonical.bytes.byteLength,
      sha256: canonical.sha256,
      dataUrl: `data:${canonical.mimeType};base64,${canonical.bytes.toString('base64')}`,
    };
    const bridge = new ToolImageBridge();
    const events: string[] = [];
    const commit = bridge.commitStaged.bind(bridge);
    vi.spyOn(bridge, 'commitStaged').mockImplementation(() => {
      commit();
      events.push('bytes-committed');
    });
    const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    Object.assign(router, {
      managedWorkerTurn: new Map(),
      managedCodingHarness: {
        broker: {
          dispatch: vi.fn(
            async (_request: unknown, consume: (value: unknown) => Promise<unknown>) =>
              consume(validResult),
          ),
        },
      },
    });
    const probe = router as unknown as {
      dispatchManagedRuntimeTool(
        taskId: string,
        turnId: string,
        request: unknown,
        signal: AbortSignal,
        bridge: ToolImageBridge,
        publishBinding: () => void,
      ): Promise<unknown>;
    };

    const resolved = probe
      .dispatchManagedRuntimeTool(
        'task-provider-image-atomic',
        'turn-provider-image-atomic',
        { callId: 'call-atomic', toolName: 'view_image', arguments: { path: 'image.png' } },
        new AbortController().signal,
        bridge,
        () => events.push('binding-published'),
      )
      .then((value) => {
        events.push('dispatch-resolved');
        return value;
      });

    await expect(resolved).resolves.toMatchObject({ accepted: true });
    expect(events).toEqual(['bytes-committed', 'binding-published', 'dispatch-resolved']);
    expect(bridge.consumeForNextDispatch({ baseMessages: [], directImages: [] }).hasToolImage).toBe(
      true,
    );
  });

  it('rolls back a staged later image when broker post-processing fails', async () => {
    const firstSource = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: { r: 30, g: 50, b: 70 },
      },
    })
      .png()
      .toBuffer();
    const laterSource = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: { r: 180, g: 90, b: 20 },
      },
    })
      .png()
      .toBuffer();
    const first = await canonicalizeProviderToolImage(firstSource);
    const later = await canonicalizeProviderToolImage(laterSource);
    const resultFor = (image: typeof first) => ({
      path: 'image.png',
      mimeType: image.mimeType,
      byteLength: image.bytes.byteLength,
      sha256: image.sha256,
      dataUrl: `data:${image.mimeType};base64,${image.bytes.toString('base64')}`,
    });
    const bridge = new ToolImageBridge();
    await bridge.acceptToolResult({
      toolCallId: 'call-a',
      toolName: 'view_image',
      result: resultFor(first),
    });
    const brokerDispatch = vi.fn(
      async (_request: unknown, consume: (value: unknown) => Promise<unknown>) => {
        await consume(resultFor(later));
        throw new Error('post-stage lifecycle failed');
      },
    );
    const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    Object.assign(router, {
      managedWorkerTurn: new Map(),
      managedCodingHarness: { broker: { dispatch: brokerDispatch } },
    });
    const probe = router as unknown as {
      dispatchManagedRuntimeTool(
        taskId: string,
        turnId: string,
        request: unknown,
        signal: AbortSignal,
        bridge: ToolImageBridge,
      ): Promise<unknown>;
    };

    await expect(
      probe.dispatchManagedRuntimeTool(
        'task-provider-image-rollback',
        'turn-provider-image-rollback',
        { callId: 'call-b', toolName: 'view_image', arguments: { path: 'image.png' } },
        new AbortController().signal,
        bridge,
      ),
    ).resolves.toMatchObject({ accepted: false });
    const next = bridge.consumeForNextDispatch({ baseMessages: [], directImages: [] });
    expect(next.messages.at(-1)).toMatchObject({
      inlineImages: [{ base64: first.bytes.toString('base64') }],
    });
    expect(JSON.stringify(next.messages)).not.toContain(later.bytes.toString('base64'));
  });

  it('normalizes Provider-owned tool call ids only in the egress policy projection', () => {
    const callId = 'uR9mF3xP8qT2vW7kL4nB6cD1sH5jA0zE';
    const messages = [
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ callId, name: 'create_file', input: { path: 'proof.txt' } }],
      },
      {
        role: 'tool' as const,
        content: '{"ok":true}',
        toolCallId: callId,
        toolName: 'create_file',
      },
    ];

    const projected = JSON.stringify(providerMessagesForEgressPolicy(messages));
    expect(projected).not.toContain(callId);
    expect(projected).toContain('provider-tool-call-id');
    expect(messages[0]?.toolCalls?.[0]?.callId).toBe(callId);
    expect(messages[1]?.toolCallId).toBe(callId);
  });

  it('keeps a parent Turn authorization alive only while its durable Worker is active', () => {
    const workers = [
      { taskId: 'task-worker', parentTurnId: 'turn-parent' },
      { taskId: 'task-other', parentTurnId: 'turn-other' },
    ];

    expect(authorizationTurnIsActive('turn-active', 'task-worker', 'turn-active', [])).toBe(true);
    expect(authorizationTurnIsActive(null, 'task-worker', 'turn-parent', workers)).toBe(true);
    expect(authorizationTurnIsActive(null, 'task-worker', 'turn-other', workers)).toBe(false);
    expect(authorizationTurnIsActive(null, 'task-worker', 'turn-parent', [])).toBe(false);
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
  it('fails the real Provider turn before a second execute when final tool-image egress is denied', async () => {
    const taskId = 'task-tool-image-final-deny';
    const turnId = 'turn-tool-image-final-deny';
    const userMessageId = 'message-tool-image-final-deny';
    const connection = {
      id: 'profile:ollama',
      providerId: 'ollama',
      runtimeKind: 'openai_compatible',
      displayName: 'Ollama',
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
    const source = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: { r: 30, g: 80, b: 120 },
      },
    })
      .png()
      .toBuffer();
    const canonical = await canonicalizeProviderToolImage(source);
    const toolResult = {
      path: 'fixture.png',
      mimeType: canonical.mimeType,
      byteLength: canonical.bytes.byteLength,
      sha256: canonical.sha256,
      dataUrl: `data:${canonical.mimeType};base64,${canonical.bytes.toString('base64')}`,
    };
    const execute = vi.fn(() =>
      (async function* () {
        yield {
          type: 'tool_call' as const,
          callId: 'call-view-image',
          name: 'view_image',
          input: { path: 'fixture.png' },
        };
        yield { type: 'completed' as const, stopReason: 'tool_calls' };
      })(),
    );
    const runtime = { execute, cancel: vi.fn() };
    const evaluate = vi.fn((input: Record<string, unknown>) => {
      const request = input['request'] as {
        resource: { attachmentByteCount: number; attachmentManifestDigest: string | null };
      };
      return request.resource.attachmentByteCount > 0
        ? {
            decision: 'deny',
            reason: 'test_final_tool_image_denial',
            policyEpoch: 1,
            evaluationTrace: ['test-final-deny'],
          }
        : {
            decision: 'allow',
            reason: 'test_initial_allow',
            policyEpoch: 1,
            evaluationTrace: ['test-initial-allow'],
            permit: { id: 'test-permit' },
          };
    });
    const appendDelta = vi.fn(() => ({ type: 'message.delta' }));
    const recordRuntimeFailureDiagnostic = vi.fn(
      (_taskId: string, _turnId: string, diagnostic: { diagnosticId: string }) => diagnostic,
    );
    const finishAndAdvance = vi.fn();
    const dispatchManagedRuntimeTool = vi.fn(
      async (
        _taskId: string,
        _turnId: string,
        request: { callId: string; toolName: string },
        _signal: AbortSignal,
        bridge: ToolImageBridge,
        publishBinding: () => void,
      ) => {
        const accepted = await bridge.acceptToolResult({
          toolCallId: request.callId,
          toolName: request.toolName,
          result: toolResult,
        });
        if (accepted.accepted) publishBinding();
        return Object.freeze({ kind: 'provider_image_tool', ...accepted });
      },
    );
    const ensureProviderEndpointConsent = vi.fn().mockResolvedValue(undefined);
    const requireVerifiedForExecution = vi.fn().mockResolvedValue(connection);
    const resolveProvider = vi.fn(() => runtime);
    const prepareContext = vi.fn(() => ({
      fragments: [
        {
          id: 'current',
          taskId,
          source: 'history',
          trust: 'user',
          tokenEstimate: 1,
          content: 'describe the workspace image',
          createdAt: new Date(0).toISOString(),
          messageId: userMessageId,
        },
      ],
      projectItems: [],
      projectSnapshotDigest: null,
    }));
    const prepareProviderTurnImageAttachments = vi.fn(() => undefined);
    const modelFind = vi.fn(() => ({ toolCalling: { value: true } }));
    const startManagedTurn = vi.fn(() => ({
      digest: 'a'.repeat(64),
      providerId: 'ollama',
      entries: [
        {
          providerName: 'view_image',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      ],
    }));
    const fakeRouter = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    Object.assign(fakeRouter, {
      canceledRuntimeTurns: new Set<string>(),
      turnRuntimes: new Map([[turnId, 'provider']]),
      providerAbortByTurn: new Map(),
      providerExecutionIdByTurn: new Map(),
      providerVerification: {
        requireVerifiedForExecution,
      },
      providerRegistry: { resolve: resolveProvider },
      modelCatalog: { find: modelFind },
      permissionBroker: {
        evaluate,
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
        recordRuntimeFailureDiagnostic,
      },
      mailbox: { run: async (_taskId: string, action: () => unknown) => action() },
      publish: vi.fn(),
      finishAndAdvance,
      ensureProviderEndpointConsent,
      prepareContext,
      prepareProviderTurnImageAttachments,
      providerEgressTrustForConnection: () => 'trusted-local',
      managedCodingHarness: {
        startTurn: startManagedTurn,
        finishTurn: vi.fn(),
      },
      teamCoordinator: { hasUnfinishedTeamWork: () => false },
      applyProviderTurnEvent: vi.fn(),
      captureProviderToolImageBinding: vi.fn().mockResolvedValue({
        connectionDigest: digestCanonical(connection),
      }),
      revalidateProviderToolImageBinding: vi.fn().mockResolvedValue({ trust: 'trusted-local' }),
      providerToolImageStateMatches: vi.fn().mockReturnValue({ connection }),
      dispatchManagedRuntimeTool,
      cancelProviderExecution: vi.fn().mockResolvedValue(undefined),
    });
    const started = {
      turnId,
      text: 'describe the workspace image',
      skills: [],
      event: { type: 'turn.accepted', taskId, userMessage: { id: userMessageId } },
      modelSelection: {
        connectionId: connection.id,
        requestedProvider: connection.providerId,
        requestedModel: 'qwen3-vl:4b-instruct-q4_K_M',
      },
      workspaceSet: {
        digest: 'workspace-digest',
        roots: [{ rootId: 'root-a' }],
      },
    };
    const startProviderTurn = Reflect.get(IpcRouter.prototype, 'startProviderTurn') as (
      this: typeof fakeRouter,
      started: unknown,
      connectionId: string,
      teamTurn: boolean,
      autoSkills: readonly unknown[],
    ) => Promise<void>;

    await startProviderTurn.call(fakeRouter, started, connection.id, false, []);

    expect(
      execute,
      JSON.stringify({
        evaluateCalls: evaluate.mock.calls.length,
        dispatchCalls: dispatchManagedRuntimeTool.mock.calls.length,
        diagnosticCalls: recordRuntimeFailureDiagnostic.mock.calls.length,
        finishCalls: finishAndAdvance.mock.calls,
        ensureCalls: ensureProviderEndpointConsent.mock.calls.length,
        verifyCalls: requireVerifiedForExecution.mock.calls.length,
        prepareContextCalls: prepareContext.mock.calls.length,
        resolveCalls: resolveProvider.mock.calls.length,
        prepareImageCalls: prepareProviderTurnImageAttachments.mock.calls.length,
        modelFindCalls: modelFind.mock.calls.length,
        managedStartCalls: startManagedTurn.mock.calls.length,
      }),
    ).toHaveBeenCalledTimes(1);
    expect(dispatchManagedRuntimeTool).toHaveBeenCalledTimes(1);
    const deniedRequest = evaluate.mock.calls
      .map(([input]) => input['request'] as { resource: Record<string, unknown> })
      .find(({ resource }) => Number(resource['attachmentByteCount']) > 0);
    expect(deniedRequest?.resource).toMatchObject({
      providerTrust: 'trusted-local',
      dataResidency: 'local-device',
      attachmentByteCount: canonical.bytes.byteLength,
      attachmentManifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(deniedRequest)).not.toContain(canonical.bytes.toString('base64'));
    expect(appendDelta).toHaveBeenCalledWith(
      taskId,
      turnId,
      expect.any(String),
      '画像を安全に送信できなかったため、Providerへの送信を中止しました。',
    );
    expect(JSON.stringify(appendDelta.mock.calls)).not.toContain('data:image/');
    expect(recordRuntimeFailureDiagnostic).toHaveBeenCalledTimes(1);
    expect(recordRuntimeFailureDiagnostic.mock.calls[0]?.[2]).toMatchObject({
      failureStage: 'provider_error',
      category: 'invalid_request',
      providerCode: 'policy_denied',
      modelPreparation: 'completed',
    });
    expect(finishAndAdvance).toHaveBeenCalledWith(taskId, turnId, 'failed');
  });

  it('sends only the last tool image on request 2 with the direct manifest and never resends it', async () => {
    const taskId = 'task-tool-image-success';
    const turnId = 'turn-tool-image-success';
    const userMessageId = 'message-tool-image-success';
    const connection = {
      id: 'profile:ollama-success',
      providerId: 'ollama',
      runtimeKind: 'openai_compatible',
      displayName: 'Ollama',
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
    const canonicalFor = async (red: number) =>
      canonicalizeProviderToolImage(
        await sharp({
          create: {
            width: 32,
            height: 32,
            channels: 3,
            background: { r: red, g: 50, b: 90 },
          },
        })
          .png()
          .toBuffer(),
      );
    const imageA = await canonicalFor(40);
    const imageB = await canonicalFor(180);
    const resultFor = (image: typeof imageA) => ({
      path: 'fixture.png',
      mimeType: image.mimeType,
      byteLength: image.bytes.byteLength,
      sha256: image.sha256,
      dataUrl: `data:${image.mimeType};base64,${image.bytes.toString('base64')}`,
    });
    const directBytes = Buffer.from('direct-image-fixture');
    const directImage = {
      id: 'direct-1',
      mimeType: 'image/png' as const,
      byteLength: directBytes.byteLength,
      sha256: createHash('sha256').update(directBytes).digest('hex'),
    };
    const directManifest = [
      {
        ...directImage,
        ordinal: 0,
      },
    ];
    const compositeManifest = [
      ...directManifest,
      {
        id: 'tool:call-image-b',
        mimeType: imageB.mimeType,
        byteLength: imageB.bytes.byteLength,
        sha256: imageB.sha256,
      },
    ];
    let ordinal = 0;
    const serializedBodies: Array<ReturnType<typeof openAICompatibleChatCompletionRequest>> = [];
    const execute = vi.fn((_connection: unknown, _request: unknown) => {
      serializedBodies.push(
        openAICompatibleChatCompletionRequest(
          _request as Parameters<typeof openAICompatibleChatCompletionRequest>[0],
          'ollama',
        ),
      );
      ordinal += 1;
      const current = ordinal;
      return (async function* () {
        if (current === 1) {
          yield {
            type: 'tool_call' as const,
            callId: 'call-image-a',
            name: 'view_image',
            input: { path: 'a.png' },
          };
          yield {
            type: 'tool_call' as const,
            callId: 'call-image-b',
            name: 'view_image',
            input: { path: 'b.png' },
          };
          yield { type: 'completed' as const, stopReason: 'tool_calls' };
          return;
        }
        if (current === 2) {
          yield {
            type: 'tool_call' as const,
            callId: 'call-read',
            name: 'read_file',
            input: { path: 'notes.txt' },
          };
          yield { type: 'completed' as const, stopReason: 'tool_calls' };
          return;
        }
        yield { type: 'output_delta' as const, text: 'VISION-731 red circle' };
        yield { type: 'completed' as const, stopReason: 'stop' };
      })();
    });
    const evaluate = vi.fn((_input: Record<string, unknown>) => ({
      decision: 'allow',
      reason: 'test_allow',
      policyEpoch: 1,
      evaluationTrace: ['test-allow'],
      permit: { id: 'test-permit' },
    }));
    const brokerDispatch = vi.fn(
      async (
        request: { callId: string; providerName: string },
        consume?: (result: unknown) => Promise<unknown>,
      ) => {
        if (request.providerName !== 'view_image') return { path: 'notes.txt', content: 'ok' };
        return consume!(request.callId === 'call-image-a' ? resultFor(imageA) : resultFor(imageB));
      },
    );
    const prepareContext = vi.fn(() => ({
      fragments: [
        {
          id: 'current',
          taskId,
          source: 'history',
          trust: 'user',
          tokenEstimate: 1,
          content: 'describe the workspace image',
          createdAt: new Date(0).toISOString(),
          messageId: userMessageId,
        },
      ],
      projectItems: [],
      projectSnapshotDigest: null,
    }));
    const prepareProviderTurnImageAttachments = vi.fn(() => ({
      binding: { kind: 'provider_inline' },
      inlineImages: [{ mimeType: directImage.mimeType, base64: directBytes.toString('base64') }],
      auditImages: [directImage],
      manifestDigest: digestCanonical(directManifest),
      byteCount: directImage.byteLength,
    }));
    const beginProviderSynthesis = vi.fn().mockResolvedValue(undefined);
    const completeProviderTeamTurn = vi.fn().mockResolvedValue('completed');
    const captureProviderToolImageBinding = vi
      .fn()
      .mockResolvedValueOnce({
        connectionDigest: digestCanonical(connection),
        image: 'A',
      })
      .mockResolvedValueOnce({
        connectionDigest: digestCanonical(connection),
        image: 'B',
      });
    const providerToolImageFinalStateMatches = vi.fn().mockReturnValue(true);
    const fakeRouter = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    Object.assign(fakeRouter, {
      canceledRuntimeTurns: new Set<string>(),
      turnRuntimes: new Map([[turnId, 'provider']]),
      providerAbortByTurn: new Map(),
      providerExecutionIdByTurn: new Map(),
      managedWorkerTurn: new Map(),
      managedWorkerCall: new Map(),
      providerVerification: { requireVerifiedForExecution: vi.fn().mockResolvedValue(connection) },
      providerRegistry: { resolve: vi.fn(() => ({ execute, cancel: vi.fn() })) },
      modelCatalog: { find: vi.fn(() => ({ toolCalling: { value: true } })) },
      permissionBroker: {
        evaluate,
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
      prepareContext,
      prepareProviderTurnImageAttachments,
      providerImageAttachmentStillValid: vi.fn().mockResolvedValue(true),
      providerEgressTrustForConnection: () => 'trusted-local',
      managedCodingHarness: {
        broker: { dispatch: brokerDispatch },
        startTurn: vi.fn(() => ({
          digest: 'a'.repeat(64),
          providerId: 'ollama',
          entries: [
            {
              providerName: 'view_image',
              inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
                additionalProperties: false,
              },
            },
            {
              providerName: 'read_file',
              inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
                additionalProperties: false,
              },
            },
          ],
        })),
        finishTurn: vi.fn(),
      },
      teamCoordinator: { hasUnfinishedTeamWork: () => false },
      applyProviderTurnEvent: vi.fn(),
      captureProviderToolImageBinding,
      revalidateProviderToolImageBinding: vi.fn().mockResolvedValue({ trust: 'trusted-local' }),
      providerToolImageFinalStateMatches,
      beginProviderSynthesis,
      completeProviderTeamTurn,
      cancelProviderExecution: vi.fn().mockResolvedValue(undefined),
    });
    const started = {
      turnId,
      text: 'describe the workspace image',
      skills: [],
      event: { type: 'turn.accepted', taskId, userMessage: { id: userMessageId } },
      modelSelection: {
        connectionId: connection.id,
        requestedProvider: connection.providerId,
        requestedModel: 'qwen3-vl:4b-instruct-q4_K_M',
      },
      workspaceSet: { digest: 'workspace-digest', roots: [{ rootId: 'root-a' }] },
    };
    const startProviderTurn = Reflect.get(IpcRouter.prototype, 'startProviderTurn') as (
      this: typeof fakeRouter,
      started: unknown,
      connectionId: string,
      teamTurn: boolean,
      autoSkills: readonly unknown[],
    ) => Promise<void>;

    await startProviderTurn.call(fakeRouter, started, connection.id, false, []);

    expect(execute).toHaveBeenCalledTimes(3);
    const request2 = execute.mock.calls[1]?.[1] as {
      messages: Array<{ content: string; inlineImages?: Array<{ base64: string }> }>;
    };
    const request3 = execute.mock.calls[2]?.[1] as typeof request2;
    const request2Images = request2.messages.flatMap((message) => message.inlineImages ?? []);
    const request3Images = request3.messages.flatMap((message) => message.inlineImages ?? []);
    expect(request2Images.map(({ base64 }) => base64)).toEqual([
      directBytes.toString('base64'),
      imageB.bytes.toString('base64'),
    ]);
    expect(JSON.stringify(request2)).not.toContain(imageA.bytes.toString('base64'));
    expect(request3Images.map(({ base64 }) => base64)).toEqual([directBytes.toString('base64')]);
    expect(JSON.stringify(request3)).not.toContain(imageB.bytes.toString('base64'));
    const imageUrlsFor = (body: unknown) =>
      ((body as { messages?: Array<{ content?: unknown }> } | undefined)?.messages ?? []).flatMap(
        (message) =>
          Array.isArray(message.content)
            ? (
                message.content as Array<{
                  type?: string;
                  image_url?: { url?: string };
                }>
              ).flatMap((part) =>
                part.type === 'image_url' && typeof part.image_url?.url === 'string'
                  ? [part.image_url.url]
                  : [],
              )
            : [],
      );
    expect(imageUrlsFor(serializedBodies[1])).toEqual([
      `data:${directImage.mimeType};base64,${directBytes.toString('base64')}`,
      `data:${imageB.mimeType};base64,${imageB.bytes.toString('base64')}`,
    ]);
    expect(imageUrlsFor(serializedBodies[2])).toEqual([
      `data:${directImage.mimeType};base64,${directBytes.toString('base64')}`,
    ]);
    const resources = evaluate.mock.calls.map(
      ([input]) => (input as { request: { resource: Record<string, unknown> } }).request.resource,
    );
    expect(resources.map((resource) => resource['attachmentByteCount'])).toEqual([
      directImage.byteLength,
      directImage.byteLength,
      directImage.byteLength + imageB.bytes.byteLength,
      directImage.byteLength,
    ]);
    expect(resources[2]).toMatchObject({
      providerTrust: 'trusted-local',
      attachmentManifestDigest: digestCanonical(compositeManifest),
    });
    for (const index of [0, 1, 3])
      expect(resources[index]).toMatchObject({
        providerTrust: 'trusted-local',
        attachmentManifestDigest: digestCanonical(directManifest),
      });
    expect(brokerDispatch).toHaveBeenCalledTimes(3);
    expect(providerToolImageFinalStateMatches).toHaveBeenCalledWith(
      started,
      expect.objectContaining({ image: 'B' }),
      connection,
    );
    expect(completeProviderTeamTurn).toHaveBeenCalledOnce();
  });

  it('covers tool-only local and both trusted-remote Provider egress matrix paths', async () => {
    const canonical = await canonicalizeProviderToolImage(
      await sharp({
        create: {
          width: 32,
          height: 32,
          channels: 3,
          background: { r: 25, g: 125, b: 225 },
        },
      })
        .png()
        .toBuffer(),
    );
    const toolResult = {
      path: 'fixture.png',
      mimeType: canonical.mimeType,
      byteLength: canonical.bytes.byteLength,
      sha256: canonical.sha256,
      dataUrl: `data:${canonical.mimeType};base64,${canonical.bytes.toString('base64')}`,
    };
    const directBytes = Buffer.from('direct-egress-matrix');
    const directImage = {
      id: 'direct-egress',
      mimeType: 'image/png' as const,
      byteLength: directBytes.byteLength,
      sha256: createHash('sha256').update(directBytes).digest('hex'),
    };
    const directManifest = [{ ...directImage, ordinal: 0 }];
    const toolManifest = [
      {
        id: 'tool:call-egress-image',
        mimeType: canonical.mimeType,
        byteLength: canonical.bytes.byteLength,
        sha256: canonical.sha256,
      },
    ];
    const scenarios = [
      { name: 'tool-only local', trust: 'trusted-local' as const, direct: false, tool: true },
      {
        name: 'direct-only trusted-remote',
        trust: 'trusted-remote' as const,
        direct: true,
        tool: false,
      },
      {
        name: 'trusted-remote direct-plus-denied-tool',
        trust: 'trusted-remote' as const,
        direct: true,
        tool: true,
      },
    ];

    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      const taskId = `task-egress-matrix-${scenarioIndex}`;
      const turnId = `turn-egress-matrix-${scenarioIndex}`;
      const userMessageId = `message-egress-matrix-${scenarioIndex}`;
      const connection = {
        id: `profile:ollama-egress-${scenarioIndex}`,
        providerId: 'ollama',
        runtimeKind: 'openai_compatible',
        displayName: scenario.name,
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
      let executeOrdinal = 0;
      const execute = vi.fn(() => {
        executeOrdinal += 1;
        const current = executeOrdinal;
        return (async function* () {
          if (scenario.tool && current === 1) {
            yield {
              type: 'tool_call' as const,
              callId: 'call-egress-image',
              name: 'view_image',
              input: { path: 'fixture.png' },
            };
            yield { type: 'completed' as const, stopReason: 'tool_calls' };
            return;
          }
          yield { type: 'output_delta' as const, text: 'egress matrix complete' };
          yield { type: 'completed' as const, stopReason: 'stop' };
        })();
      });
      const evaluate = vi.fn((_input: Record<string, unknown>) => ({
        decision: 'allow',
        reason: 'test_allow',
        policyEpoch: 1,
        evaluationTrace: ['test-allow'],
        permit: { id: 'test-permit' },
      }));
      const brokerDispatch = vi.fn(
        async (
          _request: unknown,
          consume?: (result: unknown) => Promise<unknown>,
        ): Promise<unknown> => consume?.(toolResult),
      );
      const prepareProviderTurnImageAttachments = vi.fn(() =>
        scenario.direct
          ? {
              binding: { kind: 'provider_inline' },
              inlineImages: [
                { mimeType: directImage.mimeType, base64: directBytes.toString('base64') },
              ],
              auditImages: [directImage],
              manifestDigest: digestCanonical(directManifest),
              byteCount: directImage.byteLength,
            }
          : undefined,
      );
      const completeProviderTeamTurn = vi.fn().mockResolvedValue('completed');
      const fakeRouter = Object.create(IpcRouter.prototype) as Record<string, unknown>;
      Object.assign(fakeRouter, {
        canceledRuntimeTurns: new Set<string>(),
        turnRuntimes: new Map([[turnId, 'provider']]),
        providerAbortByTurn: new Map(),
        providerExecutionIdByTurn: new Map(),
        managedWorkerTurn: new Map(),
        managedWorkerCall: new Map(),
        providerVerification: {
          requireVerifiedForExecution: vi.fn().mockResolvedValue(connection),
        },
        providerRegistry: { resolve: vi.fn(() => ({ execute, cancel: vi.fn() })) },
        modelCatalog: { find: vi.fn(() => ({ toolCalling: { value: true } })) },
        permissionBroker: {
          evaluate,
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
              content: 'describe the workspace image',
              createdAt: new Date(0).toISOString(),
              messageId: userMessageId,
            },
          ],
          projectItems: [],
          projectSnapshotDigest: null,
        })),
        prepareProviderTurnImageAttachments,
        providerImageAttachmentStillValid: vi.fn().mockResolvedValue(true),
        providerEgressTrustForConnection: () => scenario.trust,
        managedCodingHarness: {
          broker: { dispatch: brokerDispatch },
          startTurn: vi.fn(() => ({
            digest: 'a'.repeat(64),
            providerId: 'ollama',
            entries: [
              {
                providerName: 'view_image',
                inputSchema: {
                  type: 'object',
                  properties: { path: { type: 'string' } },
                  required: ['path'],
                  additionalProperties: false,
                },
              },
            ],
          })),
          finishTurn: vi.fn(),
        },
        teamCoordinator: { hasUnfinishedTeamWork: () => false },
        applyProviderTurnEvent: vi.fn(),
        captureProviderToolImageBinding: vi
          .fn()
          .mockResolvedValue(
            scenario.trust === 'trusted-local'
              ? { connectionDigest: digestCanonical(connection) }
              : null,
          ),
        revalidateProviderToolImageBinding: vi.fn().mockResolvedValue({ trust: 'trusted-local' }),
        providerToolImageFinalStateMatches: vi.fn().mockReturnValue(true),
        beginProviderSynthesis: vi.fn().mockResolvedValue(undefined),
        completeProviderTeamTurn,
        cancelProviderExecution: vi.fn().mockResolvedValue(undefined),
      });
      const started = {
        turnId,
        text: 'describe the workspace image',
        skills: [],
        event: { type: 'turn.accepted', taskId, userMessage: { id: userMessageId } },
        modelSelection: {
          connectionId: connection.id,
          requestedProvider: connection.providerId,
          requestedModel: 'qwen3-vl:4b-instruct-q4_K_M',
        },
        workspaceSet: { digest: 'workspace-digest', roots: [{ rootId: 'root-a' }] },
      };
      const startProviderTurn = Reflect.get(IpcRouter.prototype, 'startProviderTurn') as (
        this: typeof fakeRouter,
        started: unknown,
        connectionId: string,
        teamTurn: boolean,
        autoSkills: readonly unknown[],
      ) => Promise<void>;
      await startProviderTurn.call(fakeRouter, started, connection.id, false, []);

      const requests = (execute.mock.calls as unknown[][]).map(
        (call) =>
          call[1] as {
            messages: Array<{
              content: string;
              inlineImages?: Array<{ mimeType: string; base64: string }>;
              toolCallId?: string;
            }>;
          },
      );
      const resources = evaluate.mock.calls.map(
        ([input]) => (input as { request: { resource: Record<string, unknown> } }).request.resource,
      );
      if (scenario.name === 'tool-only local') {
        expect(resources).toHaveLength(3);
        expect(resources.map((resource) => resource['attachmentByteCount'])).toEqual([
          0,
          0,
          canonical.bytes.byteLength,
        ]);
        expect(resources[2]).toMatchObject({
          providerTrust: 'trusted-local',
          attachmentManifestDigest: digestCanonical(toolManifest),
        });
        expect(requests[1]!.messages.flatMap((message) => message.inlineImages ?? [])).toEqual([
          { mimeType: canonical.mimeType, base64: canonical.bytes.toString('base64') },
        ]);
        expect(brokerDispatch).toHaveBeenCalledOnce();
      } else if (scenario.name === 'direct-only trusted-remote') {
        expect(resources).toHaveLength(1);
        expect(resources[0]).toMatchObject({
          providerTrust: 'trusted-remote',
          attachmentByteCount: directImage.byteLength,
          attachmentManifestDigest: digestCanonical(directManifest),
        });
        expect(requests[0]!.messages.flatMap((message) => message.inlineImages ?? [])).toEqual([
          { mimeType: directImage.mimeType, base64: directBytes.toString('base64') },
        ]);
        expect(brokerDispatch).not.toHaveBeenCalled();
      } else {
        expect(resources).toHaveLength(2);
        for (const resource of resources)
          expect(resource).toMatchObject({
            providerTrust: 'trusted-remote',
            attachmentByteCount: directImage.byteLength,
            attachmentManifestDigest: digestCanonical(directManifest),
          });
        expect(brokerDispatch).not.toHaveBeenCalled();
        expect(requests[1]!.messages.flatMap((message) => message.inlineImages ?? [])).toEqual([
          { mimeType: directImage.mimeType, base64: directBytes.toString('base64') },
        ]);
        const rejection = requests[1]!.messages.find(
          (message) => message.toolCallId === 'call-egress-image',
        );
        expect(JSON.parse(rejection!.content)).toEqual({
          ok: false,
          error: {
            code: 'VIEW_IMAGE_NOT_PERMITTED',
            message: '画像の利用は許可されていません。',
          },
        });
        expect(JSON.stringify(requests)).not.toContain(canonical.bytes.toString('base64'));
      }
      expect(completeProviderTeamTurn, scenario.name).toHaveBeenCalledOnce();
    }
  });

  it('discards the pending image for every model-preparation drift before image-bearing execute', async () => {
    const cases: ReadonlyArray<readonly [string, (state: Record<string, unknown>) => void]> = [
      [
        'connection enabled',
        (state) => void ((state['connection'] as Record<string, unknown>)['enabled'] = false),
      ],
      [
        'connection runtime kind',
        (state) =>
          void ((state['connection'] as Record<string, unknown>)['runtimeKind'] = 'official_api'),
      ],
      [
        'connection provider id',
        (state) => void ((state['connection'] as Record<string, unknown>)['providerId'] = 'ollamI'),
      ],
      [
        'connection secret reference',
        (state) => {
          const connection = state['connection'] as Record<string, unknown>;
          const secrets = state['secrets'] as Map<string, string>;
          const newReference = 'provider-secret:00000000-0000-4000-8000-000000000022';
          const newBaseUrl = 'http://127.0.0.1:11435/v1';
          const newEndpointDigest = new ProviderEndpointPolicy().digestForBaseUrl(newBaseUrl);
          secrets.set(
            newReference,
            JSON.stringify({
              baseUrl: newBaseUrl,
              endpointDigest: newEndpointDigest,
              localConsentDigest: newEndpointDigest,
            }),
          );
          connection['secretReference'] = newReference;
        },
      ],
      [
        'connection verification status',
        (state) =>
          void ((
            (state['connection'] as Record<string, unknown>)['verification'] as Record<
              string,
              unknown
            >
          )['status'] = 'unverified'),
      ],
      [
        'connection verification expiry',
        (state) =>
          void ((
            (state['connection'] as Record<string, unknown>)['verification'] as Record<
              string,
              unknown
            >
          )['expiresAt'] = new Date(Date.now() - 1).toISOString()),
      ],
      [
        'connection updatedAt',
        (state) =>
          void ((state['connection'] as Record<string, unknown>)['updatedAt'] = new Date(
            9,
          ).toISOString()),
      ],
      [
        'task model selection',
        (state) =>
          void ((state['selection'] as Record<string, unknown>)['requestedModel'] = 'vision-drift'),
      ],
      [
        'model catalog revision',
        (state) => void ((state['modelCatalog'] as Record<string, unknown>)['revision'] = 8),
      ],
      [
        'model identity',
        (state) => void ((state['model'] as Record<string, unknown>)['modelId'] = 'vision-drift'),
      ],
      [
        'profile protocol',
        (state) => void ((state['profile'] as Record<string, unknown>)['protocol'] = 'responses'),
      ],
      [
        'profile base URL',
        (state) =>
          void ((state['profile'] as Record<string, unknown>)['baseUrl'] =
            'http://127.0.0.1:11435/v1'),
      ],
      [
        'profile configurable flag',
        (state) =>
          void ((state['profile'] as Record<string, unknown>)['baseUrlConfigurable'] = false),
      ],
      [
        'profile authentication',
        (state) =>
          void ((
            (state['profile'] as Record<string, unknown>)['authentication'] as Record<
              string,
              unknown
            >
          )['scheme'] = 'Token'),
      ],
      [
        'profile required credentials',
        (state) =>
          void ((state['profile'] as Record<string, unknown>)['requiredCredentialFields'] = [
            'api_key',
          ]),
      ],
      [
        'profile native lifecycle',
        (state) =>
          void Reflect.deleteProperty(
            state['profile'] as Record<string, unknown>,
            'nativeModelLifecycle',
          ),
      ],
      [
        'capability false',
        (state) => void ((state['capability'] as Record<string, unknown>)['value'] = false),
      ],
      [
        'capability unknown',
        (state) => void ((state['capability'] as Record<string, unknown>)['value'] = null),
      ],
      [
        'capability revision',
        (state) =>
          void ((state['capability'] as Record<string, unknown>)['revision'] = 'vision-drift'),
      ],
      [
        'capability stale',
        (state) =>
          void ((state['capability'] as Record<string, unknown>)['capturedAtMs'] =
            Date.now() - 5_001),
      ],
      [
        'lexical execution connection',
        (state) => {
          const executionConnection = state['executionConnection'] as Record<string, unknown>;
          const secrets = state['secrets'] as Map<string, string>;
          const remoteReference = 'provider-secret:00000000-0000-4000-8000-000000000023';
          const remoteBaseUrl = 'https://vision.example/v1';
          const remoteEndpointDigest = new ProviderEndpointPolicy().digestForBaseUrl(remoteBaseUrl);
          executionConnection['displayName'] = 'Lexical trusted-remote A';
          executionConnection['secretReference'] = remoteReference;
          secrets.set(
            remoteReference,
            JSON.stringify({
              baseUrl: remoteBaseUrl,
              endpointDigest: remoteEndpointDigest,
              localConsentDigest: remoteEndpointDigest,
            }),
          );
        },
      ],
      [
        'dns wait connection',
        (state) => void ((state['connection'] as Record<string, unknown>)['enabled'] = false),
      ],
      [
        'dns wait registry profile',
        (state) => void ((state['profile'] as Record<string, unknown>)['protocol'] = 'responses'),
      ],
      [
        'dns wait capability false',
        (state) => void ((state['capability'] as Record<string, unknown>)['value'] = false),
      ],
      [
        'dns wait capability unknown',
        (state) => void ((state['capability'] as Record<string, unknown>)['value'] = null),
      ],
      [
        'dns wait capability revision',
        (state) =>
          void ((state['capability'] as Record<string, unknown>)['revision'] = 'dns-drift'),
      ],
      [
        'final capability wait connection',
        (state) => void ((state['connection'] as Record<string, unknown>)['enabled'] = false),
      ],
      [
        'final capability wait task selection',
        (state) =>
          void ((state['selection'] as Record<string, unknown>)['requestedModel'] = 'vision-drift'),
      ],
      [
        'final capability wait registry profile',
        (state) =>
          void ((state['profile'] as Record<string, unknown>)['baseUrlConfigurable'] = false),
      ],
    ];

    const editCredential = (
      state: Record<string, unknown>,
      edit: (credential: Record<string, unknown>) => void,
    ): void => {
      const connection = state['connection'] as Record<string, unknown>;
      const secrets = state['secrets'] as Map<string, string>;
      const reference = String(connection['secretReference']);
      const credential = JSON.parse(secrets.get(reference)!) as Record<string, unknown>;
      edit(credential);
      secrets.set(reference, JSON.stringify(credential));
    };
    const acceptanceNames = new Set([
      'connection enabled',
      'connection runtime kind',
      'connection provider id',
      'connection verification status',
      'connection verification expiry',
      'profile protocol',
      'capability false',
      'capability unknown',
      'capability stale',
    ]);
    const acceptanceCases: ReadonlyArray<
      readonly [string, (state: Record<string, unknown>) => void]
    > = [
      ...cases.filter(([name]) => acceptanceNames.has(name)),
      [
        'verification not required',
        (state) =>
          void ((
            (state['connection'] as Record<string, unknown>)['verification'] as Record<
              string,
              unknown
            >
          )['status'] = 'not_required'),
      ],
      [
        'verification timestamp missing',
        (state) =>
          void Reflect.deleteProperty(
            (state['connection'] as Record<string, unknown>)['verification'] as Record<
              string,
              unknown
            >,
            'verifiedAt',
          ),
      ],
      [
        'verification timestamp invalid',
        (state) =>
          void ((
            (state['connection'] as Record<string, unknown>)['verification'] as Record<
              string,
              unknown
            >
          )['verifiedAt'] = 'not-a-date'),
      ],
      [
        'verification timestamp future',
        (state) =>
          void ((
            (state['connection'] as Record<string, unknown>)['verification'] as Record<
              string,
              unknown
            >
          )['verifiedAt'] = new Date(Date.now() + 60_000).toISOString()),
      ],
      [
        'verification expiry equals verified',
        (state) => {
          const verification = (state['connection'] as Record<string, unknown>)[
            'verification'
          ] as Record<string, unknown>;
          verification['expiresAt'] = verification['verifiedAt'];
        },
      ],
      [
        'credential resolution failure',
        (state) => {
          const connection = state['connection'] as Record<string, unknown>;
          (state['secrets'] as Map<string, string>).delete(String(connection['secretReference']));
        },
      ],
      [
        'credential endpoint digest missing',
        (state) => editCredential(state, (credential) => void delete credential['endpointDigest']),
      ],
      [
        'credential endpoint digest mismatch',
        (state) =>
          editCredential(
            state,
            (credential) => void (credential['endpointDigest'] = '0'.repeat(64)),
          ),
      ],
      [
        'credential consent digest missing',
        (state) =>
          editCredential(state, (credential) => void delete credential['localConsentDigest']),
      ],
      [
        'credential consent digest mismatch',
        (state) =>
          editCredential(
            state,
            (credential) => void (credential['localConsentDigest'] = '0'.repeat(64)),
          ),
      ],
      [
        'credential required field missing',
        (state) =>
          void ((state['profile'] as Record<string, unknown>)['requiredCredentialFields'] = [
            'api_key',
          ]),
      ],
      [
        'credential LAN endpoint',
        (state) =>
          editCredential(state, (credential) => {
            const url = 'https://192.168.1.2/v1';
            const digest = new ProviderEndpointPolicy().digestForBaseUrl(url);
            credential['baseUrl'] = url;
            credential['endpointDigest'] = digest;
            credential['localConsentDigest'] = digest;
          }),
      ],
      [
        'credential trusted remote endpoint',
        (state) =>
          editCredential(state, (credential) => {
            const url = 'https://vision.example/v1';
            const digest = new ProviderEndpointPolicy().digestForBaseUrl(url);
            credential['baseUrl'] = url;
            credential['endpointDigest'] = digest;
            credential['localConsentDigest'] = digest;
          }),
      ],
      [
        'profile ID lookalike',
        (state) => void ((state['profile'] as Record<string, unknown>)['id'] = 'ollamI'),
      ],
      [
        'required account ID empty',
        (state) => {
          (state['profile'] as Record<string, unknown>)['requiredCredentialFields'] = [
            'account_id',
          ];
          editCredential(state, (credential) => void (credential['accountId'] = ''));
        },
      ],
      [
        'verification expiry missing',
        (state) =>
          void Reflect.deleteProperty(
            (state['connection'] as Record<string, unknown>)['verification'] as Record<
              string,
              unknown
            >,
            'expiresAt',
          ),
      ],
      [
        'secret reference missing',
        (state) =>
          void ((state['connection'] as Record<string, unknown>)['secretReference'] = null),
      ],
      [
        'connection ID drift',
        (state) =>
          void ((state['connection'] as Record<string, unknown>)['id'] = 'profile:ollama-other'),
      ],
      [
        'persisted connection selection drift',
        (state) =>
          void ((state['selection'] as Record<string, unknown>)['connectionId'] =
            'profile:ollama-other'),
      ],
      [
        'persisted provider selection drift',
        (state) =>
          void ((state['selection'] as Record<string, unknown>)['requestedProvider'] = 'ollamI'),
      ],
      [
        'persisted model selection drift',
        (state) =>
          void ((state['selection'] as Record<string, unknown>)['requestedModel'] = 'vision-other'),
      ],
      [
        'started model selection drift',
        (state) =>
          void ((state['startedSelection'] as Record<string, unknown>)['requestedModel'] =
            'vision-other'),
      ],
      ['runtime registry mismatch', (state) => void (state['registryMismatch'] = true)],
      ['model missing', (state) => void (state['modelMissing'] = true)],
      [
        'model connection drift',
        (state) =>
          void ((state['model'] as Record<string, unknown>)['connectionId'] =
            'profile:ollama-other'),
      ],
      [
        'model provider drift',
        (state) => void ((state['model'] as Record<string, unknown>)['providerId'] = 'ollamI'),
      ],
      [
        'model identity drift',
        (state) => void ((state['model'] as Record<string, unknown>)['modelId'] = 'vision-other'),
      ],
      ['capability missing', (state) => void (state['capabilityMissing'] = true)],
      ['capability probe exception', (state) => void (state['capabilityProbeThrows'] = true)],
      [
        'internal managed-local connection',
        (state) => {
          const connection = state['connection'] as Record<string, unknown>;
          Object.assign(connection, managedLocalConnection(new Date(0)));
        },
      ],
    ];
    const allCases: ReadonlyArray<readonly [string, (state: Record<string, unknown>) => void]> = [
      ...cases,
      ...acceptanceCases.map(([name, mutate]) => [`acceptance ${name}`, mutate] as const),
    ];

    for (const [caseIndex, [name, mutate]] of allCases.entries()) {
      const taskId = `task-tool-image-drift-${caseIndex}`;
      const turnId = `turn-tool-image-drift-${caseIndex}`;
      const userMessageId = `message-tool-image-drift-${caseIndex}`;
      const modelId = 'qwen3-vl:4b-instruct-q4_K_M';
      const mutatesBeforeBrokerAcceptance =
        name === 'lexical execution connection' || name.startsWith('acceptance ');
      const mutatesDuringDns = name.startsWith('dns wait ');
      const mutatesDuringFinalCapability = name.startsWith('final capability wait ');
      const baseUrl = mutatesDuringDns ? 'http://localhost:11434/v1' : 'http://127.0.0.1:11434/v1';
      const stateRef: { current: Record<string, unknown> | undefined } = { current: undefined };
      let dnsLookupCount = 0;
      const endpointPolicy = new ProviderEndpointPolicy(async () => {
        dnsLookupCount += 1;
        if (mutatesDuringDns && dnsLookupCount === 2) mutate(stateRef.current!);
        return [
          { address: '127.0.0.1', family: 4 },
          { address: '::1', family: 6 },
        ];
      });
      const endpointDigest = endpointPolicy.digestForBaseUrl(baseUrl);
      const connection = {
        id: `profile:ollama-drift-${caseIndex}`,
        providerId: 'ollama',
        runtimeKind: 'openai_compatible',
        displayName: 'Ollama',
        enabled: true,
        secretReference: 'provider-secret:00000000-0000-4000-8000-000000000021',
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
      const acceptedConnectionId = connection.id;
      const executionConnection = structuredClone(connection);
      const selection = {
        connectionId: connection.id,
        requestedProvider: connection.providerId,
        requestedModel: modelId,
      };
      const startedSelection = structuredClone(selection);
      const profile = {
        id: 'ollama',
        displayName: 'Ollama',
        baseUrl,
        baseUrlConfigurable: true,
        computeLocation: 'local',
        nativeModelLifecycle: 'ollama',
        protocol: 'chat_completions',
        modelsPath: '/models',
        curatedModels: [],
        verificationModel: null,
        authentication: { headerName: 'Authorization', scheme: 'Bearer' },
        requiredCredentialFields: [],
        errorOverrides: [],
        sourceReference: 'https://ollama.com/',
        reviewedAt: new Date(0).toISOString(),
      };
      const secrets = new Map([
        [
          connection.secretReference,
          JSON.stringify({ baseUrl, endpointDigest, localConsentDigest: endpointDigest }),
        ],
      ]);
      const model = {
        connectionId: connection.id,
        providerId: connection.providerId,
        modelId,
        toolCalling: { value: true },
      };
      let modelFindCalls = 0;
      const modelCatalog = {
        revision: 7,
        find: vi.fn(() => {
          modelFindCalls += 1;
          return stateRef.current?.['modelMissing'] === true && modelFindCalls > 1
            ? undefined
            : model;
        }),
      };
      const capability = {
        value: true as boolean | null,
        revision: 'vision-stable',
        capturedAtMs: Date.now(),
      };
      const source = await sharp({
        create: {
          width: 32,
          height: 32,
          channels: 3,
          background: { r: 90, g: 100, b: 110 },
        },
      })
        .png()
        .toBuffer();
      const canonical = await canonicalizeProviderToolImage(source);
      const toolResult = {
        path: 'fixture.png',
        mimeType: canonical.mimeType,
        byteLength: canonical.bytes.byteLength,
        sha256: canonical.sha256,
        dataUrl: `data:${canonical.mimeType};base64,${canonical.bytes.toString('base64')}`,
      };
      let executeOrdinal = 0;
      const execute = vi.fn(() => {
        executeOrdinal += 1;
        return (async function* () {
          if (executeOrdinal === 1) {
            yield {
              type: 'tool_call' as const,
              callId: 'call-image-drift',
              name: 'view_image',
              input: { path: 'fixture.png' },
            };
            yield { type: 'completed' as const, stopReason: 'tool_calls' };
            return;
          }
          yield { type: 'output_delta' as const, text: 'unexpected image dispatch' };
          yield { type: 'completed' as const, stopReason: 'stop' };
        })();
      });
      const state: Record<string, unknown> = {
        capability,
        connection,
        executionConnection,
        model,
        modelCatalog,
        profile,
        secrets,
        selection,
        startedSelection,
      };
      stateRef.current = state;
      if (mutatesBeforeBrokerAcceptance) mutate(state);
      const lease = {
        prepare: vi.fn(async () => {
          if (!mutatesBeforeBrokerAcceptance && !mutatesDuringDns && !mutatesDuringFinalCapability)
            mutate(state);
        }),
        release: vi.fn().mockResolvedValue(undefined),
      };
      let capabilityCaptureCount = 0;
      const runtime = {
        execute,
        cancel: vi.fn().mockResolvedValue(undefined),
        acquireModelLease: vi.fn().mockResolvedValue(lease),
        captureImageInputCapability: vi.fn(async () => {
          capabilityCaptureCount += 1;
          if (mutatesDuringFinalCapability && capabilityCaptureCount === 3) mutate(state);
          if (state['capabilityProbeThrows'] === true)
            throw new Error('PROBE_EXCEPTION_SECRET data:image/png;base64,PRIVATE');
          if (state['capabilityMissing'] === true) return undefined;
          return { ...capability };
        }),
      };
      let verificationCalls = 0;
      const requireVerifiedForExecution = vi.fn(async () => {
        verificationCalls += 1;
        return verificationCalls === 1 ? executionConnection : connection;
      });
      const brokerDispatch = vi.fn(
        async (_request: unknown, consume: (value: unknown) => Promise<unknown>) =>
          consume(toolResult),
      );
      const evaluate = vi.fn((_input: Record<string, unknown>) => ({
        decision: 'allow',
        reason: 'test_allow',
        policyEpoch: 1,
        evaluationTrace: ['test-allow'],
        permit: { id: 'test-permit' },
      }));
      const appendDelta = vi.fn(() => ({ type: 'message.delta' }));
      const finishAndAdvance = vi.fn();
      const completeProviderTeamTurn = vi.fn();
      const genericRecord = vi.fn();
      const fakeRouter = Object.create(IpcRouter.prototype) as Record<string, unknown>;
      Object.assign(fakeRouter, {
        canceledRuntimeTurns: new Set<string>(),
        turnRuntimes: new Map([[turnId, 'provider']]),
        providerAbortByTurn: new Map(),
        providerExecutionIdByTurn: new Map(),
        managedWorkerTurn: new Map(),
        providerVerification: { requireVerifiedForExecution },
        providerRegistry: {
          resolve: vi.fn((candidate: unknown) =>
            candidate !== executionConnection && state['registryMismatch'] === true
              ? { execute: vi.fn(), cancel: vi.fn() }
              : runtime,
          ),
        },
        compatibleRuntime: runtime,
        providerProfiles: { get: () => profile },
        providerSecrets: { get: (reference: string) => secrets.get(reference) },
        providerEndpointPolicy: endpointPolicy,
        modelCatalog,
        permissionBroker: {
          evaluate,
          revalidate: vi.fn(() => ({ valid: true, reason: 'test_valid' })),
        },
        persistence: {
          getTask: () => ({ id: taskId, projectId: null, localOnly: false }),
          getProviderConnection: () => connection,
          getTaskModelSelection: () => selection,
          getImageAttachmentAcceptanceSelection: () => ({
            taskId,
            runtimeKind: 'provider',
            model: selection.requestedModel,
            modelSelection: selection,
          }),
          getPermissionPolicy: () => ({ policyEpoch: 1 }),
          getActiveTurnId: () => turnId,
          changeStage: vi.fn(() => ({ type: 'stage.changed' })),
          appendDelta,
        },
        mailbox: { run: async (_taskId: string, action: () => unknown) => action() },
        publish: vi.fn(),
        finishAndAdvance,
        ensureProviderEndpointConsent: vi.fn().mockResolvedValue(undefined),
        prepareContext: vi.fn(() => ({
          fragments: [
            {
              id: 'current',
              taskId,
              source: 'history',
              trust: 'user',
              tokenEstimate: 1,
              content: 'describe the workspace image',
              createdAt: new Date(0).toISOString(),
              messageId: userMessageId,
            },
          ],
          projectItems: [],
          projectSnapshotDigest: null,
        })),
        prepareProviderTurnImageAttachments: vi.fn(() => undefined),
        providerEgressTrustForConnection: (candidate: { secretReference: string | null }) =>
          candidate.secretReference === 'provider-secret:00000000-0000-4000-8000-000000000023'
            ? 'trusted-remote'
            : 'trusted-local',
        managedCodingHarness: {
          broker: { dispatch: brokerDispatch },
          startTurn: vi.fn(() => ({
            digest: 'a'.repeat(64),
            providerId: 'ollama',
            entries: [
              {
                providerName: 'view_image',
                inputSchema: {
                  type: 'object',
                  properties: { path: { type: 'string' } },
                  required: ['path'],
                  additionalProperties: false,
                },
              },
            ],
          })),
          finishTurn: vi.fn(),
        },
        cliTeamWorkerRuntime: { recordManagedToolResult: genericRecord },
        teamCoordinator: { hasUnfinishedTeamWork: () => false },
        applyProviderTurnEvent: vi.fn(),
        completeProviderTeamTurn,
        cancelProviderExecution: vi.fn().mockResolvedValue(undefined),
      });
      const started = {
        turnId,
        text: 'describe the workspace image',
        skills: [],
        event: { type: 'turn.accepted', taskId, userMessage: { id: userMessageId } },
        modelSelection: structuredClone(startedSelection),
        workspaceSet: { digest: 'workspace-digest', roots: [{ rootId: 'root-a' }] },
      };
      const startProviderTurn = Reflect.get(IpcRouter.prototype, 'startProviderTurn') as (
        this: typeof fakeRouter,
        started: unknown,
        connectionId: string,
        teamTurn: boolean,
        autoSkills: readonly unknown[],
      ) => Promise<void>;

      const errorLog = mutatesBeforeBrokerAcceptance
        ? vi.spyOn(secureLogger, 'error').mockImplementation(() => undefined)
        : null;
      const warnLog = mutatesBeforeBrokerAcceptance
        ? vi.spyOn(secureLogger, 'warn').mockImplementation(() => undefined)
        : null;

      await startProviderTurn.call(fakeRouter, started, acceptedConnectionId, false, []);

      expect(execute, name).toHaveBeenCalledTimes(mutatesBeforeBrokerAcceptance ? 2 : 1);
      expect(brokerDispatch, name).toHaveBeenCalledTimes(mutatesBeforeBrokerAcceptance ? 0 : 1);
      expect(
        evaluate.mock.calls.some(
          ([input]) =>
            Number(
              (input as { request: { resource: Record<string, unknown> } }).request.resource[
                'attachmentByteCount'
              ],
            ) > 0,
        ),
        name,
      ).toBe(false);
      expect(JSON.stringify(execute.mock.calls), name).not.toContain(
        canonical.bytes.toString('base64'),
      );
      expect(JSON.stringify(appendDelta.mock.calls), name).not.toContain('data:image/');
      if (mutatesDuringDns) {
        expect(dnsLookupCount, name).toBe(2);
        expect(capabilityCaptureCount, name).toBe(name === 'dns wait connection' ? 2 : 3);
      }
      if (mutatesDuringFinalCapability) expect(capabilityCaptureCount, name).toBe(3);
      if (mutatesBeforeBrokerAcceptance) {
        const secondRequest = (execute.mock.calls as unknown[][])[1]?.[1] as {
          messages: Array<{
            role: string;
            content: string;
            toolCallId?: string;
            toolName?: string;
          }>;
        };
        expect(secondRequest.messages).toContainEqual(
          expect.objectContaining({
            role: 'tool',
            toolCallId: 'call-image-drift',
            toolName: 'view_image',
            content: expect.stringContaining('VIEW_IMAGE_NOT_PERMITTED'),
          }),
        );
        const fixedFailure = secondRequest.messages.find(
          (message) => message.toolCallId === 'call-image-drift',
        );
        expect(JSON.parse(fixedFailure!.content), name).toEqual({
          ok: false,
          error: {
            code: 'VIEW_IMAGE_NOT_PERMITTED',
            message: '画像の利用は許可されていません。',
          },
        });
        expect(JSON.stringify(secondRequest), name).not.toMatch(
          /data:image\/|127\.0\.0\.1|localhost|vision\.example|192\.168\.1\.2/u,
        );
        expect(genericRecord, name).not.toHaveBeenCalled();
        expect(errorLog?.mock.calls ?? [], name).toEqual([]);
        expect(warnLog?.mock.calls ?? [], name).toEqual([]);
        expect(
          JSON.stringify([
            execute.mock.calls,
            appendDelta.mock.calls,
            evaluate.mock.calls,
            errorLog?.mock.calls,
            warnLog?.mock.calls,
          ]),
          name,
        ).not.toMatch(/PROBE_EXCEPTION_SECRET|data:image\//u);
        expect(completeProviderTeamTurn, name).toHaveBeenCalledOnce();
      } else {
        expect(appendDelta, name).toHaveBeenCalledWith(
          taskId,
          turnId,
          expect.any(String),
          '画像入力の準備状況が変わったため、Providerへ画像を送信しませんでした。もう一度添付してください。',
        );
        expect(finishAndAdvance, name).toHaveBeenCalledWith(taskId, turnId, 'failed');
        expect(completeProviderTeamTurn, name).not.toHaveBeenCalled();
      }
      if (name === 'connection secret reference') {
        expect(secrets.has('provider-secret:00000000-0000-4000-8000-000000000021')).toBe(true);
        expect(
          JSON.parse(secrets.get('provider-secret:00000000-0000-4000-8000-000000000021')!),
        ).toEqual({ baseUrl, endpointDigest, localConsentDigest: endpointDigest });
        expect(
          JSON.parse(secrets.get('provider-secret:00000000-0000-4000-8000-000000000022')!),
        ).not.toEqual({ baseUrl, endpointDigest, localConsentDigest: endpointDigest });
      }
      errorLog?.mockRestore();
      warnLog?.mockRestore();
    }
  });

  it('replaces an unknown Provider stream throw with a fixed safe cause', async () => {
    async function* unsafeStream(seed: readonly never[] = []): AsyncIterable<never> {
      yield* seed;
      throw new Error('raw token /Users/private endpoint=https://secret.example');
    }
    let captured: unknown;
    try {
      for await (const _event of providerEventsWithSafeFailure(unsafeStream(), 'not_required')) {
        // The source never yields.
      }
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({
      name: 'ProviderTurnFailureError',
      cause: {
        failureStage: 'stream_error',
        category: 'internal',
        retryable: false,
      },
    });
    expect(JSON.stringify(captured)).not.toContain('/Users/private');
    expect(JSON.stringify(captured)).not.toContain('secret.example');
  });

  it('persists an owned Provider failure best-effort and excludes canceled Turns', async () => {
    const recordRuntimeFailureDiagnostic = vi.fn(
      (_taskId: string, _turnId: string, diagnostic: { diagnosticId: string }) => ({
        ...diagnostic,
        taskId: 'task-provider-failure',
        turnId: 'turn-provider-failure',
      }),
    );
    const finishAndAdvance = vi.fn();
    const fakeRouter = {
      canceledRuntimeTurns: new Set<string>(),
      turnRuntimes: new Map([['turn-provider-failure', 'provider']]),
      persistence: {
        getActiveTurnId: () => 'turn-provider-failure',
        recordRuntimeFailureDiagnostic,
        appendDelta: vi.fn(),
      },
      mailbox: { run: async (_taskId: string, action: () => unknown) => action() },
      publish: vi.fn(),
      finishAndAdvance,
    };
    const finishProviderFailureWithDiagnostic = Reflect.get(
      IpcRouter.prototype,
      'finishProviderFailureWithDiagnostic',
    ) as (this: typeof fakeRouter, input: Record<string, unknown>) => Promise<void>;
    const input = {
      taskId: 'task-provider-failure',
      turnId: 'turn-provider-failure',
      messageId: 'message-provider-failure',
      synthesizing: false,
      startedAtMs: Date.now() - 10,
      provider: { providerId: 'ollama', profileId: 'ollama' },
      cause: {
        failureStage: 'network',
        category: 'network',
        retryable: true,
        providerCode: null,
        modelPreparation: 'completed',
      },
    };

    await finishProviderFailureWithDiagnostic.call(fakeRouter, input);
    expect(recordRuntimeFailureDiagnostic).toHaveBeenCalledTimes(1);
    expect(recordRuntimeFailureDiagnostic.mock.calls[0]?.[2]).toMatchObject({
      runtimeKind: 'provider',
      failureStage: 'network',
      providerId: 'ollama',
    });
    expect(finishAndAdvance).toHaveBeenCalledWith(
      'task-provider-failure',
      'turn-provider-failure',
      'failed',
    );

    recordRuntimeFailureDiagnostic.mockClear();
    finishAndAdvance.mockClear();
    fakeRouter.canceledRuntimeTurns.add('turn-provider-failure');
    await finishProviderFailureWithDiagnostic.call(fakeRouter, input);
    expect(recordRuntimeFailureDiagnostic).not.toHaveBeenCalled();
    expect(finishAndAdvance).not.toHaveBeenCalled();

    fakeRouter.canceledRuntimeTurns.clear();
    recordRuntimeFailureDiagnostic.mockImplementationOnce(() => {
      throw new Error('sqlite unavailable');
    });
    await finishProviderFailureWithDiagnostic.call(fakeRouter, input);
    expect(finishAndAdvance).toHaveBeenCalledWith(
      'task-provider-failure',
      'turn-provider-failure',
      'failed',
    );
  });

  it('derives Leader MCP Team capability only from the sealed Team Turn contract', () => {
    expect(leaderMcpCapabilities(true)).toEqual({ role: 'leader', allowTeamTools: true });
    expect(leaderMcpCapabilities(false)).toEqual({ role: 'leader', allowTeamTools: false });
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

  it('enters Provider synthesis only at the final tool-free boundary', async () => {
    const changeStage = vi.fn(() => ({ type: 'stage.changed' }));
    const publish = vi.fn();
    const fakeRouter = {
      persistence: { changeStage },
      mailbox: { run: async (_taskId: string, action: () => unknown) => action() },
      turnRuntimes: new Map([['turn-provider', 'provider']]),
      publish,
    };
    const beginProviderSynthesis = Reflect.get(IpcRouter.prototype, 'beginProviderSynthesis') as (
      this: typeof fakeRouter,
      taskId: string,
      turnId: string,
    ) => Promise<void>;

    await beginProviderSynthesis.call(fakeRouter, 'task-provider', 'turn-provider');

    expect(changeStage).toHaveBeenCalledWith('task-provider', 'turn-provider', 'synthesizing');
    expect(publish).toHaveBeenCalledWith({ type: 'stage.changed' });
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
  it('recognizes only complete workspace reads as verification evidence', () => {
    const complete = {
      rootId: 'root-1',
      path: 'generated/file.ts',
      content: 'verified',
      truncated: false,
    } as const;

    expect(isCompleteProviderWorkspaceRead(complete)).toBe(true);
    expect(isCompleteProviderWorkspaceRead({ ...complete, truncated: true })).toBe(false);
    expect(isCompleteProviderWorkspaceRead({ ...complete, content: undefined })).toBe(false);
  });

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
    expect(providerWorkspaceToolsEligible(true, 1, true)).toBe(true);
    expect(providerWorkspaceToolsEligible(true, 0, true)).toBe(true);
    expect(providerWorkspaceToolsEligible(false, 0, true)).toBe(false);
  });

  it('requires a first-round Managed Local tool for explicit workspace operations only', () => {
    expect(managedLocalWorkspaceToolUseRequired('create_fileでsrc/a.tsを作成')).toBe(true);
    expect(managedLocalWorkspaceToolUseRequired('このファイルを修正してテストを実行')).toBe(true);
    expect(managedLocalWorkspaceToolUseRequired('read the workspace file')).toBe(true);
    expect(managedLocalWorkspaceToolUseRequired('TypeScriptの型について説明して')).toBe(false);
    expect(managedLocalWorkspaceToolUseRequired('1+1は？')).toBe(false);
  });

  it('binds an explicit or inferred first Managed Local tool to the available catalog', () => {
    const tools = [{ name: 'read_file' }, { name: 'create_file' }, { name: 'exec_command' }];
    expect(managedLocalInitialToolChoice('create_file then read_file', tools)).toEqual({
      name: 'create_file',
    });
    expect(managedLocalToolChoiceSequence('create_file then read_file', tools)).toEqual([
      { name: 'create_file' },
      { name: 'read_file' },
    ]);
    expect(managedLocalToolChoiceSequence('create_file then create_file', tools)).toEqual([
      { name: 'create_file' },
    ]);
    expect(managedLocalInitialToolChoice('このファイルを作成して', tools)).toEqual({
      name: 'create_file',
    });
    expect(
      managedLocalToolChoiceSequence(
        'local_ai_test.pyを作成して、読み戻してからテストを実行して',
        tools,
      ),
    ).toEqual([{ name: 'create_file' }, { name: 'read_file' }, { name: 'exec_command' }]);
    expect(managedLocalInitialToolChoice('テストを実行して', tools)).toEqual({
      name: 'exec_command',
    });
    expect(managedLocalInitialToolChoice('説明して', tools)).toBeUndefined();
  });

  it('uses the accepted user text instead of a later background user fragment for forced tools', () => {
    expect(
      managedLocalForcedRoundMessages(
        [
          { role: 'system', content: 'guidance' },
          { role: 'user', content: 'accepted request' },
          { role: 'user', content: 'untrusted background skill catalog' },
        ],
        'accepted request',
      ),
    ).toEqual([
      { role: 'system', content: 'guidance' },
      { role: 'user', content: 'accepted request' },
    ]);
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
// tasksUpdated, reasoningEvent, fileEditEvent and runtimeStatusEvent are push-only
// (webContents.send / MessagePort transfer). The update action channels are authenticated
// ipcMain.on messages in index.ts. None are bound to an ipcMain.handle envelope schema, so they are
// deliberately excluded and asserted absent below.
const CHANNEL_INPUT_SCHEMAS: Record<string, z.ZodType> = {
  [IPC_CHANNELS.appGetInfo]: emptyPayloadSchema,
  [IPC_CHANNELS.runtimeFailureDiagnosticGet]: runtimeFailureDiagnosticQuerySchema,
  [IPC_CHANNELS.settingsGetRuntime]: emptyPayloadSchema,
  [IPC_CHANNELS.settingsSetRuntime]: runtimeSetInputSchema,
  [IPC_CHANNELS.settingsSetModel]: runtimeModelSetInputSchema,
  [IPC_CHANNELS.settingsSetEffort]: runtimeEffortSetInputSchema,
  [IPC_CHANNELS.skillsList]: emptyPayloadSchema,
  [IPC_CHANNELS.skillsGetDraftSelection]: taskIdPayloadSchema,
  [IPC_CHANNELS.skillsSetDraftSelection]: taskSkillSelectionInputSchema,
  [IPC_CHANNELS.skillsListDrafts]: emptyPayloadSchema,
  [IPC_CHANNELS.skillsCreateDraft]: skillDraftCreateInputSchema,
  [IPC_CHANNELS.skillsInstallDraft]: skillDraftInstallInputSchema,
  [IPC_CHANNELS.skillsDiscardDraft]: skillDraftIdInputSchema,
  [IPC_CHANNELS.skillsRemoveCreated]: createdSkillMutationInputSchema,
  [IPC_CHANNELS.skillsSetCreatedEnabled]: createdSkillEnabledInputSchema,
  [IPC_CHANNELS.skillsSetActivationPolicy]: skillActivationPolicyInputSchema,
  [IPC_CHANNELS.skillsExportCreated]: skillExportInputSchema,
  [IPC_CHANNELS.filesList]: taskIdPayloadSchema,
  [IPC_CHANNELS.filesPick]: taskIdPayloadSchema,
  [IPC_CHANNELS.filesOpen]: filePathPayloadSchema,
  [IPC_CHANNELS.filesRecover]: filePathPayloadSchema,
  [IPC_CHANNELS.filesSave]: fileSaveInputSchema,
  [IPC_CHANNELS.imagesList]: taskIdPayloadSchema,
  [IPC_CHANNELS.imagesRead]: generatedImageRefSchema,
  [IPC_CHANNELS.attachmentsCapability]: taskIdPayloadSchema,
  [IPC_CHANNELS.attachmentsPick]: taskIdPayloadSchema,
  [IPC_CHANNELS.attachmentsPaste]: taskIdPayloadSchema,
  [IPC_CHANNELS.attachmentsListDraft]: taskIdPayloadSchema,
  [IPC_CHANNELS.attachmentsPreview]: imageAttachmentPreviewInputSchema,
  [IPC_CHANNELS.attachmentsRemove]: imageAttachmentRemoveInputSchema,
  [IPC_CHANNELS.settingsSetCodexEffort]: runtimeCodexEffortSetInputSchema,
  [IPC_CHANNELS.modelsCatalogQuery]: modelCatalogQueryInputSchema,
  [IPC_CHANNELS.modelsSetSelection]: modelCatalogSelectionSetInputSchema,
  [IPC_CHANNELS.providersListConnections]: emptyPayloadSchema,
  [IPC_CHANNELS.providersListProfiles]: emptyPayloadSchema,
  [IPC_CHANNELS.providersCreateOpenAIConnection]: openAIConnectionCreateInputSchema,
  [IPC_CHANNELS.providersCreateOpenRouterConnection]: openRouterConnectionCreateInputSchema,
  [IPC_CHANNELS.providersCreateOrcaRouterConnection]: orcaRouterConnectionCreateInputSchema,
  [IPC_CHANNELS.providersCreateAnthropicConnection]: anthropicConnectionCreateInputSchema,
  [IPC_CHANNELS.providersCreateGeminiConnection]: geminiConnectionCreateInputSchema,
  [IPC_CHANNELS.providersCreateXAIConnection]: xAIConnectionCreateInputSchema,
  [IPC_CHANNELS.providersCreateProfileConnection]: providerProfileConnectionCreateInputSchema,
  [IPC_CHANNELS.providersVerifyConnection]: z.object({ connectionId: connectionIdSchema }).strict(),
  [IPC_CHANNELS.providersLowerRateLimits]: providerConnectionRateLimitLowerInputSchema,
  [IPC_CHANNELS.providersSetAutomaticModelRelease]: providerConnectionModelReleaseUpdateInputSchema,
  [IPC_CHANNELS.localAIHardware]: emptyPayloadSchema,
  [IPC_CHANNELS.localAIRuntime]: emptyPayloadSchema,
  [IPC_CHANNELS.localAILaunchSettings]: managedLocalLaunchSettingsGetInputSchema,
  [IPC_CHANNELS.localAISetLaunchSettings]: managedLocalLaunchSettingsSetInputSchema,
  [IPC_CHANNELS.localAIInferenceSettings]: managedLocalInferenceSettingsGetInputSchema,
  [IPC_CHANNELS.localAISetInferenceSettings]: managedLocalInferenceSettingsSetInputSchema,
  [IPC_CHANNELS.localAICatalogQuery]: publicModelCatalogQuerySchema,
  [IPC_CHANNELS.localAICatalogDetail]: publicModelCatalogDetailInputSchema,
  [IPC_CHANNELS.localAIListJobs]: emptyPayloadSchema,
  [IPC_CHANNELS.localAIListInstalled]: emptyPayloadSchema,
  [IPC_CHANNELS.localAIInstall]: localModelInstallInputSchema,
  [IPC_CHANNELS.localAIFit]: localModelFitInputSchema,
  [IPC_CHANNELS.localAIPause]: localDownloadJobInputSchema,
  [IPC_CHANNELS.localAIResume]: localDownloadJobInputSchema,
  [IPC_CHANNELS.localAICancel]: localDownloadCancelInputSchema,
  [IPC_CHANNELS.localAIVerify]: installedLocalModelInputSchema,
  [IPC_CHANNELS.localAIDelete]: installedLocalModelInputSchema,
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
// Channels owned directly by Main or sent from Main to Renderer do not pass through IpcRouter's
// command-envelope parser, so they are intentionally outside the adversarial input-schema table.
const NON_ROUTER_CHANNELS = new Set<string>([
  IPC_CHANNELS.tasksUpdated,
  IPC_CHANNELS.teamsEvent,
  IPC_CHANNELS.turnsPort,
  IPC_CHANNELS.reasoningEvent,
  IPC_CHANNELS.fileEditEvent,
  IPC_CHANNELS.runtimeStatusEvent,
  IPC_CHANNELS.updateHealthEvent,
  IPC_CHANNELS.updateCheckNow,
  IPC_CHANNELS.updateOpenManual,
  IPC_CHANNELS.updateOpenLog,
]);

describe('IPC channel registry stays in sync with the adversarial fuzz table', () => {
  it('covers every IPC_CHANNELS entry exactly once, split between router and non-router channels', () => {
    const allChannels = new Set(Object.values(IPC_CHANNELS));
    const handled = new Set(Object.keys(CHANNEL_INPUT_SCHEMAS));
    for (const channel of allChannels) {
      const isHandled = handled.has(channel);
      const isNonRouter = NON_ROUTER_CHANNELS.has(channel);
      expect(isHandled !== isNonRouter).toBe(true);
    }
    expect(handled.size + NON_ROUTER_CHANNELS.size).toBe(allChannels.size);
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
