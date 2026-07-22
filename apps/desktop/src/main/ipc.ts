import {
  app,
  dialog,
  ipcMain,
  MessageChannelMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type MessagePortMain,
} from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import {
  IPC_CHANNELS,
  appInfoSchema,
  chatMessageSchema,
  commandEnvelopeSchema,
  emptyPayloadSchema,
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
  type PublicError,
  type TurnEvent,
} from '@vibe/contracts';
import type { PersistenceClient, QueueTransition, StartedTurn } from './persistence';
import {
  NotFoundError,
  OperationConflictError,
  OperationInProgressError,
  SteerStaleError,
  TurnActiveError,
} from './persistence';
import { MockRuntimeAdapter } from './runtime';

type InvokeEvent = IpcMainInvokeEvent;
type PortBinding = { taskId: string; port: MessagePortMain };

export class IpcRouter {
  private readonly ports = new Set<PortBinding>();
  private readonly mailbox = new TaskMailbox();
  private readonly runtime: MockRuntimeAdapter;

  constructor(
    private readonly window: BrowserWindow,
    private readonly persistence: PersistenceClient,
    private readonly trustedRendererOrigin: string,
  ) {
    this.runtime = new MockRuntimeAdapter(
      persistence,
      (event) => this.publish(event),
      240,
      (taskId, action) => this.mailbox.run(taskId, action),
      (taskId, turnId, state) => this.finishAndAdvance(taskId, turnId, state),
    );
  }

