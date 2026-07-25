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
export const teamSummarySchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    state: teamStateSchema,
    leaderAgentId: idSchema,
    budget: z.record(z.string(), z.json()),
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
    deliveryState: teamDeliveryStateSchema.nullable(),
    attempt: z.number().int().min(0),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type TeamMessageSummary = z.infer<typeof teamMessageSummarySchema>;

export const teamDetailSchema = z
  .object({
    team: teamSummarySchema,
    workers: z.array(workerSummarySchema),
    messages: z.array(teamMessageSummarySchema),
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

export const teamHireWorkerInputSchema = z
  .object({
    taskId: idSchema,
    role: z.string().min(1).max(100),
    objective: z.string().min(1).max(10_000),
    contextInheritancePolicy: contextInheritancePolicySchema,
    writeCapable: z.boolean(),
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
  .object({ type: z.literal('updated'), detail: teamDetailSchema })
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
// Model id/option shape is provider-agnostic (Codex slugs and Claude aliases/full ids both fit
// this format) and is kept under its original "codex" name for additive, non-breaking evolution.
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
// Claude-only reasoning effort levels. Verified empirically against the installed CLI (2.1.218):
// `claude --help` lists "--effort <level>  Effort level for the current session (low, medium,
// high, xhigh, max)", and a probe with an invalid value (`--effort bogus`) prints "Unknown
// --effort value 'bogus' — ignoring it and using the default effort. Valid values: low, medium,
// high, xhigh, max." confirming this exact enum. Codex has no equivalent flag on this CLI
// version, so — unlike `codexModelIdSchema` (deliberately provider-agnostic) — this schema is
// Claude-specific.
export const claudeEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
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
    // (unlike `model`, which is scoped per-kind) — it only takes effect on Claude turns, and the
    // Composer's effort selector is only enabled while Claude is the active Runtime.
    effort: claudeEffortSchema,
  })
  .strict();
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export const runtimeSetInputSchema = z.object({ kind: runtimeKindSchema }).strict();
export const runtimeModelSetInputSchema = z.object({ model: codexModelIdSchema }).strict();
export const runtimeEffortSetInputSchema = z.object({ effort: claudeEffortSchema }).strict();

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
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    localOnly: z.boolean().optional(),
  })
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
export const turnStartResultSchema = z.object({ turnId: idSchema }).strict();
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
  runtime: {
    /** Subscribes to Runtime process liveness. Returns an unsubscribe function. */
    subscribeStatus(listener: (status: RuntimeStatus) => void): () => void;
  };
  settings: {
    getRuntime(): Promise<RuntimeSettings>;
    setRuntime(kind: RuntimeKind): Promise<void>;
    setModel(model: string): Promise<void>;
    setEffort(effort: ClaudeEffort): Promise<void>;
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
  /** Push-only (webContents.send), never bound to an ipcMain.handle input schema. */
  runtimeStatusEvent: 'sprint-coder:runtime:status',
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
