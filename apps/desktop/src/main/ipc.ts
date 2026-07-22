import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  IPC_CHANNELS,
  appInfoSchema,
  chatMessageSchema,
  commandEnvelopeSchema,
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
  type PublicError,
  type TurnEvent,
} from '@vibe/contracts';
import type { PersistenceClient } from './persistence';
import { NotFoundError } from './persistence';
import { MockRuntimeAdapter } from './runtime';

type InvokeEvent = IpcMainInvokeEvent;
type Handler<TInput, TOutput> = (input: TInput) => TOutput | Promise<TOutput>;

export class IpcRouter {
  private readonly subscriptions = new Map<number, Set<string>>();
  private readonly runtime: MockRuntimeAdapter;

  constructor(
    private readonly window: BrowserWindow,
    private readonly persistence: PersistenceClient,
    private readonly trustedRendererOrigin: string,
  ) {
    this.runtime = new MockRuntimeAdapter(persistence, (event) => this.publish(event));
  }

  register(): void {
    this.handle(IPC_CHANNELS.appGetInfo, emptyPayloadSchema, appInfoSchema, () => ({
      version: app.getVersion(), platform: process.platform,
    }));
    this.handle(IPC_CHANNELS.tasksList, emptyPayloadSchema, z.array(taskSummarySchema), () => this.persistence.listTasks());
    this.handle(IPC_CHANNELS.tasksCreate, taskCreateInputSchema, taskSummarySchema, (input) => this.persistence.createTask(input.title));
    this.handle(IPC_CHANNELS.tasksMessages, taskIdPayloadSchema, z.array(chatMessageSchema), (input) =>
      this.persistence.listMessages(input.taskId));
    this.handle(IPC_CHANNELS.tasksRename, taskRenameInputSchema, taskSummarySchema, (input) =>
      this.persistence.renameTask(input.taskId, input.title));
    this.handle(IPC_CHANNELS.turnsStart, turnStartInputSchema, turnStartResultSchema, (input) => {
      const accepted = this.persistence.startTurn(input.taskId, input.text);
      this.publish(accepted.event);
      this.runtime.start(input.taskId, accepted.turnId, input.text);
      return { turnId: accepted.turnId };
    });
    this.handle(IPC_CHANNELS.turnsCancel, turnCancelInputSchema, z.undefined(), (input) => {
      this.runtime.cancel(input.taskId, input.turnId);
      return undefined;
    });
    this.handle(IPC_CHANNELS.turnsSubscribe, turnSubscriptionInputSchema, z.undefined(), (input, event) => {
      const tasks = this.subscriptions.get(event.sender.id) ?? new Set<string>();
      tasks.add(input.taskId);
      this.subscriptions.set(event.sender.id, tasks);
      return undefined;
    });
    this.handle(IPC_CHANNELS.turnsUnsubscribe, turnSubscriptionInputSchema, z.undefined(), (input, event) => {
      this.subscriptions.get(event.sender.id)?.delete(input.taskId);
      return undefined;
    });
    this.window.webContents.once('destroyed', () => this.subscriptions.delete(this.window.webContents.id));
  }

  dispose(): void {
    for (const channel of Object.values(IPC_CHANNELS)) {
      if (channel !== IPC_CHANNELS.turnEvent) ipcMain.removeHandler(channel);
    }
    this.subscriptions.clear();
  }

  private handle<TInput, TOutput>(
    channel: string,
    inputSchema: z.ZodType<TInput>,
    outputSchema: z.ZodType<TOutput>,
    handler: (input: TInput, event: InvokeEvent) => TOutput | Promise<TOutput>,
  ): void {
    const envelopeSchema = commandEnvelopeSchema(inputSchema);
    ipcMain.handle(channel, async (event: InvokeEvent, raw: unknown): Promise<CommandResult<TOutput>> => {
      const fallbackRequestId = getRequestId(raw);
      try {
        this.validateSender(event);
        const envelope = envelopeSchema.parse(raw) as CommandEnvelope<TInput>;
        if (hasTaskId(envelope.payload) && envelope.taskId !== envelope.payload.taskId) throw new SecurityError();
        const value = outputSchema.parse(await handler(envelope.payload, event));
        return { ok: true, requestId: envelope.requestId, value };
      } catch (error) {
        return { ok: false, requestId: fallbackRequestId, error: toPublicError(error) };
      }
    });
  }

  private validateSender(event: InvokeEvent): void {
    const frame = event.senderFrame;
    if (event.sender.id !== this.window.webContents.id || frame === null || frame !== frame.top) {
      throw new SecurityError();
    }
    const url = new URL(frame.url);
    const origin = url.protocol === 'app:' ? `${url.protocol}//${url.host}` : url.origin;
    if (origin !== this.trustedRendererOrigin || (url.protocol === 'app:' && url.host !== 'bundle')) throw new SecurityError();
  }

  private publish(rawEvent: TurnEvent): void {
    const event = turnEventSchema.parse(rawEvent);
    if (this.window.isDestroyed()) return;
    const tasks = this.subscriptions.get(this.window.webContents.id);
    if (tasks?.has(event.taskId)) this.window.webContents.send(IPC_CHANNELS.turnEvent, event);
  }
}

class SecurityError extends Error {}

function getRequestId(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null && 'requestId' in raw && typeof raw.requestId === 'string' && raw.requestId.length > 0) {
    return raw.requestId.slice(0, 128);
  }
  return randomUUID();
}

function hasTaskId(value: unknown): value is { taskId: string } {
  return typeof value === 'object' && value !== null && 'taskId' in value && typeof value.taskId === 'string';
}

function toPublicError(error: unknown): PublicError {
  if (error instanceof NotFoundError) {
    return { code: 'NOT_FOUND', userMessage: '対象が見つかりません。', retryable: false };
  }
  if (error instanceof SecurityError) {
    return { code: 'FORBIDDEN', userMessage: 'この操作は許可されていません。', retryable: false };
  }
  if (error instanceof z.ZodError) {
    return { code: 'INVALID_REQUEST', userMessage: '入力内容を確認してください。', retryable: false };
  }
  return { code: 'INTERNAL_ERROR', userMessage: '処理を完了できませんでした。もう一度お試しください。', retryable: true };
}
