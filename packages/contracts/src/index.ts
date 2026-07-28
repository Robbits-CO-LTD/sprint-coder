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
    localOnly: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const teamStateSchema = z.enum([
  'draft',
  'forming',
  'active',
  'paused',
  'winding_down',
  'completed',
  'failed',
]);
export const teamPolicySchema = z
  .object({
    maxAgentDepth: z.number().int().min(1).max(4),
    maxConcurrentExecutions: z.number().int().min(1).max(8),
    allowWorkerDirectMessages: z.boolean(),
    budgetMode: z.enum(['bounded', 'unlimited']),
  })
  .strict();
export type TeamPolicy = z.infer<typeof teamPolicySchema>;
export const teamPolicyUpdateInputSchema = z
  .object({
    taskId: idSchema,
    policy: teamPolicySchema,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export type TeamPolicyUpdateInput = z.infer<typeof teamPolicyUpdateInputSchema>;
export const managerPolicySchema = z
  .object({
    maxDirectChildren: z.number().int().positive().nullable(),
    maxDelegationDepth: z.number().int().min(1).max(4),
    allowManagerChildren: z.boolean(),
  })
  .strict();
export type ManagerPolicy = z.infer<typeof managerPolicySchema>;
export const teamSummarySchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    state: teamStateSchema,
    leaderAgentId: idSchema,
    budget: z.record(z.string(), z.json()),
    policy: teamPolicySchema,
    revision: z.number().int().nonnegative(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type TeamSummary = z.infer<typeof teamSummarySchema>;

export const workerStateSchema = z.enum([
  'invited',
  'spawning',
  'ready',
  'busy',
  'waiting',
  'done',
  'failed',
  'stopped',
]);
export const teamMessageStateSchema = z.enum([
  'created',
  'persisted',
  'dispatching',
  'delivered',
  'acknowledged',
]);
export const teamDeliveryStateSchema = z.enum([
  'persisted',
  'dispatched',
  'acked',
  'timedOut',
  'failed',
]);
export const contextInheritancePolicySchema = z.enum([
  'none',
  'summary',
  'selected_items',
  'full_fork',
]);

export const teamUsageTotalsSchema = z
  .object({
    costCents: z.number().int().min(0),
    tokens: z.number().int().min(0),
    timeMs: z.number().int().min(0),
    toolCalls: z.number().int().min(0),
  })
  .strict();
export type TeamUsageTotals = z.infer<typeof teamUsageTotalsSchema>;

export const teamBudgetStatusSchema = z
  .object({
    scope: z.enum(['global', 'team', 'worker']),
    kind: z.enum(['costCents', 'tokens', 'timeMs', 'toolCalls', 'spawnSlots']),
    cap: z.number().int().min(0),
    committed: z.number().int().min(0),
    reserved: z.number().int().min(0),
  })
  .strict();
export type TeamBudgetStatus = z.infer<typeof teamBudgetStatusSchema>;

export const workerSummarySchema = z
  .object({
    id: idSchema,
    teamId: idSchema,
    threadId: idSchema,
    taskId: idSchema,
    kind: z.enum(['leader', 'worker']),
    role: z.string(),
    state: workerStateSchema,
    objective: z.string().nullable(),
    writeCapable: z.boolean(),
    currentActivity: z.string().nullable(),
    engine: z.enum(['mock', 'codex', 'claude']),
    parentAgentId: idSchema.nullable(),
    depth: z.number().int().min(0).max(4),
    canDelegate: z.boolean(),
    managerPolicy: managerPolicySchema.nullable(),
    liveOutput: z.string().max(20_000),
    reasoningActive: z.boolean(),
    usage: teamUsageTotalsSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type WorkerSummary = z.infer<typeof workerSummarySchema>;

export const teamMessageSummarySchema = z
  .object({
    id: idSchema,
    teamId: idSchema,
    sourceAgentId: idSchema,
    targetAgentId: idSchema,
    sourceKind: z.enum(['leader', 'worker']),
    targetKind: z.enum(['leader', 'worker']),
    seq: z.number().int().min(1),
    state: teamMessageStateSchema,
    content: z.string(),
    executionId: idSchema.nullable(),
    attemptId: idSchema.nullable(),
    deliveryState: teamDeliveryStateSchema.nullable(),
    attempt: z.number().int().min(0),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type TeamMessageSummary = z.infer<typeof teamMessageSummarySchema>;

export const teamExecutionSummarySchema = z
  .object({
    id: idSchema,
    teamId: idSchema,
    assigneeAgentId: idSchema,
    createdByAgentId: idSchema,
    state: z.enum([
      'assigned',
      'queued',
      'waiting_verification',
      'waiting_rate_limit',
      'running',
      'completed',
      'failed',
      'canceled',
    ]),
    instructionPreview: z.string().max(500),
    instructionRevision: z.number().int().min(1),
    queueOrdinal: z.number().int().min(1).nullable(),
    queueReason: z
      .enum([
        'global_concurrency',
        'connection_concurrency',
        'verification',
        'rate_limit',
        'budget',
        'recovery',
      ])
      .nullable(),
    connectionId: z.string().min(1).max(128).nullable(),
    requestedModel: z.string().min(1).max(128).nullable(),
    assignedAt: timestampSchema,
    queuedAt: timestampSchema.nullable(),
    startedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
    updatedAt: timestampSchema,
  })
  .strict();
export type TeamExecutionSummary = z.infer<typeof teamExecutionSummarySchema>;

export const teamActivitySummarySchema = z
  .object({
    id: idSchema,
    teamId: idSchema,
    seq: z.number().int().min(1),
    type: z.enum([
      'worker_hired',
      'task_assigned',
      'execution_queued',
      'execution_waiting',
      'execution_started',
      'execution_finished',
      'steered',
      'attempt_started',
      'attempt_finished',
      'worker_reported',
      'worker_stopped',
    ]),
    actorAgentId: idSchema.nullable(),
    actorRole: z.string().min(1).nullable(),
    subjectAgentId: idSchema.nullable(),
    subjectRole: z.string().min(1).nullable(),
    executionId: idSchema.nullable(),
    attemptId: idSchema.nullable(),
    status: z.string().min(1).max(64).nullable(),
    queueReason: z
      .enum([
        'global_concurrency',
        'connection_concurrency',
        'verification',
        'rate_limit',
        'budget',
        'recovery',
      ])
      .nullable(),
    attemptOrdinal: z.number().int().min(1).nullable(),
    terminalReason: z.string().min(1).max(128).nullable(),
    recordedAt: timestampSchema,
  })
  .strict();
export type TeamActivitySummary = z.infer<typeof teamActivitySummarySchema>;

export const teamDetailSchema = z
  .object({
    team: teamSummarySchema,
    workers: z.array(workerSummarySchema),
    messages: z.array(teamMessageSummarySchema),
    executions: z.array(teamExecutionSummarySchema),
    activities: z.array(teamActivitySummarySchema),
    budgets: z.array(teamBudgetStatusSchema),
  })
  .strict();
export type TeamDetail = z.infer<typeof teamDetailSchema>;

export const workerCompletionSchema = z
  .object({
    status: z.enum(['succeeded', 'failed', 'partial']),
    summary: z.string().min(1).max(4_000),
    artifacts: z
      .array(
        z
          .object({
            kind: z.enum(['file', 'patch', 'note']),
            reference: z.string().min(1).max(1_024),
            digest: digestSchema.optional(),
          })
          .strict(),
      )
      .max(20),
    verification: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            outcome: z.enum(['pass', 'fail', 'skipped']),
            detail: z.string().max(2_000).optional(),
          })
          .strict(),
      )
      .max(20),
    risks: z.array(z.string().min(1).max(500)).max(20),
  })
  .strict();
export type WorkerCompletion = z.infer<typeof workerCompletionSchema>;

export const workerReportSchema = z
  .object({
    status: z.enum(['completed', 'blocked', 'needs_input', 'failed']),
    summary: z.string().min(1).max(4_000),
    findings: z
      .array(
        z
          .object({
            severity: z.enum(['high', 'medium', 'low']),
            message: z.string().min(1).max(2_000),
            file: z.string().min(1).max(1_024).optional(),
          })
          .strict(),
      )
      .max(100),
    changedFiles: z.array(z.string().min(1).max(1_024)).max(200),
    artifacts: workerCompletionSchema.shape.artifacts,
    verification: workerCompletionSchema.shape.verification,
    risks: workerCompletionSchema.shape.risks,
    nextActions: z.array(z.string().min(1).max(1_000)).max(50),
    doneEvidence: z
      .array(
        z
          .object({
            criterion: z.string().min(1).max(1_000),
            evidence: z.string().min(1).max(4_000),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export type WorkerReport = z.infer<typeof workerReportSchema>;

export const connectionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const providerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
export const modelSelectionSchema = z
  .object({
    connectionId: connectionIdSchema.nullable(),
    requestedProvider: providerIdSchema.nullable(),
    requestedModel: z.string().min(1).max(128).nullable(),
  })
  .strict()
  .refine(
    ({ connectionId, requestedProvider, requestedModel }) =>
      (connectionId === null && requestedProvider === null && requestedModel === null) ||
      (connectionId !== null && requestedProvider !== null && requestedModel !== null),
    { message: 'Model selection identity must be either complete or entirely unknown' },
  );
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

export const teamHireWorkerInputSchema = z
  .object({
    taskId: idSchema,
    role: z.string().min(1).max(100),
    objective: z.string().min(1).max(10_000),
    contextInheritancePolicy: contextInheritancePolicySchema,
    writeCapable: z.boolean(),
    modelSelection: modelSelectionSchema.optional(),
  })
  .strict();
export type TeamHireWorkerInput = z.infer<typeof teamHireWorkerInputSchema>;

export const teamSendMessageInputSchema = z
  .object({
    taskId: idSchema,
    targetAgentId: idSchema,
    content: z.string().min(1).max(20_000),
  })
  .strict();
export type TeamSendMessageInput = z.infer<typeof teamSendMessageInputSchema>;

export const teamWorkerRefSchema = z.object({ taskId: idSchema, agentId: idSchema }).strict();
export type TeamWorkerRef = z.infer<typeof teamWorkerRefSchema>;

export const teamEventSchema = z
  .object({
    type: z.literal('updated'),
    seq: z.number().int().min(1),
    detail: teamDetailSchema,
  })
  .strict();
export type TeamEvent = z.infer<typeof teamEventSchema>;

// Canvas view persistence (Slice 6.1, FR-CAN-02): per-Task camera + Worker node layout, saved with
// an optimistic-concurrency revision. Bounds mirror useCamera.ts's MIN_SCALE/MAX_SCALE and a
// generous world-coordinate range — wide enough for any reachable pan/drag, narrow enough to
// reject garbage.
const canvasWorldCoordinateSchema = z.number().finite().min(-20_000).max(20_000);
export const canvasCameraSchema = z
  .object({
    x: canvasWorldCoordinateSchema,
    y: canvasWorldCoordinateSchema,
    scale: z.number().finite().min(0.18).max(1.6),
  })
  .strict();
export type CanvasCamera = z.infer<typeof canvasCameraSchema>;

export const canvasNodePositionSchema = z
  .object({ x: canvasWorldCoordinateSchema, y: canvasWorldCoordinateSchema })
  .strict();
export type CanvasNodePosition = z.infer<typeof canvasNodePositionSchema>;

// Domain max is leader + 3 workers, but headroom is left for future node kinds.
export const CANVAS_NODE_POSITIONS_MAX_ENTRIES = 32;
export const canvasNodePositionsSchema = z
  .record(idSchema, canvasNodePositionSchema)
  .refine((record) => Object.keys(record).length <= CANVAS_NODE_POSITIONS_MAX_ENTRIES, {
    message: `nodePositions cannot have more than ${CANVAS_NODE_POSITIONS_MAX_ENTRIES} entries`,
  });

export const canvasViewSchema = z
  .object({
    taskId: idSchema,
    camera: canvasCameraSchema,
    nodePositions: canvasNodePositionsSchema,
    revision: z.number().int().nonnegative(),
    updatedAt: timestampSchema,
  })
  .strict();
export type CanvasView = z.infer<typeof canvasViewSchema>;

export const canvasViewSaveInputSchema = z
  .object({
    taskId: idSchema,
    camera: canvasCameraSchema,
    nodePositions: canvasNodePositionsSchema,
    // Expected current revision (optimistic concurrency): 0 means "no saved view yet".
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type CanvasViewSaveInput = z.infer<typeof canvasViewSaveInputSchema>;

export const canvasViewSaveResultSchema = z
  .object({ revision: z.number().int().nonnegative() })
  .strict();
export type CanvasViewSaveResult = z.infer<typeof canvasViewSaveResultSchema>;

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
          source: z.enum(['system', 'history', 'goal', 'compaction', 'background']),
          tokens: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
export type ContextUsage = z.infer<typeof contextUsageSchema>;

/**
 * An image the Runtime generated during a Turn, after Main has taken custody of it (issue #11).
 *
 * `id` is the content digest, so the same image generated twice is stored once. Bytes are NOT in
 * this record: they are fetched separately through `images.read`, which keeps a Turn snapshot from
 * carrying megabytes of base64 through every re-subscribe.
 */
export const generatedImageSchema = z
  .object({
    id: digestSchema,
    taskId: idSchema,
    turnId: idSchema,
    /** Always image/png today — the only format Codex's built-in generator emits, verified by magic
     * bytes before the file is accepted rather than trusted from its extension. */
    mimeType: z.literal('image/png'),
    byteLength: z.number().int().positive(),
    createdAt: timestampSchema,
  })
  .strict();
export type GeneratedImage = z.infer<typeof generatedImageSchema>;

/**
 * How much of the filesystem this Turn's Runtime may write (issue #37).
 *
 * Derived in Main from the Task's Access preset AND whether a Workspace is selected — never from
 * the preset alone. With no Workspace the Runtime's cwd is a throwaway temp directory, so a write
 * capability there would let a Turn produce edits the user can never see or keep; that case is
 * always `read-only` regardless of preset.
 *
 * The three values are not equally trustworthy, and the difference is the one §Managed Runtime
 * draws:
 *   - `workspace-write` on Codex is an OS boundary — `--sandbox workspace-write` is enforced by
 *     Seatbelt on macOS, outside the model's reach.
 *   - the same value on Claude is only a tool allowlist the CLI applies to itself. The design doc
 *     is explicit that "単なるtool非公開はsecurity boundaryに数えない", so a write-capable Claude
 *     Turn is surfaced as `trusted-unmanaged` in the UI rather than presented as sandboxed.
 * `full` drops even the CLI-side boundary and is never the default.
 */
export const runtimeWriteScopeSchema = z.enum(['read-only', 'workspace-write', 'full']);
export type RuntimeWriteScope = z.infer<typeof runtimeWriteScopeSchema>;

/**
 * One file a Runtime created, modified, or deleted during a Turn (issue #37).
 *
 * `path` is workspace-relative and is the CLI's own structured report — Codex's
 * `item.type: "file_change"` and Claude's `tool_use` input — never a path parsed out of model
 * prose. Same rule as generated images (issue #11): prose is attacker-influenceable, structured
 * events are not.
 */
export const fileChangeSchema = z
  .object({
    /** Relative to the Workspace root. Absolute paths and anything escaping the root are dropped in
     * Main rather than shown, so this can be rendered as plain text without further checking. */
    path: z.string().min(1).max(1024),
    kind: z.enum(['add', 'update', 'delete']),
  })
  .strict();
export type FileChange = z.infer<typeof fileChangeSchema>;

/** One Turn's worth of edits as stored, replayed by `files.list` when a Task is reopened (issue
 * #37). `seq` is the originating event's sequence number, which is what makes a replay
 * distinguishable from a second edit. */
export const fileChangeRecordSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    turnId: idSchema,
    changes: z.array(fileChangeSchema).min(1),
  })
  .strict();
export type FileChangeRecord = z.infer<typeof fileChangeRecordSchema>;

/**
 * The body of a file as a Runtime writes it (issue #39).
 *
 * NOT a TurnEvent, for the same reason `reasoningBatchSchema` is not: this arrives at the model's
 * typing speed, and every TurnEvent is appended to `turn_events` and replayed on re-subscribe.
 * Persisting it would spend the NFR-PERF-04 budget on frames nobody will ever read twice — the
 * durable record of an edit is `files.changed`, which says what changed, and the file on disk,
 * which is the result.
 *
 * `text` is the whole body decoded so far rather than a delta: the producer already holds the
 * accumulated buffer, so sending the total costs nothing extra and makes a dropped frame a repaint
 * instead of a corrupted view. Already secret-redacted by Main.
 */
export const fileEditFrameSchema = z
  .object({
    taskId: idSchema,
    turnId: idSchema,
    /** Workspace-relative. Main drops anything resolving outside the Workspace root. */
    path: z.string().min(1).max(1024),
    text: z.string().max(262_144),
    /** True once the Runtime finished writing this file — the view stops following. */
    complete: z.boolean(),
    /**
     * Where this body came from, because the two are honestly different things and the UI says so.
     *
     * `stream` is the model's own text as it types — only Claude produces it, via `input_json_delta`
     * on the tool call. `disk` is the file's current contents, re-read when a watcher sees it
     * change; that is the only option for Codex, which reports no body at all while writing and
     * applies patches through a temp-file rename (verified on 0.144.4). Disk updates are prompt but
     * arrive in whole-file jumps rather than character by character, so calling them "live typing"
     * would misdescribe the tool.
     */
    source: z.enum(['stream', 'disk']),
    /**
     * The file as this Turn found it, for a before/after diff (issue #41).
     *
     * Null is a normal outcome, not a failure: the Turn may have learned about the path only after
     * it changed (a watcher never sees a file before it is written), the Workspace may not be a git
     * repository, or the file may have had uncommitted work in it when the Turn started — in which
     * case HEAD would attribute the user's own edits to the model. The UI shows the full text and
     * says why rather than inventing a comparison.
     *
     * Arrives on a later frame than the text often does, because establishing it can require a git
     * call. Frames are cumulative, so the view simply gains its diff when this lands.
     */
    baseline: z.string().max(262_144).nullable(),
  })
  .strict();
export type FileEditFrame = z.infer<typeof fileEditFrameSchema>;

/**
 * A file opened for editing by the user (issue #43).
 *
 * Separate from `fileEditFrameSchema` on purpose. That one carries a *tail* — capped at 262KB
 * because it exists to be watched, not kept — and saving an edited tail back would overwrite the
 * file with its own last 262KB, silently truncating the front. So editing needs its own read that
 * either returns the whole file or refuses.
 *
 * `digest` is what makes a save safe: the renderer sends it back, and Main writes only if the file on
 * disk still hashes to it. That catches the Runtime rewriting the same file mid-edit and any other
 * process touching it.
 */
export const fileOpenResultSchema = z
  .object({
    path: z.string().min(1).max(1024),
    /** The complete file, present only when `editable` is true. */
    text: z.string().max(2_097_152),
    /** sha256 of the bytes on disk at the moment of reading. */
    digest: digestSchema,
    editable: z.boolean(),
    /** Why not, when `editable` is false. Shown to the user rather than a generic failure. */
    reason: z.enum(['too_large', 'binary', 'not_a_file', 'outside_workspace']).nullable(),
  })
  .strict();
export type FileOpenResult = z.infer<typeof fileOpenResultSchema>;

export const fileSaveInputSchema = z
  .object({
    taskId: idSchema,
    path: z.string().min(1).max(1024),
    text: z.string().max(2_097_152),
    /** The digest the editor started from. A mismatch means someone else wrote the file since. */
    baseDigest: digestSchema,
  })
  .strict();

/**
 * `conflict` is not an error, it is the mechanism: the file changed under the editor, so the write
 * did not happen and the user gets to decide. `refused` covers everything the app will not do at
 * all — outside the Workspace, a symlink, not a regular file, too large.
 */
export const fileSaveResultSchema = z
  .object({
    outcome: z.enum(['saved', 'conflict', 'refused']),
    /** The file's digest after a successful save, so the editor can keep editing without re-opening. */
    digest: digestSchema.nullable(),
    reason: z
      .enum(['too_large', 'binary', 'not_a_file', 'outside_workspace', 'io_error'])
      .nullable(),
  })
  .strict();
export type FileSaveResult = z.infer<typeof fileSaveResultSchema>;
export const generatedImageBytesSchema = z
  .object({
    id: digestSchema,
    mimeType: z.literal('image/png'),
    /** base64 of the stored bytes. The renderer turns this into a `data:` URL — never a path or an
     * http(s) URL, so displaying an image can neither read the filesystem nor make a request. */
    base64: z.string().max(24_000_000),
  })
  .strict();
export const generatedImageRefSchema = z.object({ imageId: digestSchema }).strict();

export const turnDiffEntrySchema = z
  .object({
    ordinal: z.number().int().positive(),
    kind: z.enum(['add', 'update', 'delete', 'rename']),
    path: z.string().min(1).max(4_096),
    destination: z.string().min(1).max(4_096).nullable(),
    preHash: digestSchema.nullable(),
    postHash: digestSchema.nullable(),
    provenance: z.literal('agent_edit'),
    status: z.enum(['applied', 'external_drift']),
    actualHash: digestSchema.nullable(),
  })
  .strict();
export type TurnDiffEntry = z.infer<typeof turnDiffEntrySchema>;

export const turnDiffSchema = z
  .object({
    turnId: idSchema,
    entries: z.array(turnDiffEntrySchema),
  })
  .strict();
export type TurnDiff = z.infer<typeof turnDiffSchema>;

export const approvalDecisionSchema = z.enum(['allow_once', 'allow_task', 'deny']);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export const approvalStateSchema = z.enum(['pending', 'resolved', 'canceled', 'stale', 'expired']);
export type ApprovalState = z.infer<typeof approvalStateSchema>;
export const approvalSummarySchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    turnId: idSchema,
    callId: idSchema,
    state: approvalStateSchema,
    decision: approvalDecisionSchema.nullable(),
    revision: z.number().int().nonnegative(),
    policyEpoch: z.number().int().nonnegative(),
    toolName: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    reason: z.string().min(1).max(500),
    target: z.string().min(1).max(500),
    impact: z.string().min(1).max(500),
    execution: z.string().min(1).max(100_000),
    risk: toolRiskSchema,
    capability: toolCapabilitySchema,
    challenge: z.string().min(8).max(256),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    decidedAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine((approval, context) => {
    if (approval.state === 'resolved') {
      if (approval.decision === null)
        context.addIssue({ code: 'custom', message: 'Resolved approval requires a decision' });
      if (approval.decidedAt === undefined)
        context.addIssue({ code: 'custom', message: 'Resolved approval requires decidedAt' });
    } else {
      if (approval.decision !== null)
        context.addIssue({ code: 'custom', message: 'Only resolved approvals have a decision' });
      if (approval.state === 'pending' && approval.decidedAt !== undefined)
        context.addIssue({ code: 'custom', message: 'Pending approval cannot have decidedAt' });
    }
  });
export type ApprovalSummary = z.infer<typeof approvalSummarySchema>;

export const autoPermissionDecisionSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    turnId: idSchema,
    callId: idSchema,
    reviewRequestId: idSchema,
    capability: toolCapabilitySchema,
    source: z.enum(['policy', 'narrow_allow', 'reviewer']),
    decision: z.enum(['allow', 'allow_once', 'deny']),
    outcome: z.string().min(1).max(100),
    reason: z.string().min(1).max(500),
    risk: toolRiskSchema,
    model: z.string().min(1).max(200),
    templateVersion: z.string().min(1).max(100),
    requestFingerprint: digestSchema,
    executionSpecDigest: digestSchema,
    inputDigest: digestSchema,
    policyEpoch: z.number().int().nonnegative(),
    createdAt: timestampSchema,
  })
  .strict();
export type AutoPermissionDecision = z.infer<typeof autoPermissionDecisionSchema>;

export const approvalResolveInputSchema = z
  .object({
    taskId: idSchema,
    approvalId: idSchema,
    decision: approvalDecisionSchema,
    expectedRevision: z.number().int().nonnegative(),
    expectedPolicyEpoch: z.number().int().nonnegative(),
    challenge: z.string().min(8).max(256),
  })
  .strict();
export type ApprovalResolveInput = z.infer<typeof approvalResolveInputSchema>;

export const commandStateSchema = z.enum([
  'prepared',
  'starting',
  'running',
  'exited',
  'canceled',
  'failed',
  'interrupted',
]);
export type CommandState = z.infer<typeof commandStateSchema>;
export const commandSummarySchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    turnId: idSchema,
    callId: idSchema,
    specDigest: digestSchema,
    executable: z.string().min(1).max(32_768),
    argv: z.array(z.string().max(1_000_000)).max(4_096),
    cwd: z.string().min(1).max(32_768),
    envDelta: z.record(z.string(), z.string().max(1_000_000)),
    purpose: z.string().min(1).max(500),
    risk: toolRiskSchema,
    state: commandStateSchema,
    pid: z.number().int().positive().nullable(),
    exitCode: z.number().int().nullable(),
    signal: z.string().max(64).nullable(),
    outputBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    createdAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    finishedAt: timestampSchema.nullable(),
  })
  .strict();
export type CommandSummary = z.infer<typeof commandSummarySchema>;

export const commandOutputRecordSchema = z
  .object({
    seq: z.number().int().positive(),
    stream: z.enum(['stdout', 'stderr']),
    text: z.string().max(65_536),
    byteLength: z.number().int().nonnegative().max(65_536),
  })
  .strict();
export type CommandOutputRecord = z.infer<typeof commandOutputRecordSchema>;

export const commandOutputPageInputSchema = z
  .object({
    taskId: idSchema,
    commandId: idSchema,
    afterSeq: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(500).default(200),
    maxBytes: z.number().int().min(65_536).max(1_048_576).default(262_144),
  })
  .strict();
export type CommandOutputPageInput = z.infer<typeof commandOutputPageInputSchema>;

export const commandOutputTailInputSchema = z
  .object({
    taskId: idSchema,
    commandId: idSchema,
    maxBytes: z.number().int().min(65_536).max(262_144).default(131_072),
  })
  .strict();
export type CommandOutputTailInput = z.infer<typeof commandOutputTailInputSchema>;

export const commandOutputPageSchema = z
  .object({
    commandId: idSchema,
    items: z.array(commandOutputRecordSchema).max(500),
    nextAfterSeq: z.number().int().nonnegative(),
    eof: z.boolean(),
    pageBytes: z.number().int().nonnegative().max(1_048_576),
  })
  .strict();
export type CommandOutputPage = z.infer<typeof commandOutputPageSchema>;

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
      type: z.literal('approval.requested'),
      ...turnEventBase,
      approvalId: idSchema,
      approval: approvalSummarySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('approval.resolved'),
      ...turnEventBase,
      approvalId: idSchema,
      decision: approvalDecisionSchema,
      approval: approvalSummarySchema,
    })
    .strict(),
  ...(['canceled', 'stale', 'expired'] as const).map((state) =>
    z
      .object({
        type: z.literal(`approval.${state}`),
        ...turnEventBase,
        approvalId: idSchema,
        approval: approvalSummarySchema,
      })
      .strict(),
  ),
  z
    .object({
      type: z.literal('command.started'),
      ...turnEventBase,
      command: commandSummarySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('command.output'),
      ...turnEventBase,
      commandId: idSchema,
      outputSeq: z.number().int().positive(),
      stream: z.enum(['stdout', 'stderr']),
      text: z.string().max(65_536),
      byteLength: z.number().int().nonnegative().max(65_536),
    })
    .strict(),
  z
    .object({
      type: z.literal('command.completed'),
      ...turnEventBase,
      command: commandSummarySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('permission.auto_decided'),
      ...turnEventBase,
      autoDecision: autoPermissionDecisionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('delivery.acknowledged'),
      ...turnEventBase,
      deliveryId: digestSchema,
      completionId: idSchema,
      fragmentId: idSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('turn.completed'),
      ...turnEventBase,
      state: z.enum(['completed', 'canceled', 'failed', 'interrupted']),
      message: chatMessageSchema.optional(),
      diff: z.array(turnDiffEntrySchema),
      // Additive, optional: the concrete model id the Claude CLI actually resolved for this turn
      // (from the stream-json `system/init` event's `model` field, captured by
      // ClaudeJsonlNormalizer and threaded through the canonical protocol's `completed` event —
      // see runtime-host/protocol.ts). Absent for Codex/mock turns and whenever the Claude CLI's
      // init event didn't carry a model string. Not persisted to the turns table — this is a
      // live, in-memory-only surface (IpcRouter.finishAndAdvance) for the Composer's model chip
      // tooltip, not a historical record.
      resolvedModel: z.string().min(1).max(128).optional(),
    })
    .strict(),
  // The user saved their own edit to a Workspace file (issue #43).
  //
  // Task-level, with no turnId, and deliberately NOT folded into `files.changed`. That event is the
  // record of what a Runtime did; putting a human's edit in it would make the timeline claim the
  // model wrote something it did not. Persisted, because "you changed this file from here" is a
  // durable fact about the Task and the audit trail should survive a restart.
  z
    .object({
      type: z.literal('file.saved'),
      taskId: idSchema,
      seq: z.number().int().positive(),
      path: z.string().min(1).max(1024),
      byteLength: z.number().int().nonnegative(),
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
  // Files the Runtime changed (issue #37). Persisted like image.generated and for the same reason:
  // "this Turn edited these files" is a fact about the conversation's history, and reopening a Task
  // has to show it again. One event per tool call, so the order in the timeline is the order the
  // edits actually happened in.
  z
    .object({
      type: z.literal('files.changed'),
      ...turnEventBase,
      changes: z.array(fileChangeSchema).min(1).max(200),
    })
    .strict(),
  // A generated image took custody (issue #11). Persisted and replayed like any other Turn event:
  // unlike a transient status, "this Turn produced this image" IS a fact about the conversation's
  // history, and the timeline has to show it again when the Task is reopened. Carries only the
  // metadata record — bytes are fetched on demand via `images.read`.
  z
    .object({
      type: z.literal('image.generated'),
      ...turnEventBase,
      image: generatedImageSchema,
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
        stage: z.union([turnStageSchema, z.literal('waiting_approval')]),
        startedAtEpochMs: z.number().int().nonnegative(),
        streamedText: z.string(),
        messageId: idSchema.nullable(),
      })
      .strict()
      .nullable(),
    queued: z.array(queuedInputSchema),
    contextUsage: contextUsageSchema,
    pendingApprovals: z.array(approvalSummarySchema).default([]),
    latestTurnDiff: turnDiffSchema.nullable().default(null),
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
  'TASK_RECOVERY_REQUIRED',
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

export const runtimeKindSchema = z.enum(['mock', 'codex', 'claude']);
export type RuntimeKind = z.infer<typeof runtimeKindSchema>;
export const providerRuntimeKindSchema = z.enum([
  'builtin_cli',
  'official_api',
  'openai_compatible',
  'mock',
]);
export type ProviderRuntimeKind = z.infer<typeof providerRuntimeKindSchema>;
export const providerVerificationStatusSchema = z.enum([
  'not_required',
  'unverified',
  'verified',
  'verification_expired',
  'invalid_credentials',
  'unavailable',
]);
export type ProviderVerificationStatus = z.infer<typeof providerVerificationStatusSchema>;
export const providerConnectionVerificationSchema = z
  .object({
    status: providerVerificationStatusSchema,
    verifiedAt: timestampSchema.nullable(),
    expiresAt: timestampSchema.nullable(),
    message: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type ProviderConnectionVerification = z.infer<typeof providerConnectionVerificationSchema>;
export const providerRateLimitModeSchema = z.enum(['bypass', 'auto', 'manual']);
export type ProviderRateLimitMode = z.infer<typeof providerRateLimitModeSchema>;
export const providerConnectionRateLimitSchema = z
  .object({
    mode: providerRateLimitModeSchema,
    maxConcurrentRequests: z.number().int().positive().nullable(),
    requestsPerMinute: z.number().int().positive().nullable(),
    tokensPerMinute: z.number().int().positive().nullable(),
    lastObservedRateLimitHeaders: z.record(z.string(), z.string().max(256)).nullable(),
  })
  .strict();
export type ProviderConnectionRateLimit = z.infer<typeof providerConnectionRateLimitSchema>;
export const providerConnectionSchema = z
  .object({
    id: connectionIdSchema,
    providerId: providerIdSchema,
    runtimeKind: providerRuntimeKindSchema,
    displayName: z.string().min(1).max(100),
    enabled: z.boolean(),
    secretReference: z
      .string()
      .regex(
        /^provider-secret:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
      .nullable(),
    verification: providerConnectionVerificationSchema,
    rateLimit: providerConnectionRateLimitSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;
export const openAIConnectionCreateInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    apiKey: z.string().min(1).max(16_384),
    organizationId: z.string().trim().min(1).max(128).optional(),
    projectId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
export type OpenAIConnectionCreateInput = z.infer<typeof openAIConnectionCreateInputSchema>;
export const openRouterConnectionCreateInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    apiKey: z.string().min(1).max(16_384),
  })
  .strict();
export type OpenRouterConnectionCreateInput = z.infer<typeof openRouterConnectionCreateInputSchema>;
export const anthropicConnectionCreateInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    apiKey: z.string().min(1).max(16_384),
  })
  .strict();
export type AnthropicConnectionCreateInput = z.infer<typeof anthropicConnectionCreateInputSchema>;
export const geminiConnectionCreateInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    apiKey: z.string().min(1).max(16_384),
  })
  .strict();
export type GeminiConnectionCreateInput = z.infer<
  typeof geminiConnectionCreateInputSchema
>;
export const xAIConnectionCreateInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    apiKey: z.string().min(1).max(16_384),
  })
  .strict();
export type XAIConnectionCreateInput = z.infer<
  typeof xAIConnectionCreateInputSchema
>;
export const providerProfileProtocolSchema = z.enum(['chat_completions', 'responses']);
export type ProviderProfileProtocol = z.infer<typeof providerProfileProtocolSchema>;
export const providerProfileErrorOverrideSchema = z
  .object({
    status: z.number().int().min(400).max(599),
    category: z.enum([
      'credentials',
      'not_found',
      'rate_limited',
      'timeout',
      'network',
      'canceled',
      'invalid_request',
      'provider_unavailable',
      'internal',
    ]),
    retryable: z.boolean(),
  })
  .strict();
export const providerProfileSchema = z
  .object({
    id: providerIdSchema,
    displayName: z.string().min(1).max(100),
    baseUrl: z.string().url().max(2_048),
    baseUrlConfigurable: z.boolean(),
    protocol: providerProfileProtocolSchema,
    modelsPath: z.string().startsWith('/').max(256),
    authentication: z
      .object({
        headerName: z.string().min(1).max(128),
        scheme: z.string().max(64),
      })
      .strict(),
    requiredCredentialFields: z.array(z.enum(['account_id'])).max(8),
    errorOverrides: z.array(providerProfileErrorOverrideSchema).max(32),
    sourceReference: z.string().url().max(2_048),
    reviewedAt: timestampSchema,
  })
  .strict();
export type ProviderProfile = z.infer<typeof providerProfileSchema>;
export const capabilitySourceSchema = z.enum(['provider_api', 'official_curated', 'unknown']);
export type CapabilitySource = z.infer<typeof capabilitySourceSchema>;
export type CatalogValue<T> = Readonly<{
  value: T | null;
  source: CapabilitySource;
  sourceReference?: string;
  observedAt?: string;
}>;
export function catalogValueSchema<T extends z.ZodType>(
  valueSchema: T,
): z.ZodObject<{
  value: z.ZodNullable<T>;
  source: typeof capabilitySourceSchema;
  sourceReference: z.ZodOptional<z.ZodString>;
  observedAt: z.ZodOptional<typeof timestampSchema>;
}> {
  return z
    .object({
      value: valueSchema.nullable(),
      source: capabilitySourceSchema,
      sourceReference: z.string().min(1).max(2_048).optional(),
      observedAt: timestampSchema.optional(),
    })
    .strict();
}
export const providerModelSchema = z
  .object({
    connectionId: connectionIdSchema,
    providerId: providerIdSchema,
    modelId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256),
    available: z.boolean(),
    availabilityCheckedAt: timestampSchema,
    contextWindow: catalogValueSchema(z.number().int().positive()),
    maxOutputTokens: catalogValueSchema(z.number().int().positive()),
    toolCalling: catalogValueSchema(z.boolean()),
    structuredOutput: catalogValueSchema(z.boolean()),
    multimodalInput: catalogValueSchema(z.boolean()),
    reasoning: catalogValueSchema(z.boolean()),
    gateway: z
      .object({
        providerId: providerIdSchema,
        upstreamProvider: catalogValueSchema(z.string().min(1).max(128)),
      })
      .strict()
      .optional(),
    pricing: z
      .object({
        promptPerToken: catalogValueSchema(z.string().min(1).max(64)),
        completionPerToken: catalogValueSchema(z.string().min(1).max(64)),
        currency: z.literal('USD'),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ProviderModel = z.infer<typeof providerModelSchema>;
export const normalizedProviderUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    cacheReadTokens: z.number().int().nonnegative().nullable(),
    cacheWriteTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
    providerCost: z
      .object({
        amount: z.number().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict()
      .nullable(),
    source: z.enum(['provider_api', 'runtime_observed', 'unknown']),
  })
  .strict();
export type NormalizedProviderUsage = z.infer<typeof normalizedProviderUsageSchema>;
export const normalizedProviderErrorSchema = z
  .object({
    category: z.enum([
      'credentials',
      'not_found',
      'rate_limited',
      'timeout',
      'network',
      'canceled',
      'invalid_request',
      'provider_unavailable',
      'internal',
    ]),
    message: z.string().min(1).max(1_000),
    retryable: z.boolean(),
    retryAfterMs: z.number().int().nonnegative().nullable(),
    providerCode: z.string().min(1).max(128).nullable(),
  })
  .strict();
export type NormalizedProviderError = z.infer<typeof normalizedProviderErrorSchema>;
export const executionResolutionSchema = z
  .object({
    resolvedProvider: providerIdSchema.nullable(),
    resolvedModel: z.string().min(1).max(128).nullable(),
    gatewayProvider: providerIdSchema.nullable().optional(),
    upstreamProvider: z.string().min(1).max(128).nullable().optional(),
    routing: z.record(z.string(), z.json()).nullable().optional(),
  })
  .strict();
export type ExecutionResolution = z.infer<typeof executionResolutionSchema>;
export const canonicalProviderEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output_delta'), text: z.string() }).strict(),
  z.object({ type: z.literal('reasoning_delta'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('tool_call'),
      callId: z.string().min(1).max(256),
      name: z.string().min(1).max(256),
      input: z.json(),
    })
    .strict(),
  z.object({ type: z.literal('usage'), usage: normalizedProviderUsageSchema }).strict(),
  z.object({ type: z.literal('resolution'), resolution: executionResolutionSchema }).strict(),
  z
    .object({
      type: z.literal('rate_limit'),
      retryAfterMs: z.number().int().nonnegative().nullable(),
      observedAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('completed'),
      stopReason: z.string().min(1).max(256).nullable(),
    })
    .strict(),
  z.object({ type: z.literal('error'), error: normalizedProviderErrorSchema }).strict(),
]);
export type CanonicalProviderEvent = z.infer<typeof canonicalProviderEventSchema>;
export const providerToolSchema = z
  .object({
    name: z.string().min(1).max(256),
    description: z.string().min(1).max(2_000),
    inputSchema: z.json(),
  })
  .strict();
export type ProviderTool = z.infer<typeof providerToolSchema>;
export const providerStructuredOutputSchema = z
  .object({
    name: z.string().min(1).max(64),
    schema: z.json(),
    strict: z.boolean(),
  })
  .strict();
export type ProviderStructuredOutput = z.infer<typeof providerStructuredOutputSchema>;
export const providerInlineImageSchema = z
  .object({
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    base64: z
      .string()
      .min(1)
      .max(16 * 1024 * 1024)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export type ProviderInlineImage = z.infer<typeof providerInlineImageSchema>;
export const providerExecutionRequestSchema = z
  .object({
    executionId: z.string().min(1).max(256),
    connectionId: connectionIdSchema,
    modelId: z.string().min(1).max(256),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['system', 'user', 'assistant', 'tool']),
            content: z.string(),
            toolCallId: z.string().min(1).max(256).optional(),
            inlineImages: z.array(providerInlineImageSchema).max(8).optional(),
          })
          .strict()
          .superRefine((message, context) => {
            if (message.role === 'tool' && message.toolCallId === undefined)
              context.addIssue({
                code: 'custom',
                path: ['toolCallId'],
                message: 'Tool result messages require toolCallId',
              });
            if (message.role !== 'tool' && message.toolCallId !== undefined)
              context.addIssue({
                code: 'custom',
                path: ['toolCallId'],
                message: 'toolCallId is only valid for tool result messages',
              });
            if (
              message.role !== 'user' &&
              message.inlineImages !== undefined &&
              message.inlineImages.length > 0
            )
              context.addIssue({
                code: 'custom',
                path: ['inlineImages'],
                message: 'Inline images are only valid on user messages',
              });
          }),
      )
      .min(1),
    tools: z.array(providerToolSchema).max(128).optional(),
    structuredOutput: providerStructuredOutputSchema.optional(),
  })
  .strict();
export type ProviderExecutionRequest = z.infer<typeof providerExecutionRequestSchema>;
// Model id/option shape is provider-agnostic (Codex slugs and Claude aliases/full ids both fit
// this format) and is kept under its original "codex" name for additive, non-breaking evolution.
export const codexModelIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
/**
 * A reasoning effort level a specific model advertises as supported.
 *
 * Unlike Claude's fixed `claudeEffortSchema`, Codex's valid set is per-model and published by the
 * CLI itself — `~/.codex/models_cache.json` carries `supported_reasoning_levels` (each with the
 * CLI's own description text) and `default_reasoning_level` per model. So this is deliberately an
 * open string rather than an enum: the authority is that file, not this schema, and a new model
 * that advertises a level this build has never heard of must still be selectable.
 *
 * Getting it wrong is not cosmetic. Passing an unsupported level fails the whole turn — the API
 * answers 400 `invalid_request_error` and `codex exec` exits 1 — where Claude merely warns and
 * falls back to its default. Verified 2026-07-25 on codex-cli 0.144.4: `minimal` (advertised by no
 * model) returned "Unsupported value: 'minimal' is not supported with the
 * 'gpt-5.6-sol-1p-codexswic-ev3' model. Supported values are: 'none', 'low', 'medium', 'high', and
 * 'xhigh'." That is why the candidate list is derived per model instead of hardcoded.
 */
export const effortOptionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/),
    description: z.string().max(300),
  })
  .strict();
