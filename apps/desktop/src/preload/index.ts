import { contextBridge, ipcRenderer } from 'electron';
import { z } from 'zod';
import {
  IPC_CHANNELS,
  appInfoSchema,
  chatMessageSchema,
  commandEnvelopeSchema,
  commandResultSchema,
  emptyPayloadSchema,
  taskCreateInputSchema,
  taskIdPayloadSchema,
  taskRenameInputSchema,
  taskSummarySchema,
  turnCancelInputSchema,
  turnEventSchema,
  turnStartInputSchema,
  turnStartResultSchema,
  turnSubscriptionInputSchema,
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
  const requestId = crypto.randomUUID();
  const parsedPayload = inputSchema.parse(payload);
  const scopedTaskId = getTaskId(parsedPayload);
  const envelope: CommandEnvelope<TInput> = scopedTaskId === undefined
    ? { requestId, operationId: crypto.randomUUID(), payload: parsedPayload }
    : { requestId, operationId: crypto.randomUUID(), taskId: scopedTaskId, payload: parsedPayload };
  const validatedEnvelope = commandEnvelopeSchema(inputSchema).parse(envelope);
  const result = commandResultSchema(outputSchema).parse(await ipcRenderer.invoke(channel, validatedEnvelope)) as CommandResult<TOutput>;
  if (result.requestId !== requestId) throw new Error('IPC response correlation failed');
  if (!result.ok) {
    const e = new Error(result.error.userMessage);
    (e as any).code = result.error.code;
    throw e;
  }
  return result.value;
}

function getTaskId(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'taskId' in value && typeof value.taskId === 'string'
    ? value.taskId
    : undefined;
}

const api: VibeApi = {
  app: {
    getInfo: () => invoke(IPC_CHANNELS.appGetInfo, emptyPayloadSchema, appInfoSchema, {}),
  },
  tasks: {
    list: () => invoke(IPC_CHANNELS.tasksList, emptyPayloadSchema, z.array(taskSummarySchema), {}),
    create: (input = {}) => invoke(IPC_CHANNELS.tasksCreate, taskCreateInputSchema, taskSummarySchema, input),
    messages: (taskId) => invoke(IPC_CHANNELS.tasksMessages, taskIdPayloadSchema, z.array(chatMessageSchema), { taskId }),
    rename: (taskId, title) => invoke(IPC_CHANNELS.tasksRename, taskRenameInputSchema, taskSummarySchema, { taskId, title }),
  },
  turns: {
    start: (input) => invoke(IPC_CHANNELS.turnsStart, turnStartInputSchema, turnStartResultSchema, input),
    cancel: (input) => invoke(IPC_CHANNELS.turnsCancel, turnCancelInputSchema, z.undefined(), input),
    subscribe: (taskId, cb) => {
      const listener = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
        const parsed = turnEventSchema.safeParse(raw);
        if (parsed.success && parsed.data.taskId === taskId) cb(parsed.data);
      };
      ipcRenderer.on(IPC_CHANNELS.turnEvent, listener);
      void invoke(IPC_CHANNELS.turnsSubscribe, turnSubscriptionInputSchema, z.undefined(), { taskId })
        .catch(() => ipcRenderer.removeListener(IPC_CHANNELS.turnEvent, listener));
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        ipcRenderer.removeListener(IPC_CHANNELS.turnEvent, listener);
        void invoke(IPC_CHANNELS.turnsUnsubscribe, turnSubscriptionInputSchema, z.undefined(), { taskId }).catch(() => undefined);
      };
    },
  },
};

contextBridge.exposeInMainWorld('vibe', api);
