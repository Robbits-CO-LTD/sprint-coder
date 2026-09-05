import { contextBridge, ipcRenderer } from 'electron';
import { z } from 'zod';
import {
  IPC_CHANNELS,
  anthropicConnectionCreateInputSchema,
  appInfoSchema,
  approvalResolveInputSchema,
  approvalSummarySchema,
  autoPermissionDecisionSchema,
  canvasViewSchema,
  canvasViewSaveInputSchema,
  canvasViewSaveResultSchema,
  chatMessageSchema,
  commandSummarySchema,
  commandOutputPageInputSchema,
  commandOutputPageSchema,
  commandOutputTailInputSchema,
  commandEnvelopeSchema,
  commandResultSchema,
  computerAppProfileSchema,
  computerUseApprovalResolveInputSchema,
  computerUseAvailabilitySchema,
  computerUseProfileListInputSchema,
  computerUseProfileListResultSchema,
  computerUseProfileRegisterInputSchema,
  computerUseSessionStatusInputSchema,
  computerUseSessionStatusSchema,
  computerUseStartInputSchema,
  computerUseStopInputSchema,
  computerUseWindowCandidatesInputSchema,
  computerUseWindowCandidatesResultSchema,
  emptyPayloadSchema,
  permissionSetInputSchema,
  permissionSettingsSchema,
  modelCatalogQueryInputSchema,
  modelCatalogQueryResultSchema,
  modelCatalogSelectionSetInputSchema,
  modelSelectionSchema,
  installedLocalModelInputSchema,
  installedLocalModelSchema,
  managedLocalLaunchSettingsGetInputSchema,
  managedLocalLaunchSettingsSetInputSchema,
  managedLocalLaunchSettingsViewSchema,
  managedLocalInferenceSettingsGetInputSchema,
  managedLocalInferenceSettingsSetInputSchema,
  managedLocalInferenceSettingsViewSchema,
  localDownloadCancelInputSchema,
  localDownloadJobInputSchema,
  localDownloadJobSchema,
  localFitAssessmentSchema,
  localHardwareSnapshotSchema,
  localModelInstallInputSchema,
  localModelFitInputSchema,
  managedLocalRuntimeSnapshotSchema,
  publicModelCatalogDetailInputSchema,
  publicModelCatalogDetailSchema,
  publicModelCatalogPageSchema,
  publicModelCatalogQuerySchema,
  openAIConnectionCreateInputSchema,
  openRouterConnectionCreateInputSchema,
  orcaRouterConnectionCreateInputSchema,
  providerConnectionSchema,
  providerConnectionViewSchema,
  providerConnectionModelReleaseUpdateInputSchema,
  providerConnectionRateLimitLowerInputSchema,
  providerProfileConnectionCreateInputSchema,
  providerProfileSchema,
  projectAssignTaskInputSchema,
  projectContextManifestGetInputSchema,
  projectContextManifestSchema,
  projectContextManifestsListInputSchema,
  projectContextManifestSummarySchema,
  projectCreateInputSchema,
  projectFolderPickerResultSchema,
  projectFolderSchema,
  projectFoldersListInputSchema,
  projectFoldersReplaceInputSchema,
  projectGetInputSchema,
  projectInstructionResultSchema,
  projectInstructionSetInputSchema,
  projectMemoriesListInputSchema,
  projectMemoryCreateInputSchema,
  projectMemorySchema,
  projectMemoryUpdateInputSchema,
  projectReferenceAddInputSchema,
  projectReferencePickInputSchema,
  projectReferenceRemoveInputSchema,
  projectReferenceSchema,
  projectReferencesListInputSchema,
  projectReferenceUpdateInputSchema,
  projectSummarySchema,
  projectUnassignTaskInputSchema,
  projectUpdateInputSchema,
  connectionIdSchema,
  createdSkillMutationInputSchema,
  createdSkillEnabledInputSchema,
  runtimeModelSetInputSchema,
  runtimeEffortSetInputSchema,
  runtimeCodexEffortSetInputSchema,
  runtimeSetInputSchema,
  runtimeSettingsGetInputSchema,
  runtimeSettingsSchema,
  sprintCoderPrePromptSchema,
  sprintCoderPrePromptSetInputSchema,
  skillActivationPolicyInputSchema,
  skillCatalogSchema,
  skillCatalogItemSchema,
  skillDraftSchema,
  skillDraftCreateInputSchema,
  skillDraftInstallInputSchema,
  skillDraftIdInputSchema,
  skillExportInputSchema,
  reasoningBatchSchema,
  runtimeStatusSchema,
  updateCheckResultSchema,
  updateHealthSchema,
  runtimeFailureDiagnosticQuerySchema,
  runtimeFailureDiagnosticExportSchema,
  fileChangeRecordSchema,
  filePathPayloadSchema,
  fileOpenResultSchema,
  fileSaveInputSchema,
  fileSaveResultSchema,
  geminiConnectionCreateInputSchema,
  fileEditFrameSchema,
  generatedImageSchema,
  generatedImageBytesSchema,
  generatedImageRefSchema,
  goalControlInputSchema,
  goalResumeInputSchema,
  goalRunResultSchema,
  goalStartInputSchema,
  imageAttachmentCapabilitySchema,
  imageAttachmentMetadataListSchema,
  imageAttachmentMetadataSchema,
  imageAttachmentPreviewInputSchema,
  imageAttachmentPreviewSchema,
  imageAttachmentRemoveInputSchema,
  taskArchivedInputSchema,
  taskCreateInputSchema,
  taskDraftInputSchema,
  taskGoalInputSchema,
  taskIdPayloadSchema,
  taskPinnedInputSchema,
  taskRenameInputSchema,
  taskSummarySchema,
  taskSkillSelectionInputSchema,
  teamDetailSchema,
  teamEventSchema,
  teamSubscriptionInputSchema,
  teamSubscriptionSnapshotSchema,
  teamHireWorkerInputSchema,
  teamMissionSummarySchema,
  teamResumeMissionInputSchema,
  teamResumeExecutionIntegrationInputSchema,
  teamMessageSummarySchema,
  teamPolicyUpdateInputSchema,
  teamPolicySchema,
  teamModelResearchSettingsSchema,
  teamModelResearchSettingsSetInputSchema,
  teamModelSelectionGuidanceSchema,
  teamModelSelectionGuidanceSetInputSchema,
  teamModelRestrictionSetInputSchema,
  teamModelSettingsSchema,
  teamSendMessageInputSchema,
  teamSummarySchema,
  teamWorkerRefSchema,
  workerSummarySchema,
  turnCancelInputSchema,
  turnEventSchema,
  xAIConnectionCreateInputSchema,
  turnQueueInputSchema,
  turnQueueResultSchema,
  turnSnapshotSchema,
  turnStartInputSchema,
  turnStartResultSchema,
  turnSkillSelectionsSchema,
  turnSteerInputSchema,
  turnStopAndSendInputSchema,
  turnSubscriptionInputSchema,
  workspaceSelectionSchema,
  effectiveWorkspaceSetSchema,
  type CommandEnvelope,
  type CommandResult,
  type SprintCoderApi,
} from '@sprint-coder/contracts';
import { createTeamSubscriptionBuffer } from './team-subscription-buffer';
import { WINDOW_CONTROL_CHANNELS } from '../window-controls';
import { clipboardCarriesImage, createTrustedImagePasteGate } from '../clipboard-image-paste';
import { createTrustedComputerUseUiActivationGate } from '../computer-use-activation';