export type EffortOption = z.infer<typeof effortOptionSchema>;
export const codexModelOptionSchema = z
  .object({
    id: codexModelIdSchema,
    displayName: z.string().min(1).max(128),
    description: z.string().max(300),
    // Reasoning levels this model advertises, newest-CLI-first. Absent (rather than empty) means
    // "this provider does not publish a per-model set" — Claude's curated entries leave it off and
    // keep using `claudeEffortSchema`; Codex's `auto` sentinel leaves it off because the concrete
    // model it resolves to is chosen by the CLI, so nothing can be promised about its set.
    efforts: z.array(effortOptionSchema).max(16).optional(),
    // The model's own default level, used to clamp a persisted choice this model does not support
    // (switching from Sol to GPT-5.5 drops `max`/`ultra`, and keeping the old value would fail the
    // next turn outright).
    defaultEffort: effortOptionSchema.shape.id.optional(),
  })
  .strict();
export type CodexModelOption = z.infer<typeof codexModelOptionSchema>;
// Claude-only reasoning effort levels. Verified empirically against the installed CLI (2.1.218):
// `claude --help` lists "--effort <level>  Effort level for the current session (low, medium,
// high, xhigh, max)", and a probe with an invalid value (`--effort bogus`) prints "Unknown
// --effort value 'bogus' — ignoring it and using the default effort. Valid values: low, medium,
// high, xhigh, max."
//
// `ultracode` is a sixth accepted value that the help text's parenthetical omits (issue #8). The
// discriminator is that same warning: the CLI is explicit when it ignores an `--effort` value, so
// "accepted" and "silently dropped" are distinguishable without any observable effort field in
// the output. Re-probed 2026-07-25 on 2.1.218 with
//   claude -p "1" --effort <v> --output-format stream-json --verbose --tools '' \
//          --strict-mcp-config --safe-mode --no-session-persistence
// and reading stderr:
//   max        -> no warning, exit 0
//   ultracode  -> no warning, exit 0
//   ultra      -> "Unknown --effort value 'ultra' — ignoring it ..."
//   bogus      -> "Unknown --effort value 'bogus' — ignoring it ..."
//   bogus2     -> "Unknown --effort value 'bogus2' — ignoring it ..."
// i.e. `ultracode` behaves like a documented level and unlike three separate near-misses and
// nonsense values, so it is a recognised level rather than an unvalidated pass-through. The
// `system/init` event carries no effort field on this version, so the warning channel is the only
// available evidence — claude-smoke.test.ts guards it so a future CLI that drops the value fails
// loudly instead of silently degrading to the default.
//
// Codex has no equivalent flag on this CLI version, so — unlike `codexModelIdSchema`
// (deliberately provider-agnostic) — this schema is Claude-specific.
export const claudeEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
export type ClaudeEffort = z.infer<typeof claudeEffortSchema>;
export const runtimeSettingsSchema = z
  .object({
    kind: runtimeKindSchema,
    codexAvailable: z.boolean(),
    // Additive parallel availability field for the Claude CLI runtime (Slice 3.4). Existing
    // `codexAvailable` consumers are unaffected; `models`/`model` reflect the currently selected
    // Runtime kind's own capability list (Codex's or Claude's), per the Main-side probe.
    claudeAvailable: z.boolean(),
    model: codexModelIdSchema,
    models: z.array(codexModelOptionSchema).max(32),
    // Additive field for the Claude effort control. Persisted under the single
    // 'runtime.claude.effort' settings key regardless of which Runtime kind is currently active
    // (unlike `model`, which is scoped per-kind) — it only takes effect on Claude turns.
    effort: claudeEffortSchema,
    // Codex's own reasoning level, kept separate from `effort` because the two providers do not
    // share a value space: Claude's set is fixed and includes `ultracode`, Codex's is per-model
    // and includes `max`/`ultra` only on the models that advertise them. Persisted under
    // 'runtime.codex.effort' so switching Runtime does not clobber the other's preference.
    //
    // Already clamped by Main to the selected model's advertised set (see the settings read), so
    // the renderer can show it as-is. Empty string means "no override" — the `auto` model sentinel
    // resolves its model inside the CLI, so there is no advertised set to choose from and the
    // CLI's own per-model default is left to apply.
    codexEffort: z.union([effortOptionSchema.shape.id, z.literal('')]),
  })
  .strict();
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export const runtimeSettingsGetInputSchema = z.object({ taskId: idSchema.optional() }).strict();
export const runtimeSetInputSchema = z
  .object({ kind: runtimeKindSchema, taskId: idSchema.optional() })
  .strict();
