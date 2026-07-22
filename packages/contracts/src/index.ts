import { z } from 'zod';

const idSchema = z.string().min(1).max(128);
const timestampSchema = z.string().datetime();

export const taskSummarySchema = z.object({
  id: idSchema,
  title: z.string().min(1).max(200),
  pinned: z.boolean(),
  archived: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const chatMessageSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  turnId: idSchema.nullable(),
  author: z.enum(['user', 'assistant', 'system']),
  content: z.string().max(1_000_000),
  createdAt: timestampSchema,
}).strict();

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const turnStageSchema = z.enum([
  'understanding',
  'planning',
  'executing',
  'synthesizing',
]);
export type TurnStage = z.infer<typeof turnStageSchema>;

const eventBase = {
  taskId: idSchema,
  turnId: idSchema,
  seq: z.number().int().positive(),
};

export const turnEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('turn.accepted'),
    ...eventBase,
    userMessage: chatMessageSchema,
  }).strict(),
  z.object({
    type: z.literal('stage.changed'),
    ...eventBase,
    stage: turnStageSchema,
  }).strict(),
  z.object({
    type: z.literal('message.delta'),
    ...eventBase,
    messageId: idSchema,
    delta: z.string().min(1).max(16_384),
  }).strict(),
  z.object({
    type: z.literal('turn.completed'),
    ...eventBase,
    state: z.enum(['completed', 'canceled', 'failed', 'interrupted']),
    message: chatMessageSchema.optional(),
  }).strict(),
]);

export type TurnEvent = z.infer<typeof turnEventSchema>;

export const publicErrorSchema = z.object({
  code: z.string().min(1).max(80),
  userMessage: z.string().min(1).max(500),
  retryable: z.boolean(),
}).strict();
export type PublicError = z.infer<typeof publicErrorSchema>;

export const commandEnvelopeSchema = <T extends z.ZodType>(payload: T) => z.object({
  requestId: idSchema,
  operationId: idSchema,
  taskId: idSchema.optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  payload,
}).strict();

export type CommandEnvelope<T> = {
  requestId: string;
  operationId: string;
  taskId?: string;
  expectedRevision?: number;
  payload: T;
};

export type CommandResult<T> =
  | { ok: true; requestId: string; revision?: number; value: T }
  | { ok: false; requestId: string; error: PublicError };

export const commandResultSchema = <T extends z.ZodType>(value: T) => z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    requestId: idSchema,
    revision: z.number().int().nonnegative().optional(),
    value,
  }).strict(),
  z.object({
    ok: z.literal(false),
    requestId: idSchema,
    error: publicErrorSchema,
  }).strict(),
]);

export const emptyPayloadSchema = z.object({}).strict();
export const taskCreateInputSchema = z.object({ title: z.string().trim().min(1).max(200).optional() }).strict();
export const taskIdPayloadSchema = z.object({ taskId: idSchema }).strict();
export const taskRenameInputSchema = z.object({ taskId: idSchema, title: z.string().trim().min(1).max(200) }).strict();
export const turnStartInputSchema = z.object({ taskId: idSchema, text: z.string().trim().min(1).max(100_000) }).strict();
export const turnCancelInputSchema = z.object({ taskId: idSchema, turnId: idSchema }).strict();
export const turnSubscriptionInputSchema = z.object({ taskId: idSchema }).strict();
export const appInfoSchema = z.object({ version: z.string(), platform: z.string() }).strict();
export const turnStartResultSchema = z.object({ turnId: idSchema }).strict();
export const voidResultSchema = z.undefined();

export interface VibeApi {
  app: { getInfo(): Promise<{ version: string; platform: string }> };
  tasks: {
    list(): Promise<TaskSummary[]>;
    create(input?: { title?: string }): Promise<TaskSummary>;
    messages(taskId: string): Promise<ChatMessage[]>;
    rename(taskId: string, title: string): Promise<TaskSummary>;
  };
  turns: {
    start(input: { taskId: string; text: string }): Promise<{ turnId: string }>;
    cancel(input: { taskId: string; turnId: string }): Promise<void>;
    subscribe(taskId: string, cb: (ev: TurnEvent) => void): () => void;
  };
}

export const IPC_CHANNELS = {
  appGetInfo: 'vibe:app:get-info',
  tasksList: 'vibe:tasks:list',
  tasksCreate: 'vibe:tasks:create',
  tasksMessages: 'vibe:tasks:messages',
  tasksRename: 'vibe:tasks:rename',
  turnsStart: 'vibe:turns:start',
  turnsCancel: 'vibe:turns:cancel',
  turnsSubscribe: 'vibe:turns:subscribe',
  turnsUnsubscribe: 'vibe:turns:unsubscribe',
  turnEvent: 'vibe:turns:event',
} as const;