async function invoke<TInput, TOutput>(
  channel: string,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  payload: TInput,
): Promise<TOutput> {
  return invokeEnvelope(
    channel,
    inputSchema,
    outputSchema,
    payload,
    crypto.randomUUID(),
    crypto.randomUUID(),
  );
}

async function invokeEnvelope<TInput, TOutput>(
  channel: string,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>,
  payload: TInput,
  requestId: string,
  operationId: string,
): Promise<TOutput> {
  const parsedPayload = inputSchema.parse(payload);
  const scopedTaskId = getTaskId(parsedPayload);
  const envelope: CommandEnvelope<TInput> =
    scopedTaskId === undefined
      ? { requestId, operationId, payload: parsedPayload }
      : { requestId, operationId, taskId: scopedTaskId, payload: parsedPayload };
  const validatedEnvelope = commandEnvelopeSchema(inputSchema).parse(envelope);
  const result = commandResultSchema(outputSchema).parse(
    await ipcRenderer.invoke(channel, validatedEnvelope),
  ) as CommandResult<TOutput>;
  if (result.requestId !== requestId) throw new Error('IPC response correlation failed');
  if (!result.ok) {
    const error = new Error(result.error.userMessage);
    (error as Error & { code?: string }).code = result.error.code;
    throw error;
  }
  return result.value;
}

function getTaskId(value: unknown): string | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'taskId' in value &&
    typeof value.taskId === 'string'
    ? value.taskId
    : undefined;
}

const trustedImagePaste = createTrustedImagePasteGate(() => Date.now());
const trustedComputerUseActivation = createTrustedComputerUseUiActivationGate(() => Date.now());
// Capture phase: this runs before any listener the page installed, and `isTrusted` is false for
// every event the page can dispatch itself.
window.addEventListener(
  'paste',
  (event) => {
    if (event.isTrusted && clipboardCarriesImage(event.clipboardData)) trustedImagePaste.arm();
  },
  true,
);
function observeTrustedComputerUseActivation(event: Event): void {
  trustedComputerUseActivation.observe(event, (kind, intent) => {
    ipcRenderer.send(IPC_CHANNELS.computerUseActivationIntent, { kind, intent });
  });
}

window.addEventListener('pointerdown', observeTrustedComputerUseActivation, true);
window.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Enter' || event.key === ' ') observeTrustedComputerUseActivation(event);
  },
  true,
);