export const runtimeModelSetInputSchema = z
  .object({ model: codexModelIdSchema, taskId: idSchema.optional() })
  .strict();
export const runtimeEffortSetInputSchema = z.object({ effort: claudeEffortSchema }).strict();
export const runtimeCodexEffortSetInputSchema = z
  .object({ effort: effortOptionSchema.shape.id })
  .strict();
export const modelCatalogCapabilitySchema = z.enum([
  'toolCalling',
  'structuredOutput',
  'multimodalInput',
  'reasoning',
]);
export type ModelCatalogCapability = z.infer<typeof modelCatalogCapabilitySchema>;
export const modelCatalogQueryInputSchema = z
  .object({
    taskId: idSchema,
    text: z.string().max(200).default(''),
    connectionIds: z.array(connectionIdSchema).max(32).default([]),
    providerIds: z.array(providerIdSchema).max(32).default([]),
    capabilities: z.array(modelCatalogCapabilitySchema).max(4).default([]),
    availableOnly: z.boolean().default(true),
    cursor: z
      .string()
      .regex(/^cursor:[0-9]+$/)
      .nullable()
      .default(null),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export type ModelCatalogQueryInput = z.infer<typeof modelCatalogQueryInputSchema>;
export const modelCatalogQueryResultSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    items: z.array(providerModelSchema).max(100),
    nextCursor: z
      .string()
      .regex(/^cursor:[0-9]+$/)
      .nullable(),
    selection: modelSelectionSchema,
    multiProviderModelPickerV2: z.boolean(),
  })
  .strict();