  register(): void {
    this.handle(IPC_CHANNELS.appGetInfo, emptyPayloadSchema, appInfoSchema, () => ({
      version: app.getVersion(),
      platform: process.platform,
    }));
    this.handle(IPC_CHANNELS.tasksList, emptyPayloadSchema, z.array(taskSummarySchema), () =>
      this.persistence.listTasks(),
    );
    this.handleMutation(
      IPC_CHANNELS.tasksCreate,
      taskCreateInputSchema,
      taskSummarySchema,
      (_input, _event, envelope) =>
        this.runMutation(_event, envelope, '', IPC_CHANNELS.tasksCreate, () =>
          this.persistence.createTask(_input.title),
        ).value,
    );
    this.handle(
      IPC_CHANNELS.tasksMessages,
      taskIdPayloadSchema,
      z.array(chatMessageSchema),
      (input) => this.persistence.listMessages(input.taskId),
    );
    this.handleMutation(
      IPC_CHANNELS.tasksRename,
      taskRenameInputSchema,
      taskSummarySchema,
      (input, event, envelope) =>
        this.runMutation(event, envelope, input.taskId, IPC_CHANNELS.tasksRename, () =>
          this.persistence.renameTask(input.taskId, input.title),
        ).value,
    );
    this.handleMutation(
      IPC_CHANNELS.tasksSetPinned,
      taskPinnedInputSchema,
      taskSummarySchema,
      (input, event, envelope) =>
        this.runMutation(event, envelope, input.taskId, IPC_CHANNELS.tasksSetPinned, () =>
          this.persistence.setPinned(input.taskId, input.pinned),
        ).value,
    );
    this.handleMutation(
      IPC_CHANNELS.tasksSetArchived,
      taskArchivedInputSchema,
      taskSummarySchema,
      (input, event, envelope) =>
        this.runMutation(event, envelope, input.taskId, IPC_CHANNELS.tasksSetArchived, () =>
          this.persistence.setArchived(input.taskId, input.archived),
        ).value,
    );
    this.handleMutation(
      IPC_CHANNELS.tasksSetGoal,
      taskGoalInputSchema,
      taskSummarySchema,
      (input, event, envelope) =>
        this.runMutation(event, envelope, input.taskId, IPC_CHANNELS.tasksSetGoal, () =>
          this.persistence.setGoal(input.taskId, input.goal),
        ).value,
    );
    this.handle(IPC_CHANNELS.tasksGetDraft, taskIdPayloadSchema, z.string(), (input) =>
      this.persistence.getDraft(input.taskId),
    );
    this.handleMutation(
      IPC_CHANNELS.tasksSetDraft,
      taskDraftInputSchema,
      z.undefined(),
      (input, event, envelope) =>
        this.runMutation(event, envelope, input.taskId, IPC_CHANNELS.tasksSetDraft, () =>
          this.persistence.setDraft(input.taskId, input.draft),
        ).value,
    );

    this.handle(IPC_CHANNELS.workspaceGet, taskIdPayloadSchema, workspaceSelectionSchema, (input) =>
      workspaceValue(this.persistence.getWorkspace(input.taskId)),
    );
    this.handleMutation(
      IPC_CHANNELS.workspaceSelect,
      taskIdPayloadSchema,
      workspaceSelectionSchema,
      async (input, event, envelope) => {
        this.persistence.getWorkspace(input.taskId);
        const principal = principalFor(event);
        const hash = requestHash(envelope.payload);
        const cached = this.persistence.getOperationResult<ReturnType<typeof workspaceValue>>(
          principal,
          input.taskId,
          IPC_CHANNELS.workspaceSelect,
          envelope.operationId,
          hash,
        );
        if (cached.found) return cached.value ?? null;
        const selected = await dialog.showOpenDialog(this.window, {
          properties: ['openDirectory'],
        });
        if (selected.canceled || selected.filePaths.length === 0) {
          return this.persistence.executeOperation(
            principal,
            input.taskId,
            IPC_CHANNELS.workspaceSelect,
            envelope.operationId,
            hash,
            () => null,
          );
        }
        const selectedPath = selected.filePaths[0];
        if (selectedPath === undefined)
          throw new Error('Directory selection did not include a path');
        const canonicalPath = await realpath(selectedPath);
        return this.persistence.executeOperation(
          principal,
          input.taskId,
          IPC_CHANNELS.workspaceSelect,
          envelope.operationId,
          hash,
          () => {
            this.persistence.setWorkspace(input.taskId, canonicalPath);
            return workspaceValue(canonicalPath);
          },
        );
      },
    );

    this.handleMutation(
      IPC_CHANNELS.turnsStart,
      turnStartInputSchema,
      turnStartResultSchema,
      (input, event, envelope) => {
        let started: StartedTurn | undefined;
        const result = this.runMutation(
          event,
          envelope,
          input.taskId,
          IPC_CHANNELS.turnsStart,
          () => {
            started = this.persistence.startTurn(input.taskId, input.text);
            return { turnId: started.turnId };
          },
        );
        if (result.executed && started !== undefined) this.dispatchStarted(started);
        return result.value;
      },
    );
    this.handleMutation(
      IPC_CHANNELS.turnsQueue,
      turnQueueInputSchema,
      turnQueueResultSchema,
      (input, event, envelope) => {
        let queueEvent: TurnEvent | undefined;
        const result = this.runMutation(
          event,
          envelope,
          input.taskId,
          IPC_CHANNELS.turnsQueue,
          () => {
            const queued = this.persistence.queueInput(
              input.taskId,
              input.text,
              envelope.operationId,
            );
            queueEvent = queued.event;
            return { ordinal: queued.ordinal };
          },
        );
        if (result.executed && queueEvent !== undefined) this.publish(queueEvent);
        return result.value;
      },
    );
    this.handleMutation(
      IPC_CHANNELS.turnsSteer,
      turnSteerInputSchema,
      z.undefined(),
      (input, event, envelope) => {
        const result = this.runMutation(
          event,
          envelope,
          input.taskId,
          IPC_CHANNELS.turnsSteer,
          () => this.persistence.steerTurn(input.taskId, input.text, input.expectedTurnId),
        );
        if (result.executed) this.runtime.steer(input.expectedTurnId, input.text);
        return result.value;
      },
    );
    this.handleMutation(
      IPC_CHANNELS.turnsStopAndSend,
      turnStopAndSendInputSchema,
      z.undefined(),
      (input, event, envelope) => {
        let canceledTurnId: string | null = null;
        let canceledEvent: TurnEvent | null = null;
        let started: StartedTurn | undefined;
        const result = this.runMutation(
          event,
          envelope,
          input.taskId,
          IPC_CHANNELS.turnsStopAndSend,
          () => {
            canceledTurnId = this.persistence.getActiveTurnId(input.taskId);
            if (canceledTurnId !== null)
              canceledEvent = this.persistence.cancelTurn(input.taskId, canceledTurnId);
            started = this.persistence.startTurn(input.taskId, input.text);
          },
        );
        if (result.executed) {
          if (canceledTurnId !== null) this.runtime.cancel(canceledTurnId);
          if (canceledEvent !== null) this.publish(canceledEvent);
          if (started !== undefined) this.dispatchStarted(started);
        }
        return result.value;
      },
    );
    this.handleMutation(
      IPC_CHANNELS.turnsCancel,
      turnCancelInputSchema,
      z.undefined(),
      (input, event, envelope) => {
        let canceledEvent: TurnEvent | null = null;
        let next: QueueTransition = null;
        const result = this.runMutation(
          event,
          envelope,
          input.taskId,
          IPC_CHANNELS.turnsCancel,
          () => {
            canceledEvent = this.persistence.cancelTurn(input.taskId, input.turnId);
            next = canceledEvent === null ? null : this.persistence.startNextQueued(input.taskId);
          },
        );
        if (result.executed) {
          this.runtime.cancel(input.turnId);
          if (canceledEvent !== null) this.publish(canceledEvent);
          this.dispatchQueueTransition(next);
        }
        return result.value;
      },
    );
    this.handle(
      IPC_CHANNELS.turnsSnapshot,
      taskIdPayloadSchema,
      turnSnapshotSchema,
      async (input) =>
        this.mailbox.run(input.taskId, () => {
          const next = this.persistence.startNextQueued(input.taskId);
          this.dispatchQueueTransition(next);
          return this.persistence.snapshot(input.taskId);
        }),
    );
    this.handle(
      IPC_CHANNELS.turnsSubscribe,
      turnSubscriptionInputSchema,
      z.undefined(),
      (input, event, envelope) => {
        const replay = this.persistence.listEventsAfter(input.taskId, input.afterSeq ?? 0);
        const frame = event.senderFrame;
        if (frame === null) throw new SecurityError();
        const { port1, port2 } = new MessageChannelMain();
        const binding: PortBinding = { taskId: input.taskId, port: port1 };
        this.ports.add(binding);
        port1.on('message', ({ data }: { data: unknown }) => {
          if (isUnsubscribeMessage(data)) this.closePort(binding);
        });
        port1.on('close', () => this.ports.delete(binding));
        port1.start();
        frame.postMessage(
          IPC_CHANNELS.turnsPort,
          { requestId: envelope.requestId, taskId: input.taskId },
          [port2],
        );
        for (const replayed of replay) port1.postMessage(replayed);
        return undefined;
      },
    );
    this.window.webContents.once('destroyed', () => this.closeAllPorts());
  }