const api: SprintCoderApi = {
  app: { getInfo: () => invoke(IPC_CHANNELS.appGetInfo, emptyPayloadSchema, appInfoSchema, {}) },
  computerUse: {
    availability: () =>
      invoke(
        IPC_CHANNELS.computerUseAvailability,
        emptyPayloadSchema,
        computerUseAvailabilitySchema,
        {},
      ),
    registerProfile: (input) =>
      trustedComputerUseActivation.consume('application')
        ? invoke(
            IPC_CHANNELS.computerUseProfileRegister,
            computerUseProfileRegisterInputSchema,
            computerAppProfileSchema.nullable(),
            input,
          )
        : Promise.reject(new Error('Computer Use app registration requires a trusted click')),
    listProfiles: (input = {}) =>
      invoke(
        IPC_CHANNELS.computerUseProfilesList,
        computerUseProfileListInputSchema,
        computerUseProfileListResultSchema,
        input,
      ),
    listWindowCandidates: (input) =>
      invoke(
        IPC_CHANNELS.computerUseWindowCandidates,
        computerUseWindowCandidatesInputSchema,
        computerUseWindowCandidatesResultSchema,
        input,
      ),
    // Main is authoritative for the fresh start gesture and its deferred Quick Start latch.
    // A preload-local two-second check here would expire while native window enumeration is still
    // running and reject a valid one-click resume before Main can consume its bound latch.
    start: (input) =>
      invoke(
        IPC_CHANNELS.computerUseStart,
        computerUseStartInputSchema,
        computerUseSessionStatusSchema,
        input,
      ),
    getStatus: (input) =>
      invoke(
        IPC_CHANNELS.computerUseStatusGet,
        computerUseSessionStatusInputSchema,
        computerUseSessionStatusSchema.nullable(),
        input,
      ),
    stop: (input) =>
      invoke(IPC_CHANNELS.computerUseStop, computerUseStopInputSchema, z.undefined(), input),
    resolveApproval: (input) =>
      trustedComputerUseActivation.consume('approval')
        ? invoke(
            IPC_CHANNELS.computerUseApprovalResolve,
            computerUseApprovalResolveInputSchema,
            computerUseSessionStatusSchema,
            input,
          )
        : Promise.reject(new Error('Computer Use approval requires a trusted click')),
    subscribeStatus: (sessionId, listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
        const status = computerUseSessionStatusSchema.safeParse(value);
        if (status.success && status.data.sessionId === sessionId) listener(status.data);
      };
      ipcRenderer.on(IPC_CHANNELS.computerUseStatusEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.computerUseStatusEvent, handler);
    },
  },
  windowControls: {
    platform: process.platform,
    minimize: () => ipcRenderer.send(WINDOW_CONTROL_CHANNELS.action, 'minimize'),
    toggleMaximize: () => ipcRenderer.send(WINDOW_CONTROL_CHANNELS.action, 'toggle-maximize'),
    close: () => ipcRenderer.send(WINDOW_CONTROL_CHANNELS.action, 'close'),
    isMaximized: async () =>
      (await ipcRenderer.invoke(WINDOW_CONTROL_CHANNELS.getMaximized)) === true,
    onMaximizedChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
        if (typeof value === 'boolean') listener(value);
      };
      ipcRenderer.on(WINDOW_CONTROL_CHANNELS.maximizedChanged, handler);
      return () => ipcRenderer.removeListener(WINDOW_CONTROL_CHANNELS.maximizedChanged, handler);
    },
  },
  tasks: {
    list: () => invoke(IPC_CHANNELS.tasksList, emptyPayloadSchema, z.array(taskSummarySchema), {}),
    subscribe: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
        const parsed = taskSummarySchema.safeParse(raw);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(IPC_CHANNELS.tasksUpdated, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.tasksUpdated, handler);
    },
    create: (input = {}) =>
      invoke(IPC_CHANNELS.tasksCreate, taskCreateInputSchema, taskSummarySchema, input),
    messages: (taskId) =>
      invoke(IPC_CHANNELS.tasksMessages, taskIdPayloadSchema, z.array(chatMessageSchema), {
        taskId,
      }),
    rename: (taskId, title) =>
      invoke(IPC_CHANNELS.tasksRename, taskRenameInputSchema, taskSummarySchema, { taskId, title }),
    setPinned: (taskId, pinned) =>
      invoke(IPC_CHANNELS.tasksSetPinned, taskPinnedInputSchema, taskSummarySchema, {
        taskId,
        pinned,
      }),
    setArchived: (taskId, archived) =>
      invoke(IPC_CHANNELS.tasksSetArchived, taskArchivedInputSchema, taskSummarySchema, {
        taskId,
        archived,
      }),
    setGoal: (taskId, goal) =>
      invoke(IPC_CHANNELS.tasksSetGoal, taskGoalInputSchema, taskSummarySchema, { taskId, goal }),
    getDraft: (taskId) =>
      invoke(IPC_CHANNELS.tasksGetDraft, taskIdPayloadSchema, z.string(), { taskId }),
    setDraft: (taskId, draft) =>
      invoke(IPC_CHANNELS.tasksSetDraft, taskDraftInputSchema, z.undefined(), { taskId, draft }),
  },
  goals: {
    start: (input) =>
      invoke(IPC_CHANNELS.goalsStart, goalStartInputSchema, goalRunResultSchema, input),
    pause: (taskId) =>
      invoke(IPC_CHANNELS.goalsPause, goalControlInputSchema, taskSummarySchema, { taskId }),
    resume: (taskId, skills = []) =>
      invoke(IPC_CHANNELS.goalsResume, goalResumeInputSchema, goalRunResultSchema, {
        taskId,
        skills,
      }),
    clear: (taskId) =>
      invoke(IPC_CHANNELS.goalsClear, goalControlInputSchema, taskSummarySchema, { taskId }),
  },
  attachments: {
    capability: (taskId) =>
      invoke(
        IPC_CHANNELS.attachmentsCapability,
        taskIdPayloadSchema,
        imageAttachmentCapabilitySchema,
        { taskId },
      ),
    pick: (taskId) =>
      invoke(
        IPC_CHANNELS.attachmentsPick,
        taskIdPayloadSchema,
        imageAttachmentMetadataSchema.nullable(),
        { taskId },
      ),
    paste: (taskId) => {
      // Main reads the OS clipboard for this call, so the page cannot be allowed to make it at
      // will. Only a `paste` the user agent marked trusted arms the gate, and only in this isolated
      // world — see createTrustedImagePasteGate.
      if (!trustedImagePaste.consume())
        return Promise.reject(
          new Error('画像の貼り付けは、入力欄でのCtrl+V / Cmd+Vからのみ実行できます'),
        );
      return invoke(
        IPC_CHANNELS.attachmentsPaste,
        taskIdPayloadSchema,
        imageAttachmentMetadataSchema.nullable(),
        { taskId },
      );
    },
    listDraft: (taskId) =>
      invoke(
        IPC_CHANNELS.attachmentsListDraft,
        taskIdPayloadSchema,
        imageAttachmentMetadataListSchema,
        { taskId },
      ),
    preview: (input) =>
      invoke(
        IPC_CHANNELS.attachmentsPreview,
        imageAttachmentPreviewInputSchema,
        imageAttachmentPreviewSchema,
        input,
      ),
    remove: (input) =>
      invoke(
        IPC_CHANNELS.attachmentsRemove,
        imageAttachmentRemoveInputSchema,
        z.undefined(),
        input,
      ),
  },
  projects: {
    list: () =>
      invoke(IPC_CHANNELS.projectsList, emptyPayloadSchema, z.array(projectSummarySchema), {}),
    pickFolders: () =>
      invoke(
        IPC_CHANNELS.projectsPickFolders,
        emptyPayloadSchema,
        projectFolderPickerResultSchema,
        {},
      ),
    folders: {
      list: (input) =>
        invoke(
          IPC_CHANNELS.projectsFoldersList,
          projectFoldersListInputSchema,
          z.array(projectFolderSchema),
          input,
        ),
      replace: (input) =>
        invoke(
          IPC_CHANNELS.projectsFoldersReplace,
          projectFoldersReplaceInputSchema,
          projectSummarySchema,
          input,
        ),
    },
    get: (input) =>
      invoke(
        IPC_CHANNELS.projectsGet,
        projectGetInputSchema,
        projectInstructionResultSchema,
        input,
      ),
    setInstruction: (input) =>
      invoke(
        IPC_CHANNELS.projectsSetInstruction,
        projectInstructionSetInputSchema,
        projectInstructionResultSchema,
        input,
      ),
    listContextManifests: (input) =>
      invoke(
        IPC_CHANNELS.projectsListContextManifests,
        projectContextManifestsListInputSchema,
        z.array(projectContextManifestSummarySchema),
        input,
      ),
    getContextManifest: (input) =>
      invoke(
        IPC_CHANNELS.projectsGetContextManifest,
        projectContextManifestGetInputSchema,
        projectContextManifestSchema,
        input,
      ),
    references: {
      list: (input) =>
        invoke(
          IPC_CHANNELS.projectsReferencesList,
          projectReferencesListInputSchema,
          z.array(projectReferenceSchema),
          input,
        ),
      pick: (input) =>
        invoke(
          IPC_CHANNELS.projectsReferencesPick,
          projectReferencePickInputSchema,
          projectReferenceSchema.nullable(),
          input,
        ),
      add: (input) =>
        invoke(
          IPC_CHANNELS.projectsReferencesAdd,
          projectReferenceAddInputSchema,
          projectReferenceSchema,
          input,
        ),
      update: (input) =>
        invoke(
          IPC_CHANNELS.projectsReferencesUpdate,
          projectReferenceUpdateInputSchema,
          projectReferenceSchema,
          input,
        ),
      remove: (input) =>
        invoke(
          IPC_CHANNELS.projectsReferencesRemove,
          projectReferenceRemoveInputSchema,
          z.undefined(),
          input,
        ),
    },
    memories: {
      list: (input) =>
        invoke(
          IPC_CHANNELS.projectsMemoriesList,
          projectMemoriesListInputSchema,
          z.array(projectMemorySchema),
          input,
        ),
      createFromTurn: (input) =>
        invoke(
          IPC_CHANNELS.projectsMemoriesCreate,
          projectMemoryCreateInputSchema,
          projectMemorySchema,
          input,
        ),
      update: (input) =>
        invoke(
          IPC_CHANNELS.projectsMemoriesUpdate,
          projectMemoryUpdateInputSchema,
          projectMemorySchema,
          input,
        ),
    },
    create: (input) =>
      invoke(IPC_CHANNELS.projectsCreate, projectCreateInputSchema, projectSummarySchema, input),
    update: (input) =>
      invoke(IPC_CHANNELS.projectsUpdate, projectUpdateInputSchema, projectSummarySchema, input),
    assignTask: (input) =>
      invoke(
        IPC_CHANNELS.projectsAssignTask,
        projectAssignTaskInputSchema,
        taskSummarySchema,
        input,
      ),
    unassignTask: (input) =>
      invoke(
        IPC_CHANNELS.projectsUnassignTask,
        projectUnassignTaskInputSchema,
        taskSummarySchema,
        input,
      ),
  },
  teams: {
    promote: (taskId) =>
      invoke(IPC_CHANNELS.teamsPromote, taskIdPayloadSchema, teamSummarySchema, { taskId }),
    get: (taskId) =>
      invoke(IPC_CHANNELS.teamsGet, taskIdPayloadSchema, teamDetailSchema.nullable(), { taskId }),
    updatePolicy: (input) =>
      invoke(IPC_CHANNELS.teamsUpdatePolicy, teamPolicyUpdateInputSchema, teamDetailSchema, input),
    hireWorker: (input) =>
      invoke(IPC_CHANNELS.teamsHireWorker, teamHireWorkerInputSchema, workerSummarySchema, input),
    resumeMission: (input) =>
      invoke(
        IPC_CHANNELS.teamsResumeMission,
        teamResumeMissionInputSchema,
        teamMissionSummarySchema,
        input,
      ),
    resumeExecutionIntegration: (input) =>
      invoke(
        IPC_CHANNELS.teamsResumeExecutionIntegration,
        teamResumeExecutionIntegrationInputSchema,
        teamDetailSchema,
        input,
      ),
    sendToWorker: (input) =>
      invoke(IPC_CHANNELS.teamsSend, teamSendMessageInputSchema, teamMessageSummarySchema, input),
    stopWorker: (input) =>
      invoke(IPC_CHANNELS.teamsStopWorker, teamWorkerRefSchema, workerSummarySchema, input),
    stopAll: (taskId) =>
      invoke(IPC_CHANNELS.teamsStopAll, taskIdPayloadSchema, teamDetailSchema, { taskId }),
    subscribe: (taskId, listener) => {
      const subscriptionId = globalThis.crypto.randomUUID();
      const input = { taskId, subscriptionId };
      const buffer = createTeamSubscriptionBuffer(listener);
      let disposed = false;
      const eventSchema = z.object({ taskId: z.string(), event: teamEventSchema }).strict();
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
        const parsed = eventSchema.safeParse(raw);
        if (parsed.success && parsed.data.taskId === taskId) buffer.push(parsed.data.event);
      };
      ipcRenderer.on(IPC_CHANNELS.teamsEvent, handler);
      void invoke(
        IPC_CHANNELS.teamsSubscribe,
        teamSubscriptionInputSchema,
        teamSubscriptionSnapshotSchema,
        input,
      )
        .then((snapshot) => {
          if (disposed) {
            void invoke(
              IPC_CHANNELS.teamsUnsubscribe,
              teamSubscriptionInputSchema,
              z.undefined(),
              input,
            ).catch(() => undefined);
            return;
          }
          buffer.activate(snapshot);
        })
        .catch(() => {
          buffer.dispose();
          ipcRenderer.removeListener(IPC_CHANNELS.teamsEvent, handler);
        });
      return () => {
        if (disposed) return;
        disposed = true;
        buffer.dispose();
        ipcRenderer.removeListener(IPC_CHANNELS.teamsEvent, handler);
        void invoke(
          IPC_CHANNELS.teamsUnsubscribe,
          teamSubscriptionInputSchema,
          z.undefined(),
          input,
        ).catch(() => undefined);
      };
    },
    getCanvasView: (taskId) =>
      invoke(IPC_CHANNELS.teamsGetCanvasView, taskIdPayloadSchema, canvasViewSchema.nullable(), {
        taskId,
      }),
    saveCanvasView: (input) =>
      invoke(
        IPC_CHANNELS.teamsSaveCanvasView,
        canvasViewSaveInputSchema,
        canvasViewSaveResultSchema,
        input,
      ),
  },
  workspace: {
    get: (taskId) =>
      invoke(IPC_CHANNELS.workspaceGet, taskIdPayloadSchema, workspaceSelectionSchema, { taskId }),
    getEffective: (taskId) =>
      invoke(IPC_CHANNELS.workspaceGetEffective, taskIdPayloadSchema, effectiveWorkspaceSetSchema, {
        taskId,
      }),
    select: (taskId) =>
      invoke(IPC_CHANNELS.workspaceSelect, taskIdPayloadSchema, workspaceSelectionSchema, {
        taskId,
      }),
  },
  reasoning: {
    // Push-only, and unfiltered by taskId here on purpose: the batch carries its own taskId/turnId
    // and the store decides relevance, mirroring how the Team subscription is shaped. Unknown
    // payloads are dropped by `safeParse` exactly as the other subscriptions do.
    subscribe: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
        const parsed = reasoningBatchSchema.safeParse(raw);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(IPC_CHANNELS.reasoningEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.reasoningEvent, handler);
    },
  },
  runtime: {
    // Push-only channel, unlike every `invoke` here: Runtime liveness is a transient property of the
    // current process (issue #9), so it is never persisted and never replayed. Unknown payloads are
    // dropped by `safeParse` exactly like the Turn/Team subscriptions do.
    subscribeStatus: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
        const parsed = runtimeStatusSchema.safeParse(raw);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(IPC_CHANNELS.runtimeStatusEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.runtimeStatusEvent, handler);
    },
    getFailureDiagnostic: (input) =>
      invoke(
        IPC_CHANNELS.runtimeFailureDiagnosticGet,
        runtimeFailureDiagnosticQuerySchema,
        runtimeFailureDiagnosticExportSchema,
        input,
      ),
  },
  updates: {
    subscribeHealth: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
        const parsed = updateHealthSchema.safeParse(raw);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(IPC_CHANNELS.updateHealthEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.updateHealthEvent, handler);
    },
    checkNow: async () =>
      updateCheckResultSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.updateCheckNow)),
    openManualUpdate: () => ipcRenderer.send(IPC_CHANNELS.updateOpenManual),
    openUpdateLog: () => ipcRenderer.send(IPC_CHANNELS.updateOpenLog),
  },
  fileEdits: {
    // Push-only, mirroring `reasoning` above: the frame carries its own taskId/turnId and the store
    // decides relevance. Unknown payloads are dropped by `safeParse` like every other subscription.
    subscribe: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
        const parsed = fileEditFrameSchema.safeParse(raw);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(IPC_CHANNELS.fileEditEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.fileEditEvent, handler);
    },
  },
  files: {
    list: (taskId) =>
      invoke(IPC_CHANNELS.filesList, taskIdPayloadSchema, z.array(fileChangeRecordSchema), {
        taskId,
      }),
    pick: (taskId) =>
      invoke(IPC_CHANNELS.filesPick, taskIdPayloadSchema, fileOpenResultSchema.nullable(), {
        taskId,
      }),
    open: (taskId, rootId, path) =>
      invoke(IPC_CHANNELS.filesOpen, filePathPayloadSchema, fileOpenResultSchema, {
        taskId,
        rootId,
        path,
      }),
    recover: (taskId, rootId, path) =>
      invoke(IPC_CHANNELS.filesRecover, filePathPayloadSchema, fileOpenResultSchema, {
        taskId,
        rootId,
        path,
      }),
    // `invoke` already mints an operationId per call, which is what makes the save idempotent on the
    // Main side if the same request is retried.
    save: (input) =>
      invoke(IPC_CHANNELS.filesSave, fileSaveInputSchema, fileSaveResultSchema, input),
  },
  images: {
    list: (taskId) =>
      invoke(IPC_CHANNELS.imagesList, taskIdPayloadSchema, z.array(generatedImageSchema), {
        taskId,
      }),
    read: (imageId) =>
      invoke(IPC_CHANNELS.imagesRead, generatedImageRefSchema, generatedImageBytesSchema, {
        imageId,
      }),
  },
  settings: {
    getRuntime: (taskId) =>
      invoke(
        IPC_CHANNELS.settingsGetRuntime,
        runtimeSettingsGetInputSchema,
        runtimeSettingsSchema,
        taskId === undefined ? {} : { taskId },
      ),
    setRuntime: (kind, taskId) =>
      invoke(
        IPC_CHANNELS.settingsSetRuntime,
        runtimeSetInputSchema,
        z.undefined(),
        taskId === undefined ? { kind } : { kind, taskId },
      ),
    setModel: (model, taskId) =>
      invoke(
        IPC_CHANNELS.settingsSetModel,
        runtimeModelSetInputSchema,
        z.undefined(),
        taskId === undefined ? { model } : { model, taskId },
      ),
    setEffort: (effort) =>
      invoke(IPC_CHANNELS.settingsSetEffort, runtimeEffortSetInputSchema, z.undefined(), {
        effort,
      }),
    // Separate from setEffort because the two providers do not share a value space: Claude's is a
    // fixed enum, Codex's is whatever the selected model advertises (issue #6). Main validates the
    // level against that model's set and rejects an unsupported one, since Codex fails the whole
    // turn rather than falling back.
    setCodexEffort: (effort) =>
      invoke(IPC_CHANNELS.settingsSetCodexEffort, runtimeCodexEffortSetInputSchema, z.undefined(), {
        effort,
      }),
    getTeamModelResearch: () =>
      invoke(
        IPC_CHANNELS.settingsGetTeamModelResearch,
        emptyPayloadSchema,
        teamModelResearchSettingsSchema,
        {},
      ),
    setTeamModelResearch: (input) =>
      invoke(
        IPC_CHANNELS.settingsSetTeamModelResearch,
        teamModelResearchSettingsSetInputSchema,
        z.undefined(),
        input,
      ),
    getTeamModelSelectionGuidance: () =>
      invoke(
        IPC_CHANNELS.settingsGetTeamModelSelectionGuidance,
        emptyPayloadSchema,
        teamModelSelectionGuidanceSchema,
        {},
      ),
    setTeamModelSelectionGuidance: (input) =>
      invoke(
        IPC_CHANNELS.settingsSetTeamModelSelectionGuidance,
        teamModelSelectionGuidanceSetInputSchema,
        z.undefined(),
        input,
      ),
    getSprintCoderPrePrompt: () =>
      invoke(
        IPC_CHANNELS.settingsGetSprintCoderPrePrompt,
        emptyPayloadSchema,
        sprintCoderPrePromptSchema,
        {},
      ),
    setSprintCoderPrePrompt: (input) =>
      invoke(
        IPC_CHANNELS.settingsSetSprintCoderPrePrompt,
        sprintCoderPrePromptSetInputSchema,
        z.undefined(),
        input,
      ),
    getTeamModelSettings: () =>
      invoke(
        IPC_CHANNELS.settingsGetTeamModelSettings,
        emptyPayloadSchema,
        teamModelSettingsSchema,
        {},
      ),
    setTeamModelRestriction: (input) =>
      invoke(
        IPC_CHANNELS.settingsSetTeamModelRestriction,
        teamModelRestrictionSetInputSchema,
        z.undefined(),
        input,
      ),
    getDefaultTeamPolicy: () =>
      invoke(IPC_CHANNELS.settingsGetDefaultTeamPolicy, emptyPayloadSchema, teamPolicySchema, {}),
    setDefaultTeamPolicy: (policy) =>
      invoke(IPC_CHANNELS.settingsSetDefaultTeamPolicy, teamPolicySchema, z.undefined(), policy),
  },
  skills: {
    list: () => invoke(IPC_CHANNELS.skillsList, emptyPayloadSchema, skillCatalogSchema, {}),
    getDraftSelection: (taskId) =>
      invoke(IPC_CHANNELS.skillsGetDraftSelection, taskIdPayloadSchema, turnSkillSelectionsSchema, {
        taskId,
      }),
    setDraftSelection: (taskId, skills) =>
      invoke(IPC_CHANNELS.skillsSetDraftSelection, taskSkillSelectionInputSchema, z.undefined(), {
        taskId,
        skills,
      }),
    listDrafts: () =>
      invoke(IPC_CHANNELS.skillsListDrafts, emptyPayloadSchema, z.array(skillDraftSchema), {}),
    createDraft: (input) =>
      invoke(IPC_CHANNELS.skillsCreateDraft, skillDraftCreateInputSchema, skillDraftSchema, input),
    installDraft: (draftId, expectedDigest, confirmed) =>
      invoke(
        IPC_CHANNELS.skillsInstallDraft,
        skillDraftInstallInputSchema,
        skillCatalogItemSchema,
        { draftId, expectedDigest, confirmed },
      ),
    discardDraft: (draftId) =>
      invoke(IPC_CHANNELS.skillsDiscardDraft, skillDraftIdInputSchema, z.undefined(), { draftId }),
    removeCreated: (skillId, digest) =>
      invoke(IPC_CHANNELS.skillsRemoveCreated, createdSkillMutationInputSchema, z.undefined(), {
        skillId,
        digest,
      }),
    setCreatedEnabled: (skillId, digest, enabled) =>
      invoke(IPC_CHANNELS.skillsSetCreatedEnabled, createdSkillEnabledInputSchema, z.undefined(), {
        skillId,
        digest,
        enabled,
      }),
    setActivationPolicy: (ref, policy) =>
      invoke(
        IPC_CHANNELS.skillsSetActivationPolicy,
        skillActivationPolicyInputSchema,
        z.undefined(),
        { ref, policy },
      ),
    exportCreated: (skillId, digest, format = 'original') =>
      invoke(IPC_CHANNELS.skillsExportCreated, skillExportInputSchema, z.string().nullable(), {
        skillId,
        digest,
        format,
      }),
  },
  models: {
    query: (input) =>
      invoke(
        IPC_CHANNELS.modelsCatalogQuery,
        modelCatalogQueryInputSchema,
        modelCatalogQueryResultSchema,
        input,
      ),
    setSelection: (taskId, selection) =>
      invoke(
        IPC_CHANNELS.modelsSetSelection,
        modelCatalogSelectionSetInputSchema,
        modelSelectionSchema,
        { taskId, selection },
      ),
  },
  providers: {
    listConnections: () =>
      invoke(
        IPC_CHANNELS.providersListConnections,
        emptyPayloadSchema,
        z.array(providerConnectionViewSchema),
        {},
      ),
    listProfiles: () =>
      invoke(
        IPC_CHANNELS.providersListProfiles,
        emptyPayloadSchema,
        z.array(providerProfileSchema),
        {},
      ),
    createOpenAIConnection: (input) =>
      invoke(
        IPC_CHANNELS.providersCreateOpenAIConnection,
        openAIConnectionCreateInputSchema,
        providerConnectionSchema,
        input,
      ),
    createOpenRouterConnection: (input) =>
      invoke(
        IPC_CHANNELS.providersCreateOpenRouterConnection,
        openRouterConnectionCreateInputSchema,
        providerConnectionSchema,
        input,
      ),
    createOrcaRouterConnection: (input) =>
      invoke(
        IPC_CHANNELS.providersCreateOrcaRouterConnection,
        orcaRouterConnectionCreateInputSchema,
        providerConnectionSchema,
        input,
      ),
    createAnthropicConnection: (input) =>
      invoke(
        IPC_CHANNELS.providersCreateAnthropicConnection,
        anthropicConnectionCreateInputSchema,
        providerConnectionSchema,
        input,
      ),
    createGeminiConnection: (input) =>
      invoke(
        IPC_CHANNELS.providersCreateGeminiConnection,
        geminiConnectionCreateInputSchema,
        providerConnectionSchema,
        input,
      ),
    createXAIConnection: (input) =>
      invoke(
        IPC_CHANNELS.providersCreateXAIConnection,
        xAIConnectionCreateInputSchema,
        providerConnectionSchema,
        input,
      ),
    createProfileConnection: (input) =>
      invoke(
        IPC_CHANNELS.providersCreateProfileConnection,
        providerProfileConnectionCreateInputSchema,
        providerConnectionSchema,
        input,
      ),
    verifyConnection: (connectionId) =>
      invoke(
        IPC_CHANNELS.providersVerifyConnection,
        z.object({ connectionId: connectionIdSchema }).strict(),
        providerConnectionSchema,
        { connectionId },
      ),
    lowerRateLimits: (input) =>
      invoke(
        IPC_CHANNELS.providersLowerRateLimits,
        providerConnectionRateLimitLowerInputSchema,
        providerConnectionSchema,
        input,
      ),
    setAutomaticModelRelease: (input) =>
      invoke(
        IPC_CHANNELS.providersSetAutomaticModelRelease,
        providerConnectionModelReleaseUpdateInputSchema,
        providerConnectionSchema,
        input,
      ),
  },
  localAI: {
    hardware: () =>
      invoke(IPC_CHANNELS.localAIHardware, emptyPayloadSchema, localHardwareSnapshotSchema, {}),
    runtime: () =>
      invoke(
        IPC_CHANNELS.localAIRuntime,
        emptyPayloadSchema,
        managedLocalRuntimeSnapshotSchema,
        {},
      ),
    launchSettings: (modelId) =>
      invoke(
        IPC_CHANNELS.localAILaunchSettings,
        managedLocalLaunchSettingsGetInputSchema,
        managedLocalLaunchSettingsViewSchema,
        { modelId },
      ),
    setLaunchSettings: (input) =>
      invoke(
        IPC_CHANNELS.localAISetLaunchSettings,
        managedLocalLaunchSettingsSetInputSchema,
        managedLocalLaunchSettingsViewSchema,
        input,
      ),
    inferenceSettings: (modelId) =>
      invoke(
        IPC_CHANNELS.localAIInferenceSettings,
        managedLocalInferenceSettingsGetInputSchema,
        managedLocalInferenceSettingsViewSchema,
        { modelId },
      ),
    setInferenceSettings: (input) =>
      invoke(
        IPC_CHANNELS.localAISetInferenceSettings,
        managedLocalInferenceSettingsSetInputSchema,
        managedLocalInferenceSettingsViewSchema,
        input,
      ),
    query: (input) =>
      invoke(
        IPC_CHANNELS.localAICatalogQuery,
        publicModelCatalogQuerySchema,
        publicModelCatalogPageSchema,
        input,
      ),
    detail: (input) =>
      invoke(
        IPC_CHANNELS.localAICatalogDetail,
        publicModelCatalogDetailInputSchema,
        publicModelCatalogDetailSchema,
        input,
      ),
    listJobs: () =>
      invoke(IPC_CHANNELS.localAIListJobs, emptyPayloadSchema, z.array(localDownloadJobSchema), {}),
    listInstalled: () =>
      invoke(
        IPC_CHANNELS.localAIListInstalled,
        emptyPayloadSchema,
        z.array(installedLocalModelSchema),
        {},
      ),
    install: (input) =>
      invoke(
        IPC_CHANNELS.localAIInstall,
        localModelInstallInputSchema,
        localDownloadJobSchema,
        input,
      ),
    fit: (input) =>
      invoke(IPC_CHANNELS.localAIFit, localModelFitInputSchema, localFitAssessmentSchema, input),
    pause: (jobId) =>
      invoke(IPC_CHANNELS.localAIPause, localDownloadJobInputSchema, localDownloadJobSchema, {
        jobId,
      }),
    resume: (jobId) =>
      invoke(IPC_CHANNELS.localAIResume, localDownloadJobInputSchema, localDownloadJobSchema, {
        jobId,
      }),
    cancel: (jobId, confirmed) =>
      invoke(IPC_CHANNELS.localAICancel, localDownloadCancelInputSchema, localDownloadJobSchema, {
        jobId,
        confirmed,
      }),
    verify: (modelId) =>
      invoke(IPC_CHANNELS.localAIVerify, installedLocalModelInputSchema, localFitAssessmentSchema, {
        modelId,
      }),
    delete: (modelId) =>
      invoke(IPC_CHANNELS.localAIDelete, installedLocalModelInputSchema, z.undefined(), {
        modelId,
      }),
  },
  permissions: {
    get: (taskId) =>
      invoke(IPC_CHANNELS.permissionsGet, taskIdPayloadSchema, permissionSettingsSchema, {
        taskId,
      }),
    listAutoDecisions: (taskId) =>
      invoke(
        IPC_CHANNELS.permissionsListAutoDecisions,
        taskIdPayloadSchema,
        z.array(autoPermissionDecisionSchema),
        { taskId },
      ),
    set: (taskId, preset, expectedPolicyEpoch) =>
      invoke(IPC_CHANNELS.permissionsSet, permissionSetInputSchema, permissionSettingsSchema, {
        taskId,
        preset,
        expectedPolicyEpoch,
      }),
  },
  approvals: {
    listPending: (taskId) =>
      invoke(
        IPC_CHANNELS.approvalsListPending,
        taskIdPayloadSchema,
        z.array(approvalSummarySchema),
        {
          taskId,
        },
      ),
    listRecent: (taskId) =>
      invoke(
        IPC_CHANNELS.approvalsListRecent,
        taskIdPayloadSchema,
        z.array(approvalSummarySchema),
        { taskId },
      ),
    resolve: (input) =>
      invoke(
        IPC_CHANNELS.approvalsResolve,
        approvalResolveInputSchema,
        approvalSummarySchema,
        input,
      ),
  },
  commands: {
    list: (taskId) =>
      invoke(IPC_CHANNELS.commandsList, taskIdPayloadSchema, z.array(commandSummarySchema), {
        taskId,
      }),
    outputPage: (input) =>
      invoke(
        IPC_CHANNELS.commandsOutputPage,
        commandOutputPageInputSchema,
        commandOutputPageSchema,
        input,
      ),
    outputTail: (input) =>
      invoke(
        IPC_CHANNELS.commandsOutputTail,
        commandOutputTailInputSchema,
        commandOutputPageSchema,
        input,
      ),
  },
  turns: {
    start: (input) =>
      invoke(IPC_CHANNELS.turnsStart, turnStartInputSchema, turnStartResultSchema, input),
    queue: (input) =>
      invoke(IPC_CHANNELS.turnsQueue, turnQueueInputSchema, turnQueueResultSchema, input),
    steer: (input) => invoke(IPC_CHANNELS.turnsSteer, turnSteerInputSchema, z.undefined(), input),
    stopAndSend: (input) =>
      invoke(IPC_CHANNELS.turnsStopAndSend, turnStopAndSendInputSchema, z.undefined(), input),
    cancel: (input) =>
      invoke(IPC_CHANNELS.turnsCancel, turnCancelInputSchema, z.undefined(), input),
    snapshot: (taskId) =>
      invoke(IPC_CHANNELS.turnsSnapshot, taskIdPayloadSchema, turnSnapshotSchema, { taskId }),
    subscribe: (taskId, cb, opts) => {
      const requestId = crypto.randomUUID();
      let active = true;
      let port: MessagePort | undefined;
      const listener = (event: Electron.IpcRendererEvent, raw: unknown): void => {
        if (!isPortResponse(raw, requestId, taskId)) return;
        ipcRenderer.removeListener(IPC_CHANNELS.turnsPort, listener);
        const received = event.ports[0];
        if (received === undefined) return;
        port = received;
        if (!active) {
          port.close();
          return;
        }
        port.onmessage = (message: MessageEvent<unknown>) => {
          const parsed = turnEventSchema.safeParse(message.data);
          if (active && parsed.success && parsed.data.taskId === taskId) cb(parsed.data);
        };
        port.start();
      };
      ipcRenderer.on(IPC_CHANNELS.turnsPort, listener);
      const payload =
        opts?.afterSeq === undefined ? { taskId } : { taskId, afterSeq: opts.afterSeq };
      void invokeEnvelope(
        IPC_CHANNELS.turnsSubscribe,
        turnSubscriptionInputSchema,
        z.undefined(),
        payload,
        requestId,
        crypto.randomUUID(),
      ).catch(() => {
        active = false;
        ipcRenderer.removeListener(IPC_CHANNELS.turnsPort, listener);
        port?.close();
      });
      return () => {
        if (!active) return;
        active = false;
        // Keep the correlated listener until a pending transfer arrives so it can close the port.
        if (port !== undefined) ipcRenderer.removeListener(IPC_CHANNELS.turnsPort, listener);
        port?.postMessage({ type: 'unsubscribe' });
        port?.close();
      };
    },
  },
};

function isPortResponse(value: unknown, requestId: string, taskId: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'requestId' in value &&
    value.requestId === requestId &&
    'taskId' in value &&
    value.taskId === taskId
  );
}

contextBridge.exposeInMainWorld('sprintCoder', api);