export type ModelCatalogQueryResult = z.infer<typeof modelCatalogQueryResultSchema>;
export const modelCatalogSelectionSetInputSchema = z
  .object({
    taskId: idSchema,
    selection: modelSelectionSchema,
  })
  .strict();

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
export const skillProviderSchema = z.enum(['claude', 'agents']);
export const skillIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const skillCandidateSummarySchema = z
  .object({
    provider: skillProviderSchema,
    skillId: skillIdSchema,
    valid: z.boolean(),
    problems: z.array(z.string().max(240)).max(16),
    imported: z.boolean(),
    enabled: z.boolean().nullable(),
    updateAvailable: z.boolean(),
  })
  .strict();
export const skillScanResultSchema = z
  .object({
    candidates: z.array(skillCandidateSummarySchema).max(512),
    claudeDetected: z.number().int().nonnegative().max(512),
    agentsDetected: z.number().int().nonnegative().max(512),
    importedCount: z.number().int().nonnegative().max(512),
    invalidCount: z.number().int().nonnegative().max(512),
    installed: z
      .array(
        z
          .object({
            provider: skillProviderSchema,
            skillId: skillIdSchema,
            name: z.string().min(1).max(200),
            enabled: z.boolean(),
            sourceAvailable: z.boolean(),
            updateAvailable: z.boolean(),
          })
          .strict(),
      )
      .max(512),
  })
  .strict();
