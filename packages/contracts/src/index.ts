import { z } from 'zod';

const idSchema = z.string().min(1).max(128);
const timestampSchema = z.string().datetime();
const taskTextSchema = z.string().max(100_000);

export const toolIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}@[0-9][a-zA-Z0-9._-]{0,31}$/,
  );
export const toolKindSchema = z.enum([
  'fileRead',
  'fileWrite',
  'search',
  'shell',
  'network',
  'backgroundTask',
  'agentControl',
]);
export const toolSideEffectSchema = z.enum([
  'none',
  'read',
  'write',
  'process',
  'network',
  'control',
]);
export const toolRiskSchema = z.enum(['low', 'medium', 'high']);
export const toolCapabilitySchema = z.enum([
  'workspace.read',
  'workspace.write',
  'filesystem.external.read',
  'filesystem.external.write',
  'shell.execute',
  'network.fetch',
  'external.open',
  'secret.use',
  'provider.egress',
]);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const toolCatalogEntrySchema = z
  .object({
    providerName: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    toolId: toolIdSchema,
    version: z.string().regex(/^[0-9][a-zA-Z0-9._-]{0,31}$/),
    kind: toolKindSchema,
    schemaVersion: z.number().int().positive(),
    inputSchema: z.record(z.string(), z.json()),
    inputSchemaDigest: digestSchema,
    outputSchemaDigest: digestSchema,
    schemaDigest: digestSchema,
    sideEffect: toolSideEffectSchema,
    risk: toolRiskSchema,
    requiredCapabilities: z.array(toolCapabilitySchema),
    executionTarget: z.enum(['main', 'utility', 'command-runner', 'mcp-gateway']),
    implementationKind: z.enum(['built-in', 'command-runner', 'mcp-gateway']),
  })
  .strict();
export const toolCatalogSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    providerId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    workspaceId: z.string().min(1).nullable(),
    entries: z.array(toolCatalogEntrySchema),
    digest: digestSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const names = new Set<string>();
    const toolIds = new Set<string>();
    for (const [index, entry] of snapshot.entries.entries()) {
      if (names.has(entry.providerName))
        context.addIssue({
          code: 'custom',
          message: 'Duplicate provider tool name',
          path: ['entries', index, 'providerName'],
        });
      if (toolIds.has(entry.toolId))
        context.addIssue({
          code: 'custom',
          message: 'Duplicate ToolId',
          path: ['entries', index, 'toolId'],
        });
      if (new Set(entry.requiredCapabilities).size !== entry.requiredCapabilities.length)
        context.addIssue({
          code: 'custom',
          message: 'Duplicate required capability',
          path: ['entries', index, 'requiredCapabilities'],
        });
      if (
        (entry.implementationKind === 'command-runner' &&
          entry.executionTarget !== 'command-runner') ||
        (entry.implementationKind === 'mcp-gateway' && entry.executionTarget !== 'mcp-gateway') ||
        (entry.implementationKind === 'built-in' &&
          entry.executionTarget !== 'main' &&
          entry.executionTarget !== 'utility')
      )
        context.addIssue({
          code: 'custom',
          message: 'Implementation kind and execution target mismatch',
          path: ['entries', index, 'implementationKind'],
        });
      if (entry.toolId.slice(entry.toolId.lastIndexOf('@') + 1) !== entry.version)
        context.addIssue({
          code: 'custom',
          message: 'ToolId version mismatch',
          path: ['entries', index, 'version'],
        });
      names.add(entry.providerName);
      toolIds.add(entry.toolId);
    }
  });
export type ToolCatalogEntry = z.infer<typeof toolCatalogEntrySchema>;
export type ToolCatalogSnapshot = z.infer<typeof toolCatalogSnapshotSchema>;

export const taskSummarySchema = z
  .object({
    id: idSchema,
    title: z.string().min(1).max(200),
    pinned: z.boolean(),
    archived: z.boolean(),
    goal: z.string().nullable(),
    workspacePath: z.string().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const chatMessageSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    turnId: idSchema.nullable(),
    author: z.enum(['user', 'assistant', 'system']),
    content: z.string().max(1_000_000),
    createdAt: timestampSchema,
  })
  .strict();
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const turnStageSchema = z.enum(['understanding', 'planning', 'executing', 'synthesizing']);
export type TurnStage = z.infer<typeof turnStageSchema>;

export const queuedInputSchema = z
  .object({
    ordinal: z.number().int().positive(),
    text: taskTextSchema,
  })
  .strict();
export type QueuedInput = z.infer<typeof queuedInputSchema>;