  dispose(): void {
    for (const channel of new Set(Object.values(IPC_CHANNELS))) ipcMain.removeHandler(channel);
    this.closeAllPorts();
  }

  private handle<TInput, TOutput>(
    channel: string,
    inputSchema: z.ZodType<TInput>,
    outputSchema: z.ZodType<TOutput>,
    handler: (
      input: TInput,
      event: InvokeEvent,
      envelope: CommandEnvelope<TInput>,
    ) => TOutput | Promise<TOutput>,
  ): void {
    const envelopeSchema = commandEnvelopeSchema(inputSchema);
    ipcMain.handle(
      channel,
      async (event: InvokeEvent, raw: unknown): Promise<CommandResult<TOutput>> => {
        const fallbackRequestId = getRequestId(raw);
        try {
          this.validateSender(event);
          const envelope = envelopeSchema.parse(raw) as CommandEnvelope<TInput>;
          if (hasTaskId(envelope.payload) && envelope.taskId !== envelope.payload.taskId)
            throw new SecurityError();
          const value = outputSchema.parse(await handler(envelope.payload, event, envelope));
          return { ok: true, requestId: envelope.requestId, value };
        } catch (error) {
          return { ok: false, requestId: fallbackRequestId, error: toPublicError(error) };
        }
      },
    );
  }

  private handleMutation<TInput, TOutput>(
    channel: string,
    inputSchema: z.ZodType<TInput>,
    outputSchema: z.ZodType<TOutput>,
    handler: (
      input: TInput,
      event: InvokeEvent,
      envelope: CommandEnvelope<TInput>,
    ) => TOutput | Promise<TOutput>,
  ): void {
    this.handle(channel, inputSchema, outputSchema, (input, event, envelope) =>
      this.mailbox.run(envelope.taskId ?? '__global__', () => handler(input, event, envelope)),
    );
  }