export const skillCandidateInputSchema = z
  .object({ provider: skillProviderSchema, skillId: skillIdSchema })
  .strict();
export const skillPreviewResultSchema = z
  .object({
    previewId: z.string().uuid(),
    expiresAt: z.string().datetime(),
    provider: skillProviderSchema,
    skillId: skillIdSchema,
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2_000),
    files: z.array(z.string().min(1).max(1_024)).max(256),
    warnings: z.array(z.string().min(1).max(1_024)).max(256),
  })
  .strict();
export const skillImportInputSchema = z.object({ previewId: z.string().uuid() }).strict();
export const skillInstalledInputSchema = z
  .object({ provider: skillProviderSchema, skillId: skillIdSchema })
  .strict();
export const skillEnabledInputSchema = skillInstalledInputSchema
  .extend({ enabled: z.boolean() })
  .strict();
export const skillImportResultSchema = z
  .object({
    provider: skillProviderSchema,
    skillId: skillIdSchema,
    status: z.enum(['imported', 'already-imported']),
    name: z.string().min(1).max(200),
  })
  .strict();
export type SkillProvider = z.infer<typeof skillProviderSchema>;
export type SkillCandidateSummary = z.infer<typeof skillCandidateSummarySchema>;
export type SkillScanResult = z.infer<typeof skillScanResultSchema>;
export type SkillPreviewResult = z.infer<typeof skillPreviewResultSchema>;
export type SkillImportResult = z.infer<typeof skillImportResultSchema>;
export const taskCreateInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    localOnly: z.boolean().optional(),
  })
  .strict();