export const contextUsageSchema = z
  .object({
    usedTokens: z.number().int().nonnegative(),
    hardCapTokens: z.number().int().positive(),
    fragments: z.array(
      z
        .object({
          source: z.enum(['system', 'history', 'goal', 'compaction']),
          tokens: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
export type ContextUsage = z.infer<typeof contextUsageSchema>;

const turnEventBase = { taskId: idSchema, turnId: idSchema, seq: z.number().int().positive() };
export const turnEventSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('turn.accepted'), ...turnEventBase, userMessage: chatMessageSchema })
    .strict(),
  z.object({ type: z.literal('stage.changed'), ...turnEventBase, stage: turnStageSchema }).strict(),
  z
    .object({
      type: z.literal('message.delta'),
      ...turnEventBase,
      messageId: idSchema,
      delta: z.string().min(1).max(16_384),
    })
    .strict(),
  z
    .object({
      type: z.literal('turn.completed'),
      ...turnEventBase,
      state: z.enum(['completed', 'canceled', 'failed', 'interrupted']),
      message: chatMessageSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('queue.changed'),
      taskId: idSchema,
      seq: z.number().int().positive(),
      queued: z.array(queuedInputSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal('context.usage'),
      taskId: idSchema,
      seq: z.number().int().positive(),
      usage: contextUsageSchema,
    })
    .strict(),
]);
export type TurnEvent = z.infer<typeof turnEventSchema>;

export const turnSnapshotSchema = z
  .object({
    lastSeq: z.number().int().nonnegative(),
    activeTurn: z
      .object({
        turnId: idSchema,
        stage: turnStageSchema,
        startedAtEpochMs: z.number().int().nonnegative(),
        streamedText: z.string(),
        messageId: idSchema.nullable(),
      })
      .strict()
      .nullable(),
    queued: z.array(queuedInputSchema),
    contextUsage: contextUsageSchema,
  })
  .strict();
export type TurnSnapshot = z.infer<typeof turnSnapshotSchema>;

export const workspaceSelectionSchema = z
  .object({ path: z.string().min(1), name: z.string().min(1) })
  .strict()
  .nullable();
export type WorkspaceSelection = z.infer<typeof workspaceSelectionSchema>;

export const publicErrorCodeSchema = z.enum([
  'NOT_FOUND',
  'TURN_ACTIVE',
  'STEER_STALE',
  'STEER_UNSUPPORTED',
  'OPERATION_CONFLICT',
  'OPERATION_IN_PROGRESS',
  'FORBIDDEN',
  'INVALID_REQUEST',
  'RUNTIME_UNAVAILABLE',
  'RUNTIME_CLI_MISSING',
  'RUNTIME_FAILED',
  'RUNTIME_TIMEOUT',
  'RUNTIME_PROTOCOL_ERROR',
  'INTERNAL_ERROR',
]);
export type PublicErrorCode = z.infer<typeof publicErrorCodeSchema>;

export const publicErrorSchema = z
  .object({
    code: publicErrorCodeSchema,
    userMessage: z.string().min(1).max(500),
    retryable: z.boolean(),
  })
  .strict();
export type PublicError = z.infer<typeof publicErrorSchema>;

export const runtimeKindSchema = z.enum(['mock', 'codex']);
export type RuntimeKind = z.infer<typeof runtimeKindSchema>;
export const codexModelIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const codexModelOptionSchema = z
  .object({
    id: codexModelIdSchema,
    displayName: z.string().min(1).max(128),
    description: z.string().max(300),
  })
  .strict();
export type CodexModelOption = z.infer<typeof codexModelOptionSchema>;
export const runtimeSettingsSchema = z
  .object({
    kind: runtimeKindSchema,
    codexAvailable: z.boolean(),
    model: codexModelIdSchema,
    models: z.array(codexModelOptionSchema).max(32),
  })
  .strict();
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export const runtimeSetInputSchema = z.object({ kind: runtimeKindSchema }).strict();
export const runtimeModelSetInputSchema = z.object({ model: codexModelIdSchema }).strict();

export const accessPresetSchema = z.enum(['ask', 'auto', 'full']);
export type AccessPreset = z.infer<typeof accessPresetSchema>;
export const permissionSettingsSchema = z
  .object({ preset: accessPresetSchema, policyEpoch: z.number().int().nonnegative() })
  .strict();
export type PermissionSettings = z.infer<typeof permissionSettingsSchema>;
export const permissionSetInputSchema = z
  .object({
    taskId: idSchema,
    preset: accessPresetSchema,
    expectedPolicyEpoch: z.number().int().nonnegative(),
  })
  .strict();

export const commandEnvelopeSchema = <T extends z.ZodType>(payload: T) =>
  z
    .object({
      requestId: idSchema,
      operationId: idSchema,
      taskId: idSchema.optional(),
      expectedRevision: z.number().int().nonnegative().optional(),
      payload,
    })
    .strict();
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

export const commandResultSchema = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion('ok', [
    z
      .object({
        ok: z.literal(true),
        requestId: idSchema,
        revision: z.number().int().nonnegative().optional(),
        value,
      })
      .strict(),
    z.object({ ok: z.literal(false), requestId: idSchema, error: publicErrorSchema }).strict(),
  ]);

export const emptyPayloadSchema = z.object({}).strict();
export const taskCreateInputSchema = z
  .object({ title: z.string().trim().min(1).max(200).optional() })
  .strict();
export const taskIdPayloadSchema = z.object({ taskId: idSchema }).strict();
export const taskRenameInputSchema = z
  .object({ taskId: idSchema, title: z.string().trim().min(1).max(200) })
  .strict();
export const taskPinnedInputSchema = z.object({ taskId: idSchema, pinned: z.boolean() }).strict();
export const taskArchivedInputSchema = z
  .object({ taskId: idSchema, archived: z.boolean() })
  .strict();
export const taskGoalInputSchema = z.object({ taskId: idSchema, goal: taskTextSchema }).strict();
export const taskDraftInputSchema = z.object({ taskId: idSchema, draft: taskTextSchema }).strict();
export const turnStartInputSchema = z
  .object({ taskId: idSchema, text: z.string().trim().min(1).max(100_000) })
  .strict();
export const turnQueueInputSchema = turnStartInputSchema;
export const turnQueueResultSchema = z.object({ ordinal: z.number().int().positive() }).strict();
export const turnSteerInputSchema = z
  .object({
    taskId: idSchema,
    text: z.string().trim().min(1).max(100_000),
    expectedTurnId: idSchema,
  })
  .strict();
export const turnStopAndSendInputSchema = turnStartInputSchema;
export const turnCancelInputSchema = z.object({ taskId: idSchema, turnId: idSchema }).strict();
export const turnSubscriptionInputSchema = z
  .object({
    taskId: idSchema,
    afterSeq: z.number().int().nonnegative().optional(),
  })
  .strict();
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
    setPinned(taskId: string, pinned: boolean): Promise<TaskSummary>;
    setArchived(taskId: string, archived: boolean): Promise<TaskSummary>;
    setGoal(taskId: string, goal: string): Promise<TaskSummary>;
    getDraft(taskId: string): Promise<string>;
    setDraft(taskId: string, draft: string): Promise<void>;
  };
  workspace: {
    get(taskId: string): Promise<WorkspaceSelection>;
    select(taskId: string): Promise<WorkspaceSelection>;
  };
  settings: {
    getRuntime(): Promise<RuntimeSettings>;
    setRuntime(kind: 'mock' | 'codex'): Promise<void>;
    setModel(model: string): Promise<void>;
  };
  permissions: {
    get(taskId: string): Promise<PermissionSettings>;
    set(
      taskId: string,
      preset: AccessPreset,
      expectedPolicyEpoch: number,
    ): Promise<PermissionSettings>;
  };
  turns: {
    start(input: { taskId: string; text: string }): Promise<{ turnId: string }>;
    queue(input: { taskId: string; text: string }): Promise<{ ordinal: number }>;
    steer(input: { taskId: string; text: string; expectedTurnId: string }): Promise<void>;
    stopAndSend(input: { taskId: string; text: string }): Promise<void>;
    cancel(input: { taskId: string; turnId: string }): Promise<void>;
    snapshot(taskId: string): Promise<TurnSnapshot>;
    subscribe(
      taskId: string,
      cb: (ev: TurnEvent) => void,
      opts?: { afterSeq?: number },
    ): () => void;
  };
}

