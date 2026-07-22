import { contextBridge, ipcRenderer } from 'electron';
import { z } from 'zod';
import {
  IPC_CHANNELS,
  appInfoSchema,
  approvalResolveInputSchema,
  approvalSummarySchema,
  autoPermissionDecisionSchema,
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
  runtimeModelSetInputSchema,
  runtimeSetInputSchema,
  runtimeSettingsSchema,
  taskArchivedInputSchema,
  taskCreateInputSchema,
  taskDraftInputSchema,
  taskGoalInputSchema,
  taskIdPayloadSchema,
  taskPinnedInputSchema,
  taskRenameInputSchema,
  taskSummarySchema,
  turnCancelInputSchema,
  turnEventSchema,
  turnQueueInputSchema,
  turnQueueResultSchema,
  turnSnapshotSchema,
  turnStartInputSchema,
  turnStartResultSchema,
  turnSteerInputSchema,
  turnStopAndSendInputSchema,
  turnSubscriptionInputSchema,
  workspaceSelectionSchema,
  type CommandEnvelope,
  type CommandResult,
  type VibeApi,
} from '@vibe/contracts';

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

const api: VibeApi = {
  app: { getInfo: () => invoke(IPC_CHANNELS.appGetInfo, emptyPayloadSchema, appInfoSchema, {}) },
  tasks: {
    list: () => invoke(IPC_CHANNELS.tasksList, emptyPayloadSchema, z.array(taskSummarySchema), {}),
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
  workspace: {
    get: (taskId) =>
      invoke(IPC_CHANNELS.workspaceGet, taskIdPayloadSchema, workspaceSelectionSchema, { taskId }),
    select: (taskId) =>
      invoke(IPC_CHANNELS.workspaceSelect, taskIdPayloadSchema, workspaceSelectionSchema, {
        taskId,
      }),
  },
  settings: {
    getRuntime: () =>
      invoke(IPC_CHANNELS.settingsGetRuntime, emptyPayloadSchema, runtimeSettingsSchema, {}),
    setRuntime: (kind) =>
      invoke(IPC_CHANNELS.settingsSetRuntime, runtimeSetInputSchema, z.undefined(), { kind }),
    setModel: (model) =>
      invoke(IPC_CHANNELS.settingsSetModel, runtimeModelSetInputSchema, z.undefined(), { model }),
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

contextBridge.exposeInMainWorld('vibe', api);