export const taskIdPayloadSchema = z.object({ taskId: idSchema }).strict();
/** A Workspace-relative path within a Task. Validated as a bounded string here; whether it is
 * actually inside the Workspace is Main's decision, not the schema's (issue #43). */
export const filePathPayloadSchema = z
  .object({ taskId: idSchema, path: z.string().min(1).max(1024) })
  .strict();
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
/**
 * A batch of the model's reasoning text for the active Turn (issue #17).
 *
 * NOT a TurnEvent, deliberately. Every TurnEvent is appended to `turn_events` and replayed on
 * re-subscribe; reasoning is high-frequency, and it is also unvetted intermediate text that may
 * carry guesses and content pulled in from elsewhere. Not persisting it was the product decision, so
 * this rides a transient push channel — no migration, no `turn_events` growth, and nothing on disk.
 * The cost is that reopening a Task shows no earlier reasoning, which the UI states rather than
 * silently showing an empty panel.
 *
 * Already secret-redacted and batched by Main before it is sent.
 */
export const reasoningBatchSchema = z
  .object({
    taskId: idSchema,
    turnId: idSchema,
    text: z.string().max(16_384),
    /** True once the per-turn budget was exceeded — a truncated trail must not read as the whole
     * thought process. */
    truncated: z.boolean(),
  })
  .strict();