export const IPC_CHANNELS = {
  appGetInfo: 'vibe:app:get-info',
  tasksList: 'vibe:tasks:list',
  tasksCreate: 'vibe:tasks:create',
  tasksMessages: 'vibe:tasks:messages',
  tasksRename: 'vibe:tasks:rename',
  tasksSetPinned: 'vibe:tasks:set-pinned',
  tasksSetArchived: 'vibe:tasks:set-archived',
  tasksSetGoal: 'vibe:tasks:set-goal',
  tasksGetDraft: 'vibe:tasks:get-draft',
  tasksSetDraft: 'vibe:tasks:set-draft',
  workspaceGet: 'vibe:workspace:get',
  workspaceSelect: 'vibe:workspace:select',
  settingsGetRuntime: 'vibe:settings:get-runtime',
  settingsSetRuntime: 'vibe:settings:set-runtime',
  settingsSetModel: 'vibe:settings:set-model',
  permissionsGet: 'vibe:permissions:get',
  permissionsSet: 'vibe:permissions:set',
  turnsStart: 'vibe:turns:start',
  turnsQueue: 'vibe:turns:queue',
  turnsSteer: 'vibe:turns:steer',
  turnsStopAndSend: 'vibe:turns:stop-and-send',
  turnsCancel: 'vibe:turns:cancel',
  turnsSnapshot: 'vibe:turns:snapshot',
  turnsSubscribe: 'vibe:turns:subscribe',
  turnsPort: 'vibe:turns:port',
} as const;
