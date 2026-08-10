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
  emptyPayloadSchema,
  permissionSetInputSchema,
  permissionSettingsSchema,
  modelCatalogQueryInputSchema,
  modelCatalogQueryResultSchema,
  modelCatalogSelectionSetInputSchema,
  modelSelectionSchema,
  openAIConnectionCreateInputSchema,
  openRouterConnectionCreateInputSchema,
  providerConnectionSchema,
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
  skillCandidateInputSchema,
  skillCatalogSchema,
  skillCatalogItemSchema,
  skillDraftSchema,
  skillDraftCreateInputSchema,
  skillDraftInstallInputSchema,
  skillDraftIdInputSchema,
  skillEnabledInputSchema,
  skillImportInputSchema,
  skillImportResultSchema,
  skillInstalledInputSchema,
  skillPreviewResultSchema,
  skillScanResultSchema,
  reasoningBatchSchema,
  runtimeStatusSchema,
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

const api: SprintCoderApi = {
  app: { getInfo: () => invoke(IPC_CHANNELS.appGetInfo, emptyPayloadSchema, appInfoSchema, {}) },
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
    scanSkills: () =>
      invoke(IPC_CHANNELS.settingsSkillsScan, emptyPayloadSchema, skillScanResultSchema, {}),
    previewSkill: (provider, skillId) =>
      invoke(
        IPC_CHANNELS.settingsSkillsPreview,
        skillCandidateInputSchema,
        skillPreviewResultSchema,
        { provider, skillId },
      ),
    importSkill: (previewId) =>
      invoke(IPC_CHANNELS.settingsSkillsImport, skillImportInputSchema, skillImportResultSchema, {
        previewId,
      }),
    updateSkill: (previewId) =>
      invoke(IPC_CHANNELS.settingsSkillsUpdate, skillImportInputSchema, skillImportResultSchema, {
        previewId,
      }),
    setSkillEnabled: (provider, skillId, enabled) =>
      invoke(IPC_CHANNELS.settingsSkillsSetEnabled, skillEnabledInputSchema, z.undefined(), {
        provider,
        skillId,
        enabled,
      }),
    removeSkill: (provider, skillId) =>
      invoke(IPC_CHANNELS.settingsSkillsRemove, skillInstalledInputSchema, z.undefined(), {
        provider,
        skillId,
      }),
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
    exportCreated: (skillId, digest) =>
      invoke(
        IPC_CHANNELS.skillsExportCreated,
        createdSkillMutationInputSchema,
        z.string().nullable(),
        { skillId, digest },
      ),
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
        z.array(providerConnectionSchema),
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
        ipcRenderer.removeListener(IPC_CHANNELS.turnsPort, listener);
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