export type ReasoningBatch = z.infer<typeof reasoningBatchSchema>;

/**
 * What the startup database probe did, so the SurfaceFooter can say so (issue #9).
 *
 * The persistence layer has always produced this — `recoverDatabaseIfCorrupt` moves a corrupt file
 * aside and restores the pre-migration backup, and `interruptActiveTurns` finalises turns that were
 * mid-flight when the app died — but nothing ever reached the renderer, so a user whose database was
 * restored or whose in-flight Turn was reaped had no way to know.
 *
 * Carried on `app.getInfo()` rather than as an event: it is a fact about this launch, established
 * before the window exists, and read once.
 */
export const databaseRecoverySchema = z
  .object({
    corruptionDetected: z.boolean(),
    restoredFromBackup: z.boolean(),
    freshStart: z.boolean(),
    /** Turns finalised as `interrupted` because the app exited while they were running. */
    interruptedTurns: z.number().int().nonnegative(),
  })
  .strict();
export type DatabaseRecovery = z.infer<typeof databaseRecoverySchema>;

export const appInfoSchema = z
  .object({ version: z.string(), platform: z.string(), recovery: databaseRecoverySchema })
  .strict();

/**
 * Liveness of the Runtime process, for the SurfaceFooter's connection indicator (issue #9).
 *
 * Deliberately NOT a TurnEvent. Every TurnEvent is appended to `turn_events` and replayed on
 * re-subscribe, and "the CLI died" is a transient property of the current process, not a fact about
 * the conversation's history — replaying it would resurrect a stale failure every time a Task is
 * reopened. Pushed on its own non-persisted channel instead.
 *
 * `failed` carries the reason, which `handleRuntimeFailure` previously discarded: the renderer could
 * see a Turn end in `failed` but never why, so it could not distinguish "the model refused" from
 * "the CLI is gone".
 */
export const runtimeConnectionStateSchema = z.enum(['idle', 'running', 'failed']);
export type RuntimeConnectionState = z.infer<typeof runtimeConnectionStateSchema>;
export const runtimeStatusSchema = z
  .object({
    kind: runtimeKindSchema,
    state: runtimeConnectionStateSchema,
    taskId: idSchema.nullable(),
    errorCode: z.string().max(64).nullable(),
    userMessage: z.string().max(500).nullable(),
  })
  .strict();
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;
export const turnStartResultSchema = z
  .object({
    turnId: idSchema,
    /**
     * The Task's updated summary, present only when this message triggered automatic naming
     * (issue #4) — a Task still carrying the placeholder title gets named from its first message.
     *
     * Returned on the start result rather than as a TurnEvent on purpose: every TurnEvent is
     * appended to `turn_events` and replayed on re-subscribe, and a rename is a Task-level fact
     * with no place in a Turn's event history. Callers that ignore it simply keep showing the old
     * title until their next `tasks.list()`.
     */
    renamedTask: taskSummarySchema.optional(),
  })
  .strict();
export const voidResultSchema = z.undefined();