  private runMutation<TInput, TOutput>(
    event: InvokeEvent,
    envelope: CommandEnvelope<TInput>,
    taskId: string,
    kind: string,
    action: () => TOutput,
  ): { value: TOutput; executed: boolean } {
    const principal = principalFor(event);
    const hash = requestHash(envelope.payload);
    const cached = this.persistence.getOperationResult<TOutput>(
      principal,
      taskId,
      kind,
      envelope.operationId,
      hash,
    );
    if (cached.found) return { value: cached.value as TOutput, executed: false };
    return {
      value: this.persistence.executeOperation(
        principal,
        taskId,
        kind,
        envelope.operationId,
        hash,
        action,
      ),
      executed: true,
    };
  }

  private finishAndAdvance(taskId: string, turnId: string, state: 'completed' | 'failed'): void {
    this.publish(this.persistence.completeTurn(taskId, turnId, state));
    this.dispatchQueueTransition(this.persistence.startNextQueued(taskId));
  }

  private dispatchStarted(started: StartedTurn): void {
    this.publish(started.event);
    this.runtime.start(started.event.taskId, started.turnId, started.text);
  }

  private dispatchQueueTransition(transition: QueueTransition): void {
    if (transition === null) return;
    this.publish(transition.started.event);
    this.publish(transition.queueEvent);
    this.runtime.start(
      transition.started.event.taskId,
      transition.started.turnId,
      transition.started.text,
    );
  }

  private validateSender(event: InvokeEvent): void {
    const frame = event.senderFrame;
    if (event.sender.id !== this.window.webContents.id || frame === null || frame !== frame.top)
      throw new SecurityError();
    const url = new URL(frame.url);
    const origin = url.protocol === 'app:' ? `${url.protocol}//${url.host}` : url.origin;
    if (origin !== this.trustedRendererOrigin || (url.protocol === 'app:' && url.host !== 'bundle'))
      throw new SecurityError();
  }

  private publish(rawEvent: TurnEvent): void {
    const event = turnEventSchema.parse(rawEvent);
    for (const binding of this.ports) {
      if (binding.taskId === event.taskId) binding.port.postMessage(event);
    }
  }

  private closePort(binding: PortBinding): void {
    this.ports.delete(binding);
    binding.port.close();
  }

  private closeAllPorts(): void {
    for (const binding of [...this.ports]) this.closePort(binding);
  }
}

export class TaskMailbox {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(taskId: string, action: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(taskId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(taskId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(taskId) === tail) this.tails.delete(taskId);
    }
  }
}

class SecurityError extends Error {}

function principalFor(_event: InvokeEvent): string {
  return 'local-desktop';
}

function requestHash(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortValue(payload)))
    .digest('hex');
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

function getRequestId(raw: unknown): string {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'requestId' in raw &&
    typeof raw.requestId === 'string' &&
    raw.requestId.length > 0
  ) {
    return raw.requestId.slice(0, 128);
  }
  return randomUUID();
}

function hasTaskId(value: unknown): value is { taskId: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'taskId' in value &&
    typeof value.taskId === 'string'
  );
}

function isUnsubscribeMessage(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && 'type' in value && value.type === 'unsubscribe'
  );
}

function workspaceValue(path: string | null): { path: string; name: string } | null {
  return path === null ? null : { path, name: basename(path) || path };
}

function toPublicError(error: unknown): PublicError {
  if (error instanceof NotFoundError)
    return { code: 'NOT_FOUND', userMessage: '対象が見つかりません。', retryable: false };
  if (error instanceof TurnActiveError)
    return {
      code: 'TURN_ACTIVE',
      userMessage: 'このタスクでは別のTurnが実行中です。',
      retryable: false,
    };
  if (error instanceof SteerStaleError)
    return {
      code: 'STEER_STALE',
      userMessage: '対象のTurnはすでに切り替わっています。',
      retryable: false,
    };
  if (error instanceof OperationConflictError)
    return {
      code: 'OPERATION_CONFLICT',
      userMessage: '同じ操作IDが異なる内容で再利用されました。',
      retryable: false,
    };
  if (error instanceof OperationInProgressError)
    return {
      code: 'OPERATION_IN_PROGRESS',
      userMessage: '同じ操作を処理中です。',
      retryable: true,
    };
  if (error instanceof SecurityError)
    return { code: 'FORBIDDEN', userMessage: 'この操作は許可されていません。', retryable: false };
  if (error instanceof z.ZodError)
    return {
      code: 'INVALID_REQUEST',
      userMessage: '入力内容を確認してください。',
      retryable: false,
    };
  return {
    code: 'INTERNAL_ERROR',
    userMessage: '処理を完了できませんでした。もう一度お試しください。',
    retryable: true,
  };
}