export interface SprintCoderApi {
  app: { getInfo(): Promise<{ version: string; platform: string }> };
  tasks: {
    list(): Promise<TaskSummary[]>;
    create(input?: { title?: string; localOnly?: boolean }): Promise<TaskSummary>;
    messages(taskId: string): Promise<ChatMessage[]>;
    rename(taskId: string, title: string): Promise<TaskSummary>;
    setPinned(taskId: string, pinned: boolean): Promise<TaskSummary>;
    setArchived(taskId: string, archived: boolean): Promise<TaskSummary>;
    setGoal(taskId: string, goal: string): Promise<TaskSummary>;
    getDraft(taskId: string): Promise<string>;
    setDraft(taskId: string, draft: string): Promise<void>;
  };
  teams: {
    promote(taskId: string): Promise<TeamSummary>;
    get(taskId: string): Promise<TeamDetail | null>;
    updatePolicy(input: TeamPolicyUpdateInput): Promise<TeamDetail>;
    hireWorker(input: TeamHireWorkerInput): Promise<WorkerSummary>;
    sendToWorker(input: TeamSendMessageInput): Promise<TeamMessageSummary>;
    stopWorker(input: TeamWorkerRef): Promise<WorkerSummary>;
    stopAll(taskId: string): Promise<TeamDetail>;
    subscribe(taskId: string, listener: (event: TeamEvent) => void): () => void;
    getCanvasView(taskId: string): Promise<CanvasView | null>;
    saveCanvasView(input: CanvasViewSaveInput): Promise<CanvasViewSaveResult>;
  };
  workspace: {
    get(taskId: string): Promise<WorkspaceSelection>;
    select(taskId: string): Promise<WorkspaceSelection>;
  };
  reasoning: {
    /** Subscribes to the active Turn's reasoning stream. Returns an unsubscribe function. */
    subscribe(listener: (batch: ReasoningBatch) => void): () => void;
  };
  fileEdits: {
    /** Subscribes to file bodies as Runtimes write them. Returns an unsubscribe function. */
    subscribe(listener: (frame: FileEditFrame) => void): () => void;
  };
  runtime: {
    /** Subscribes to Runtime process liveness. Returns an unsubscribe function. */
    subscribeStatus(listener: (status: RuntimeStatus) => void): () => void;
  };
  files: {
    /** Every edit recorded for this Task, oldest first. Read on select rather than replayed through
     * the event port, which only carries events newer than the snapshot's lastSeq. */
    list(taskId: string): Promise<FileChangeRecord[]>;
    /** Reads a file in full so it can be edited, or refuses with a reason. */
    open(taskId: string, path: string): Promise<FileOpenResult>;
    /** Writes the user's own edit. Refuses rather than overwriting when the file changed underneath. */
    save(input: {
      taskId: string;
      path: string;
      text: string;
      baseDigest: string;
    }): Promise<FileSaveResult>;
  };
  images: {
    list(taskId: string): Promise<GeneratedImage[]>;
    /** Bytes as base64, for a `data:` URL. Rejects an unknown id. */
    read(imageId: string): Promise<{ id: string; mimeType: 'image/png'; base64: string }>;
  };
  settings: {
    getRuntime(taskId?: string): Promise<RuntimeSettings>;
    setRuntime(kind: RuntimeKind, taskId?: string): Promise<void>;
    setModel(model: string, taskId?: string): Promise<void>;
    setEffort(effort: ClaudeEffort): Promise<void>;
    /** Codex reasoning level. Rejects a level the selected model does not advertise (see
     * `effortOptionSchema`) — Codex fails the whole turn on an unsupported one. */
    setCodexEffort(effort: string): Promise<void>;
    scanSkills(): Promise<SkillScanResult>;
    previewSkill(provider: SkillProvider, skillId: string): Promise<SkillPreviewResult>;
    importSkill(previewId: string): Promise<SkillImportResult>;
    updateSkill(previewId: string): Promise<SkillImportResult>;
    setSkillEnabled(provider: SkillProvider, skillId: string, enabled: boolean): Promise<void>;
    removeSkill(provider: SkillProvider, skillId: string): Promise<void>;
  };
  models: {
    query(input: ModelCatalogQueryInput): Promise<ModelCatalogQueryResult>;
    setSelection(taskId: string, selection: ModelSelection): Promise<ModelSelection>;
  };
  providers: {
    listConnections(): Promise<ProviderConnection[]>;
    createOpenAIConnection(input: OpenAIConnectionCreateInput): Promise<ProviderConnection>;
    createOpenRouterConnection(input: OpenRouterConnectionCreateInput): Promise<ProviderConnection>;
    createAnthropicConnection(input: AnthropicConnectionCreateInput): Promise<ProviderConnection>;
    createGeminiConnection(
      input: GeminiConnectionCreateInput,
    ): Promise<ProviderConnection>;
    createXAIConnection(input: XAIConnectionCreateInput): Promise<ProviderConnection>;
    verifyConnection(connectionId: string): Promise<ProviderConnection>;
  };
  permissions: {
    get(taskId: string): Promise<PermissionSettings>;
    listAutoDecisions(taskId: string): Promise<AutoPermissionDecision[]>;
    set(
      taskId: string,
      preset: AccessPreset,
      expectedPolicyEpoch: number,
    ): Promise<PermissionSettings>;
  };
  approvals: {
    listPending(taskId: string): Promise<ApprovalSummary[]>;
    listRecent(taskId: string): Promise<ApprovalSummary[]>;
    resolve(input: ApprovalResolveInput): Promise<ApprovalSummary>;
  };
  commands: {
    list(taskId: string): Promise<CommandSummary[]>;
    outputPage(input: CommandOutputPageInput): Promise<CommandOutputPage>;
    outputTail(input: CommandOutputTailInput): Promise<CommandOutputPage>;
  };
  turns: {
    start(input: {
      taskId: string;
      text: string;
    }): Promise<{ turnId: string; renamedTask?: TaskSummary | undefined }>;
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
  appGetInfo: 'sprint-coder:app:get-info',
  tasksList: 'sprint-coder:tasks:list',
  tasksCreate: 'sprint-coder:tasks:create',
  tasksMessages: 'sprint-coder:tasks:messages',
  tasksRename: 'sprint-coder:tasks:rename',
  tasksSetPinned: 'sprint-coder:tasks:set-pinned',
  tasksSetArchived: 'sprint-coder:tasks:set-archived',
  tasksSetGoal: 'sprint-coder:tasks:set-goal',
  tasksGetDraft: 'sprint-coder:tasks:get-draft',
  tasksSetDraft: 'sprint-coder:tasks:set-draft',
  teamsPromote: 'sprint-coder:teams:promote',
  teamsGet: 'sprint-coder:teams:get',
  teamsUpdatePolicy: 'sprint-coder:teams:update-policy',
  teamsHireWorker: 'sprint-coder:teams:hire-worker',
  teamsSend: 'sprint-coder:teams:send',
  teamsStopWorker: 'sprint-coder:teams:stop-worker',
  teamsStopAll: 'sprint-coder:teams:stop-all',
  teamsSubscribe: 'sprint-coder:teams:subscribe',
  teamsUnsubscribe: 'sprint-coder:teams:unsubscribe',
  teamsEvent: 'sprint-coder:teams:event',
  teamsGetCanvasView: 'sprint-coder:teams:get-canvas-view',
  teamsSaveCanvasView: 'sprint-coder:teams:save-canvas-view',
  workspaceGet: 'sprint-coder:workspace:get',
  workspaceSelect: 'sprint-coder:workspace:select',
  settingsGetRuntime: 'sprint-coder:settings:get-runtime',
  settingsSetRuntime: 'sprint-coder:settings:set-runtime',
  settingsSetModel: 'sprint-coder:settings:set-model',
  settingsSetEffort: 'sprint-coder:settings:set-effort',
  settingsSkillsScan: 'sprint-coder:settings:skills:scan',
  settingsSkillsPreview: 'sprint-coder:settings:skills:preview',
  settingsSkillsImport: 'sprint-coder:settings:skills:import',
  settingsSkillsUpdate: 'sprint-coder:settings:skills:update',
  settingsSkillsSetEnabled: 'sprint-coder:settings:skills:set-enabled',
  settingsSkillsRemove: 'sprint-coder:settings:skills:remove',
  /** Push-only (webContents.send), never bound to an ipcMain.handle input schema. */
  reasoningEvent: 'sprint-coder:turns:reasoning',
  fileEditEvent: 'sprint-coder:turns:file-edit',
  runtimeStatusEvent: 'sprint-coder:runtime:status',
  imagesList: 'sprint-coder:images:list',
  filesList: 'sprint-coder:files:list',
  filesOpen: 'sprint-coder:files:open',
  filesSave: 'sprint-coder:files:save',
  imagesRead: 'sprint-coder:images:read',
  settingsSetCodexEffort: 'sprint-coder:settings:set-codex-effort',
  modelsCatalogQuery: 'sprint-coder:models:catalog-query',
  modelsSetSelection: 'sprint-coder:models:set-selection',
  providersListConnections: 'sprint-coder:providers:list-connections',
  providersCreateOpenAIConnection: 'sprint-coder:providers:create-openai-connection',
  providersCreateOpenRouterConnection: 'sprint-coder:providers:create-openrouter-connection',
  providersCreateAnthropicConnection: 'sprint-coder:providers:create-anthropic-connection',
  providersCreateGeminiConnection: 'sprint-coder:providers:create-gemini-connection',
  providersCreateXAIConnection: 'sprint-coder:providers:create-xai-connection',
  providersVerifyConnection: 'sprint-coder:providers:verify-connection',
  permissionsGet: 'sprint-coder:permissions:get',
  permissionsSet: 'sprint-coder:permissions:set',
  permissionsListAutoDecisions: 'sprint-coder:permissions:list-auto-decisions',
  approvalsListPending: 'sprint-coder:approvals:list-pending',
  approvalsListRecent: 'sprint-coder:approvals:list-recent',
  approvalsResolve: 'sprint-coder:approvals:resolve',
  commandsList: 'sprint-coder:commands:list',
  commandsOutputPage: 'sprint-coder:commands:output-page',
  commandsOutputTail: 'sprint-coder:commands:output-tail',
  turnsStart: 'sprint-coder:turns:start',
  turnsQueue: 'sprint-coder:turns:queue',
  turnsSteer: 'sprint-coder:turns:steer',
  turnsStopAndSend: 'sprint-coder:turns:stop-and-send',
  turnsCancel: 'sprint-coder:turns:cancel',
  turnsSnapshot: 'sprint-coder:turns:snapshot',
  turnsSubscribe: 'sprint-coder:turns:subscribe',
  turnsPort: 'sprint-coder:turns:port',
} as const;
