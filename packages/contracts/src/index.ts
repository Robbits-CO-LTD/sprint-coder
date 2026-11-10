import { z } from 'zod';

const idSchema = z.string().min(1).max(128);
const timestampSchema = z.string().datetime();
const taskTextSchema = z.string().max(100_000);

function isSafeSkillDraftPath(value: string): boolean {
  if (value.startsWith('/') || value.includes('\\')) return false;
  const parts = value.split('/');
  return (
    parts.length <= 9 &&
    parts.every((part) => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'))
  );
}

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
  'project.memory.write',
  'skill.draft.write',
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
    description: z.string().min(1).max(2_000),
    parallelism: z.enum(['parallel', 'serial']),
    maxOutputBytes: z.number().int().positive(),
    supportsCancellation: z.boolean(),
    supportsBackground: z.boolean(),
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

export const goalStatusSchema = z.enum(['active', 'paused', 'completed', 'blocked']);
export const goalSummarySchema = z
  .object({
    // Legacy Task Goals used taskTextSchema (100k). Keep them readable while goalStartInputSchema
    // enforces Codex's 4k limit for every newly started or edited Goal.
    objective: taskTextSchema,
    status: goalStatusSchema,
    tokenBudget: z.number().int().positive().nullable(),
    tokensUsed: z.number().int().nonnegative(),
    timeUsedSeconds: z.number().int().nonnegative(),
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type GoalSummary = z.infer<typeof goalSummarySchema>;

export const taskSummarySchema = z
  .object({
    id: idSchema,
    projectId: idSchema.nullable().default(null),
    title: z.string().min(1).max(200),
    pinned: z.boolean(),
    archived: z.boolean(),
    goal: z.string().nullable(),
    goalState: goalSummarySchema.nullable().default(null),
    workspacePath: z.string().nullable(),
    localOnly: z.boolean(),
    /** Whether the Task has accepted at least one user message. Older backends may omit this;
     * renderers must treat absence as an established Task for compatibility. */
    hasConversation: z.boolean().optional(),
    /** Window-wide activity snapshot; independent of the selected Task's event port. */
    activeTurnId: idSchema.nullable().optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const projectSummarySchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(120),
    archived: z.boolean(),
    revision: z.number().int().positive(),
    taskCount: z.number().int().nonnegative(),
    folderCount: z.number().int().min(0).max(16).default(0),
    primaryFolder: z
      .object({ id: idSchema, path: z.string().min(1), label: z.string().min(1).max(255) })
      .strict()
      .nullable()
      .default(null),
    lastActivityAt: timestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectFolderRoleSchema = z.enum(['primary', 'secondary']);
export const projectFolderStatusSchema = z.enum([
  'available',
  'missing',
  'unreadable',
  'identity_changed',
]);
export const projectFolderSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    path: z.string().min(1),
    label: z.string().min(1).max(255),
    role: projectFolderRoleSchema,
    ordinal: z.number().int().min(0).max(15),
    status: projectFolderStatusSchema,
  })
  .strict();
export type ProjectFolder = z.infer<typeof projectFolderSchema>;

export const projectFolderInputSchema = z
  .object({
    id: idSchema.optional(),
    path: z.string().min(1),
    label: z.string().trim().min(1).max(255).optional(),
    role: projectFolderRoleSchema,
  })
  .strict();
export type ProjectFolderInput = z.infer<typeof projectFolderInputSchema>;

const projectFolderInputsSchema = z
  .array(projectFolderInputSchema)
  .max(16)
  .superRefine((folders, context) => {
    const primaryCount = folders.filter(({ role }) => role === 'primary').length;
    if ((folders.length === 0 && primaryCount !== 0) || (folders.length > 0 && primaryCount !== 1))
      context.addIssue({
        code: 'custom',
        message: 'A non-empty Project must have exactly one Primary folder',
      });
  });

export const effectiveWorkspaceRootSchema = projectFolderSchema
  .omit({ projectId: true, ordinal: true })
  .extend({ rootId: idSchema })
  .omit({ id: true })
  .strict();
export type EffectiveWorkspaceRoot = z.infer<typeof effectiveWorkspaceRootSchema>;
export const effectiveWorkspaceSetSchema = z
  .object({
    source: z.enum(['project', 'task', 'none']),
    projectId: idSchema.nullable(),
    primaryRootId: idSchema.nullable(),
    roots: z.array(effectiveWorkspaceRootSchema).max(16),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((workspace, context) => {
    if (workspace.roots.length === 0 && workspace.primaryRootId !== null)
      context.addIssue({
        code: 'custom',
        message: 'An empty Workspace cannot have a Primary root',
      });
    if (
      workspace.roots.length > 0 &&
      (workspace.primaryRootId === null ||
        !workspace.roots.some(
          ({ rootId, role }) => rootId === workspace.primaryRootId && role === 'primary',
        ))
    )
      context.addIssue({ code: 'custom', message: 'Workspace Primary root is invalid' });
  });
export type EffectiveWorkspaceSet = z.infer<typeof effectiveWorkspaceSetSchema>;

export const projectFolderPickerResultSchema = z.discriminatedUnion('canceled', [
  z.object({ canceled: z.literal(true) }).strict(),
  z
    .object({
      canceled: z.literal(false),
      folders: z
        .array(z.object({ path: z.string().min(1), label: z.string().min(1).max(255) }).strict())
        .max(16),
    })
    .strict(),
]);
export type ProjectFolderPickerResult = z.infer<typeof projectFolderPickerResultSchema>;

export const teamStateSchema = z.enum([
  'draft',
  'forming',
  'active',
  'paused',
  'winding_down',
  'completed',
  'failed',
]);
/** Mirrors TEAM_MAX_CONCURRENT_EXECUTIONS in packages/domain/src/team.ts. */
export const TEAM_CONCURRENCY_MAX = 100;
export const teamConcurrencyLimitSchema = z.number().int().min(1).max(TEAM_CONCURRENCY_MAX);
export const teamPolicySchema = z
  .object({
    maxAgentDepth: z.number().int().min(1).max(4),
    maxConcurrentExecutions: teamConcurrencyLimitSchema,
    allowWorkerDirectMessages: z.boolean(),
    budgetMode: z.enum(['bounded', 'unlimited']),
  })
  .strict();
export type TeamPolicy = z.infer<typeof teamPolicySchema>;
export const teamBlueprintRoleSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    title: z.string().min(1).max(100),
    parentKey: z.string().min(1).max(80),
    responsibility: z.string().min(1).max(2_000),
    scope: z.array(z.string().min(1).max(500)).max(64),
    nonGoals: z.array(z.string().min(1).max(500)).max(64),
    doneCriteria: z.array(z.string().min(1).max(500)).max(64),
    required: z.boolean(),
    canDelegate: z.boolean(),
    modelRequirements: z
      .object({
        capabilities: z.array(z.string().min(1).max(100)).max(32),
        preferredProviders: z.array(z.string().min(1).max(64)).max(16).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const teamBlueprintSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('team'),
    policy: teamPolicySchema,
    leaderInstructions: z.string().min(1).max(20_000),
    roles: z.array(teamBlueprintRoleSchema).min(1).max(64),
  })
  .strict()
  .superRefine((blueprint, context) => {
    const keys = new Set<string>();
    blueprint.roles.forEach((role, index) => {
      if (keys.has(role.key))
        context.addIssue({
          code: 'custom',
          message: `Role keyが重複しています: ${role.key}`,
          path: ['roles', index, 'key'],
        });
      keys.add(role.key);
    });
    blueprint.roles.forEach((role, index) => {
      if (role.parentKey !== 'leader' && !keys.has(role.parentKey))
        context.addIssue({
          code: 'custom',
          message: `親Roleが存在しません: ${role.parentKey}`,
          path: ['roles', index, 'parentKey'],
        });
      if (role.parentKey === role.key)
        context.addIssue({
          code: 'custom',
          message: `Roleは自身を親にできません: ${role.key}`,
          path: ['roles', index, 'parentKey'],
        });
    });
    const parents = new Map(blueprint.roles.map((role) => [role.key, role.parentKey]));
    blueprint.roles.forEach((role, index) => {
      const visited = new Set<string>([role.key]);
      let current = role.parentKey;
      while (current !== 'leader' && parents.has(current)) {
        if (visited.has(current)) {
          context.addIssue({
            code: 'custom',
            message: `Roleの親子関係が循環しています: ${role.key}`,
            path: ['roles', index, 'parentKey'],
          });
          break;
        }
        visited.add(current);
        current = parents.get(current)!;
      }
    });
  });
export type TeamBlueprint = z.infer<typeof teamBlueprintSchema>;
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
const teamConnectionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const teamProviderIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

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

/** One step of a Worker's work log — a tool call or a file change, as the Worker reported it. */
export const workerActivityEntrySchema = z
  .object({
    kind: z.enum(['activity', 'fileChange']),
    label: z.string().max(500),
    at: timestampSchema,
  })
  .strict();
export type WorkerActivityEntry = z.infer<typeof workerActivityEntrySchema>;

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
    engine: z.enum(['mock', 'codex', 'claude', 'grok']),
    connectionId: teamConnectionIdSchema.nullable(),
    requestedProvider: teamProviderIdSchema.nullable(),
    requestedModel: z.string().min(1).max(256).nullable(),
    parentAgentId: idSchema.nullable(),
    depth: z.number().int().min(0).max(4),
    canDelegate: z.boolean(),
    managerPolicy: managerPolicySchema.nullable(),
    liveOutput: z.string().max(20_000),
    reasoningActive: z.boolean(),
    /** The newest steps of the Worker's work log, oldest first. Optional for older producers. */
    activityLog: z.array(workerActivityEntrySchema).max(40).optional(),
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

export const teamMissionWorktreeStateSchema = z.enum([
  'created',
  'active',
  'ready',
  'integrated',
  'cleaned',
  'quarantined',
]);
export type TeamMissionWorktreeState = z.infer<typeof teamMissionWorktreeStateSchema>;
export const teamMissionWorktreeSummarySchema = z
  .object({
    path: z.string().min(1).max(4_096),
    baseHead: z.string().regex(/^[0-9a-f]{40,64}$/i),
    state: teamMissionWorktreeStateSchema,
    workerHead: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/i)
      .nullable(),
    integratedHead: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/i)
      .nullable(),
    changedFiles: z.array(z.string().min(1).max(4_096)).max(500),
    reason: z.string().min(1).max(2_000).nullable(),
  })
  .strict();
export type TeamMissionWorktreeSummary = z.infer<typeof teamMissionWorktreeSummarySchema>;

export const teamExecutionIsolationSchema = z
  .object({
    phase: z.enum([
      'preparing',
      'running',
      'finalizing',
      'waiting_integration',
      'integrating',
      'waiting_resume',
      'completed',
      'quarantined',
    ]),
    resumeKind: z.enum(['worker', 'integration']).nullable(),
    repositories: z
      .array(
        z
          .object({
            ordinal: z.number().int().min(1).max(16),
            repoPath: z.string().min(1).max(4_096),
            worktreePath: z.string().min(1).max(4_096),
            baseHead: z.string().regex(/^[0-9a-f]{40,64}$/i),
            workerHead: z
              .string()
              .regex(/^[0-9a-f]{40,64}$/i)
              .nullable(),
            integratedHead: z
              .string()
              .regex(/^[0-9a-f]{40,64}$/i)
              .nullable(),
            state: z.enum(['active', 'ready', 'integrated', 'cleaned', 'quarantined']),
            changedFiles: z.array(z.string().min(1).max(4_096)).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    roots: z
      .array(
        z
          .object({
            rootId: idSchema,
            rootLabel: z.string().min(1).max(255),
            role: z.enum(['primary', 'secondary']),
            repositoryOrdinal: z.number().int().min(1).max(16),
            sourcePath: z.string().min(1).max(4_096),
            isolatedPath: z.string().min(1).max(4_096),
            identity: z.string().length(64),
            mutationKey: z.string().length(64),
            isolatedIdentity: z.string().length(64).nullable().default(null),
            isolatedMutationKey: z.string().length(64).nullable().default(null),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    reason: z.string().min(1).max(2_000).nullable(),
  })
  .strict()
  .superRefine((isolation, context) => {
    const repositoryOrdinals = new Set(isolation.repositories.map(({ ordinal }) => ordinal));
    if (repositoryOrdinals.size !== isolation.repositories.length)
      context.addIssue({ code: 'custom', message: 'Isolation repository ordinals must be unique' });
    const rootIds = new Set(isolation.roots.map(({ rootId }) => rootId));
    const mutationKeys = new Set(isolation.roots.map(({ mutationKey }) => mutationKey));
    if (rootIds.size !== isolation.roots.length || mutationKeys.size !== isolation.roots.length)
      context.addIssue({ code: 'custom', message: 'Isolation root bindings must be unique' });
    if (isolation.roots.filter(({ role }) => role === 'primary').length !== 1)
      context.addIssue({ code: 'custom', message: 'Isolation requires exactly one Primary root' });
    if (isolation.roots.some(({ repositoryOrdinal }) => !repositoryOrdinals.has(repositoryOrdinal)))
      context.addIssue({
        code: 'custom',
        message: 'Isolation root references an unknown repository',
      });
    if ((isolation.phase === 'waiting_resume') !== (isolation.resumeKind !== null))
      context.addIssue({
        code: 'custom',
        message: 'Isolation resume kind does not match its phase',
      });
    if (
      ['preparing', 'running'].includes(isolation.phase) &&
      isolation.repositories.some(({ state }) => state !== 'active')
    )
      context.addIssue({
        code: 'custom',
        message: 'Running isolation repositories must be active',
      });
    if (
      ['waiting_integration', 'integrating', 'completed'].includes(isolation.phase) &&
      isolation.repositories.some(
        ({ state, workerHead }) =>
          !['ready', 'integrated', 'cleaned'].includes(state) || workerHead === null,
      )
    )
      context.addIssue({ code: 'custom', message: 'Isolation repositories must finalize first' });
    if (
      isolation.phase === 'completed' &&
      isolation.repositories.some(
        ({ state, integratedHead }) =>
          !['integrated', 'cleaned'].includes(state) || integratedHead === null,
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Completed isolation must integrate every repository',
      });
  });
export type TeamExecutionIsolation = z.infer<typeof teamExecutionIsolationSchema>;

export const teamExecutionSummarySchema = z
  .object({
    waitingForWorker: z.boolean().optional(),
    workerQueueDepth: z.number().int().nonnegative().optional(),
    id: idSchema,
    teamId: idSchema,
    assigneeAgentId: idSchema,
    createdByAgentId: idSchema,
    accessMode: z.enum(['read-only', 'workspace-write']).default('read-only'),
    state: z.enum([
      'assigned',
      'queued',
      'waiting_verification',
      'waiting_rate_limit',
      'running',
      'waiting_resume',
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
        'automatic_retry',
      ])
      .nullable(),
    connectionId: z.string().min(1).max(128).nullable(),
    requestedModel: z.string().min(1).max(128).nullable(),
    attemptStartReason: z
      .enum(['initial', 'automatic_retry', 'manual_resume', 'steer', 'app_restart'])
      .nullable(),
    lastProgressAt: timestampSchema.nullable(),
    terminalReason: z.string().min(1).max(128).nullable(),
    missionId: idSchema.nullable(),
    missionStepOrdinal: z.number().int().min(1).max(12).nullable(),
    missionStepCount: z.number().int().min(2).max(12).nullable(),
    worktree: teamMissionWorktreeSummarySchema.nullable().default(null),
    isolation: teamExecutionIsolationSchema.nullable().default(null),
    /**
     * For each isolation repository kept on disk after it recorded an integration (`quarantined`
     * with an integrated HEAD): whether Main last found that commit in its repository's current
     * history. It is the same check, and the same result, as the retained worktree list's
     * `integration` (issue #579). A repository Main has not checked yet has no entry, and the field
     * is left out when no repository is such a worktree.
     */
    retainedWorktreeIntegrations: z
      .array(
        z
          .object({
            repositoryOrdinal: z.number().int().min(1).max(16),
            integration: z.enum(['confirmed', 'unconfirmed']),
          })
          .strict(),
      )
      .max(16)
      .optional(),
    assignedAt: timestampSchema,
    queuedAt: timestampSchema.nullable(),
    startedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
    updatedAt: timestampSchema,
  })
  .strict();
export type TeamExecutionSummary = z.infer<typeof teamExecutionSummarySchema>;

export const teamMissionAccessSchema = z.enum(['read-only', 'workspace-write']);
export type TeamMissionAccess = z.infer<typeof teamMissionAccessSchema>;
export const teamMissionStateSchema = z.enum([
  'queued',
  'running',
  'waiting_resume',
  'completed',
  'failed',
  'canceled',
]);
export type TeamMissionState = z.infer<typeof teamMissionStateSchema>;
export const teamMissionStepInputSchema = z
  .object({
    workerId: idSchema,
    objective: z.string().min(1).max(10_000),
    doneCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(20),
    access: teamMissionAccessSchema,
  })
  .strict();
export type TeamMissionStepInput = z.infer<typeof teamMissionStepInputSchema>;
export const graphMissionKeySchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u);
const graphClaimKeySchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/u);
export const graphWriteClaimSchema = z
  .object({
    rootId: idSchema,
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) =>
          !/[\\:*?[\]{}\0]/u.test(value) &&
          value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'),
      )
      .nullable(),
    semanticKeys: z.array(graphClaimKeySchema).max(32),
  })
  .strict();
export const graphResourceClaimSchema = z
  .object({
    scope: z.enum(['machine', 'workspace']),
    key: graphClaimKeySchema,
    rootId: idSchema.nullable(),
  })
  .strict()
  .refine((value) => (value.scope === 'machine') === (value.rootId === null));
export const graphMissionStepSchema = teamMissionStepInputSchema
  .extend({
    key: graphMissionKeySchema,
    nodeId: graphMissionKeySchema,
    dependsOn: z.array(graphMissionKeySchema).max(11),
    writeClaims: z.array(graphWriteClaimSchema).max(64),
    resourceClaims: z.array(graphResourceClaimSchema).max(16),
  })
  .strict()
  .refine((step) => step.access !== 'read-only' || step.writeClaims.length === 0);
export const graphMissionPlanSchema = z
  .object({
    mode: z.literal('graph'),
    objective: z.string().min(1).max(20_000),
    doneCriteria: z.array(z.string().min(1).max(1000)).min(1).max(64),
    steps: z.array(graphMissionStepSchema).min(2).max(12),
  })
  .strict();
export type GraphMissionPlan = z.infer<typeof graphMissionPlanSchema>;
const graphNullableStringJsonSchema = () =>
  ({
    allOf: [{ if: { not: { type: 'null' } }, then: { type: 'string' } }],
  }) as const;
export const GRAPH_MISSION_PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    mode: { const: 'graph' },
    objective: { type: 'string', minLength: 1, maxLength: 20_000 },
    doneCriteria: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: { type: 'string', minLength: 1, maxLength: 1000 },
    },
    steps: {
      type: 'array',
      minItems: 2,
      maxItems: 12,
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          nodeId: { type: 'string' },
          workerId: { type: 'string' },
          objective: { type: 'string', minLength: 1, maxLength: 10_000 },
          doneCriteria: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: { type: 'string', minLength: 1, maxLength: 1000 },
          },
          access: { enum: ['read-only', 'workspace-write'] },
          dependsOn: { type: 'array', maxItems: 11, items: { type: 'string' } },
          writeClaims: {
            type: 'array',
            maxItems: 64,
            items: {
              type: 'object',
              properties: {
                rootId: { type: 'string' },
                path: graphNullableStringJsonSchema(),
                semanticKeys: { type: 'array', maxItems: 32, items: { type: 'string' } },
              },
              required: ['rootId', 'path', 'semanticKeys'],
              additionalProperties: false,
            },
          },
          resourceClaims: {
            type: 'array',
            maxItems: 16,
            items: {
              type: 'object',
              properties: {
                scope: { enum: ['machine', 'workspace'] },
                key: { type: 'string' },
                rootId: graphNullableStringJsonSchema(),
              },
              required: ['scope', 'key', 'rootId'],
              additionalProperties: false,
            },
          },
        },
        required: [
          'key',
          'nodeId',
          'workerId',
          'objective',
          'doneCriteria',
          'access',
          'dependsOn',
          'writeClaims',
          'resourceClaims',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['mode', 'objective', 'doneCriteria', 'steps'],
  additionalProperties: false,
} as const;
export const teamAssignMissionInputSchema = z
  .object({
    taskId: idSchema,
    objective: z.string().min(1).max(20_000),
    doneCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(64),
    steps: z.array(teamMissionStepInputSchema).min(2).max(12),
  })
  .strict();
export type TeamAssignMissionInput = z.infer<typeof teamAssignMissionInputSchema>;
export const teamResumeMissionInputSchema = z
  .object({ taskId: idSchema, missionId: idSchema })
  .strict();
export type TeamResumeMissionInput = z.infer<typeof teamResumeMissionInputSchema>;
export const teamResumeExecutionIntegrationInputSchema = z
  .object({ taskId: idSchema, executionId: idSchema })
  .strict();
export type TeamResumeExecutionIntegrationInput = z.infer<
  typeof teamResumeExecutionIntegrationInputSchema
>;

/** The most retained worktrees one listing returns; `total` still counts every one (issue #544). */
export const TEAM_RETAINED_WORKTREE_LIST_LIMIT = 200;
/** The most file entries one inspection returns per list; the rest are only flagged as truncated. */
export const TEAM_RETAINED_WORKTREE_INSPECTION_LIMIT = 500;
const retainedWorktreeGitHeadSchema = z.string().regex(/^[0-9a-f]{40,64}$/i);
const retainedWorktreeOrdinalSchema = z.number().int().min(1).max(16);
/** One repository worktree of a Team execution isolation, named for a read or a discard. */
export const teamRetainedWorktreeRefSchema = z
  .object({
    taskId: idSchema,
    executionId: idSchema,
    repositoryOrdinal: retainedWorktreeOrdinalSchema,
  })
  .strict();
export type TeamRetainedWorktreeRef = z.infer<typeof teamRetainedWorktreeRefSchema>;
/**
 * A worktree a Team Worker left on disk (issue #544): an execution isolation repository recorded as
 * `quarantined`. Main decides `discardable`, and `blockedReason` says in Japanese why it is not.
 */
export const teamRetainedWorktreeSchema = z
  .object({
    executionId: idSchema,
    repositoryOrdinal: retainedWorktreeOrdinalSchema,
    agentId: idSchema,
    role: z.string().min(1).max(200),
    repoPath: z.string().min(1).max(4_096),
    worktreePath: z.string().min(1).max(4_096),
    baseHead: retainedWorktreeGitHeadSchema,
    workerHead: retainedWorktreeGitHeadSchema.nullable(),
    integratedHead: retainedWorktreeGitHeadSchema.nullable(),
    /**
     * Whether the change is in the Workspace: `none` when nothing was integrated, `confirmed` when
     * the recorded integrated commit is in the repository's current history, and `unconfirmed` when
     * it was recorded but Main no longer finds it there (or could not check).
     */
    integration: z.enum(['none', 'confirmed', 'unconfirmed']),
    /**
     * The worktree on disk holds a submodule (or Main could not tell). A Worker's commits inside
     * one may exist only in this worktree while the Workspace refers to them, so an integrated
     * change is no assurance that discarding it loses nothing.
     */
    submodules: z.boolean(),
    /** Files the isolation recorded when it sealed a commit; the live state comes from inspect. */
    changedFileCount: z.number().int().min(0).max(500),
    reason: z.string().min(1).max(2_000).nullable(),
    executionState: teamExecutionSummarySchema.shape.state,
    existsOnDisk: z.boolean(),
    discardable: z.boolean(),
    blockedReason: z.string().min(1).max(500).nullable(),
  })
  .strict()
  .refine(({ discardable, blockedReason }) => discardable === (blockedReason === null), {
    message: 'A retained worktree is discardable exactly when it has no blocked reason',
  })
  .refine(
    ({ integratedHead, integration }) => (integration === 'none') === (integratedHead === null),
    {
      message: 'Only a retained worktree without an integrated commit has no integration to check',
    },
  );
export type TeamRetainedWorktree = z.infer<typeof teamRetainedWorktreeSchema>;
export const teamRetainedWorktreeCursorSchema = z
  .object({
    taskId: idSchema,
    teamId: idSchema,
    assignedAt: timestampSchema,
    executionId: idSchema,
    repositoryOrdinal: retainedWorktreeOrdinalSchema,
  })
  .strict();
export type TeamRetainedWorktreeCursor = z.infer<typeof teamRetainedWorktreeCursorSchema>;
export const teamRetainedWorktreeListInputSchema = z
  .object({
    taskId: idSchema,
    cursor: teamRetainedWorktreeCursorSchema.optional(),
  })
  .strict()
  .refine(({ taskId, cursor }) => cursor === undefined || cursor.taskId === taskId, {
    message: 'Retained worktree cursor must belong to the requested Task',
  });
export const teamRetainedWorktreeListSchema = z
  .object({
    worktrees: z.array(teamRetainedWorktreeSchema).max(TEAM_RETAINED_WORKTREE_LIST_LIMIT),
    total: z.number().int().min(0),
    nextCursor: teamRetainedWorktreeCursorSchema.nullable(),
  })
  .strict()
  .refine(({ worktrees, total }) => total >= worktrees.length, {
    message: 'Retained worktree total cannot be below the listed count',
  });
export type TeamRetainedWorktreeList = z.infer<typeof teamRetainedWorktreeListSchema>;
/** What a retained worktree holds now, read from Git without changing it. */
export const teamRetainedWorktreeInspectionSchema = z
  .object({
    executionId: idSchema,
    repositoryOrdinal: retainedWorktreeOrdinalSchema,
    head: retainedWorktreeGitHeadSchema,
    /** Commits on HEAD that the base does not have; 0 while HEAD is still the base. */
    commitsSinceBase: z.number().int().min(0),
    /** `git status --porcelain` entries: the two-letter code and the path. */
    status: z
      .array(z.object({ code: z.string().length(2), path: z.string().min(1).max(4_096) }).strict())
      .max(TEAM_RETAINED_WORKTREE_INSPECTION_LIMIT),
    statusTruncated: z.boolean(),
    /** `git diff --name-status <base>` entries: tracked files changed since the base. */
    changesFromBase: z
      .array(
        z.object({ status: z.string().min(1).max(8), path: z.string().min(1).max(4_096) }).strict(),
      )
      .max(TEAM_RETAINED_WORKTREE_INSPECTION_LIMIT),
    changesFromBaseTruncated: z.boolean(),
  })
  .strict();
export type TeamRetainedWorktreeInspection = z.infer<typeof teamRetainedWorktreeInspectionSchema>;
export const teamMissionCheckpointSchema = z
  .object({
    summary: z.string().min(1).max(4_000),
    changedFiles: z.array(z.string().min(1).max(4_096)).max(500),
    gitHead: z.string().min(1).max(128).nullable(),
    workspaceDigest: z.string().length(64).nullable(),
    recordedAt: timestampSchema,
  })
  .strict();
export type TeamMissionCheckpoint = z.infer<typeof teamMissionCheckpointSchema>;
export const teamMissionStepSummarySchema = z
  .object({
    graph: z
      .object({
        key: z.string().min(1).max(128),
        nodeId: z.string().min(1).max(128),
        generation: z.number().int().positive(),
        resourceState: z.enum(['reserved', 'active', 'quarantined', 'released']).nullable(),
        waitReason: z
          .enum(['dependencies', 'resources', 'write-conflicts', 'owner-active'])
          .nullable(),
        integrationResumeAvailable: z.boolean(),
        stepResumeAvailable: z.boolean(),
        workspaceReviewRequired: z.boolean().optional(),
        /** Already resumed by hand and waiting on the scheduler (dependencies, resources). */
        stepResumePending: z.boolean(),
      })
      .strict()
      .optional(),
    ordinal: z.number().int().min(1).max(12),
    executionId: idSchema,
    workerId: idSchema,
    objective: z.string().min(1).max(10_000),
    doneCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(20),
    access: teamMissionAccessSchema,
    state: z.enum([
      'assigned',
      'queued',
      'waiting_verification',
      'waiting_rate_limit',
      'running',
      'waiting_resume',
      'completed',
      'failed',
      'canceled',
    ]),
    checkpoint: teamMissionCheckpointSchema.nullable(),
    worktree: teamMissionWorktreeSummarySchema.nullable().default(null),
  })
  .strict();
export type TeamMissionStepSummary = z.infer<typeof teamMissionStepSummarySchema>;
export const teamMissionSummarySchema = z
  .object({
    mode: z.enum(['sequential', 'graph']).optional(),
    graph: z
      .object({ id: z.string().uuid(), semanticRevision: z.number().int().positive() })
      .strict()
      .optional(),
    id: idSchema,
    teamId: idSchema,
    createdByAgentId: idSchema,
    state: teamMissionStateSchema,
    objective: z.string().min(1).max(20_000),
    doneCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(64),
    currentStepOrdinal: z.number().int().min(1).max(12),
    steps: z.array(teamMissionStepSummarySchema).min(2).max(12),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
  })
  .strict();
export type TeamMissionSummary = z.infer<typeof teamMissionSummarySchema>;

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
        'automatic_retry',
      ])
      .nullable(),
    attemptOrdinal: z.number().int().min(1).nullable(),
    terminalReason: z.string().min(1).max(128).nullable(),
    connectionId: teamConnectionIdSchema.nullable(),
    requestedProvider: teamProviderIdSchema.nullable(),
    requestedModel: z.string().min(1).max(256).nullable(),
    modelSelectionReason: z.string().min(1).max(2_000).nullable(),
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
    missions: z.array(teamMissionSummarySchema),
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
    /**
     * The Worker's own report for each done criterion of its task (issue #550). `criterion` is the
     * task's canonical text, never the model's rewording. Absent when no report could be read.
     */
    criteria: z
      .array(
        z
          .object({
            criterion: z.string().min(1).max(1_000),
            status: z.enum(['done', 'not_done']),
            evidence: z.string().max(4_000),
          })
          .strict(),
      )
      .max(50)
      .optional(),
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
    modelSelectionReason: z.string().min(1).max(2_000).optional(),
    blueprintRoleKey: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
      .optional(),
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

export const teamSubscriptionInputSchema = z
  .object({
    taskId: idSchema,
    subscriptionId: idSchema,
  })
  .strict();
export type TeamSubscriptionInput = z.infer<typeof teamSubscriptionInputSchema>;

export const teamSubscriptionSnapshotSchema = z
  .object({
    type: z.literal('snapshot'),
    seq: z.number().int().min(0),
    detail: teamDetailSchema.nullable(),
  })
  .strict();
export type TeamSubscriptionSnapshot = z.infer<typeof teamSubscriptionSnapshotSchema>;

/**
 * What changed in a Team detail since the previous Team event (issue #863). A 32-Worker Team
 * detail is about 1 MB, mostly live output and message text, and sending all of it on every
 * change kept the Renderer behind. A collection lists the items that are new or changed in full;
 * `order` is the whole id list and is present only when items were added, removed or reordered.
 * A Worker's live output travels apart from the Worker: the new text is the previous text with
 * `drop` characters removed from its start and `append` added at its end.
 */
function teamCollectionPatchSchema<T extends z.ZodType>(item: T) {
  return z.object({ upserts: z.array(item), order: z.array(idSchema).optional() }).strict();
}
export const teamWorkerPatchSchema = workerSummarySchema.omit({ liveOutput: true });
export const teamLiveOutputPatchSchema = z
  .object({
    agentId: idSchema,
    drop: z.number().int().min(0).max(20_000),
    append: z.string().max(20_000),
  })
  .strict();
export const teamDetailPatchSchema = z
  .object({
    team: teamSummarySchema.optional(),
    workers: teamCollectionPatchSchema(teamWorkerPatchSchema).optional(),
    liveOutputs: z.array(teamLiveOutputPatchSchema).optional(),
    messages: teamCollectionPatchSchema(teamMessageSummarySchema).optional(),
    executions: teamCollectionPatchSchema(teamExecutionSummarySchema).optional(),
    missions: teamCollectionPatchSchema(teamMissionSummarySchema).optional(),
    activities: teamCollectionPatchSchema(teamActivitySummarySchema).optional(),
    budgets: z.array(teamBudgetStatusSchema).optional(),
  })
  .strict();
export type TeamDetailPatch = z.infer<typeof teamDetailPatchSchema>;
type TeamCollectionPatch<T> = { upserts: T[]; order?: string[] | undefined };
type TeamLiveOutputPatch = z.infer<typeof teamLiveOutputPatchSchema>;

export const teamEventSchema = z.discriminatedUnion('type', [
  teamSubscriptionSnapshotSchema,
  z
    .object({
      type: z.literal('updated'),
      seq: z.number().int().min(1),
      detail: teamDetailSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('patched'),
      seq: z.number().int().min(1),
      /** The Team the patch belongs to; a different Team is always sent as a whole detail. */
      teamId: idSchema,
      patch: teamDetailPatchSchema,
    })
    .strict(),
]);
export type TeamEvent = z.infer<typeof teamEventSchema>;

function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function hasUniqueIds(items: readonly { id: string }[]): boolean {
  return new Set(items.map(({ id }) => id)).size === items.length;
}

function diffCollection<T extends { id: string }>(
  base: readonly T[],
  next: readonly T[],
  same: (a: T, b: T) => boolean = sameJson,
): TeamCollectionPatch<T> | undefined {
  const baseById = new Map(base.map((item) => [item.id, item]));
  const upserts = next.filter((item) => {
    const previous = baseById.get(item.id);
    return previous === undefined || !same(previous, item);
  });
  const sameOrder = base.length === next.length && base.every(({ id }, i) => id === next[i]?.id);
  if (sameOrder) return upserts.length === 0 ? undefined : { upserts };
  return { upserts, order: next.map(({ id }) => id) };
}

/** Attempts per live-output diff before it falls back to resending the whole text. */
const LIVE_OUTPUT_DIFF_ATTEMPTS = 8;

function diffLiveOutput(previous: string, next: string): Omit<TeamLiveOutputPatch, 'agentId'> {
  if (next.startsWith(previous)) return { drop: 0, append: next.slice(previous.length) };
  // Live output keeps only its last characters, so new text usually pushes old text off the front:
  // find where the end of the old text now sits in the new one, nearest the end first.
  const tail = previous.slice(-64);
  let position = tail === '' ? -1 : next.lastIndexOf(tail);
  for (let attempt = 0; position !== -1 && attempt < LIVE_OUTPUT_DIFF_ATTEMPTS; attempt += 1) {
    const kept = position + tail.length;
    if (kept <= previous.length && next.slice(0, kept) === previous.slice(previous.length - kept))
      return { drop: previous.length - kept, append: next.slice(kept) };
    position = position === 0 ? -1 : next.lastIndexOf(tail, position - 1);
  }
  return { drop: previous.length, append: next };
}

function withoutLiveOutput(worker: WorkerSummary): Omit<WorkerSummary, 'liveOutput'> {
  const { liveOutput: _liveOutput, ...rest } = worker;
  return rest;
}

/**
 * The patch that turns `base` into `next`, or null when only a whole detail can do that: another
 * Team, or a collection whose ids are not unique. Applying the patch to `base` with
 * {@link applyTeamDetailPatch} gives a detail equal to `next`.
 */
export function diffTeamDetail(base: TeamDetail, next: TeamDetail): TeamDetailPatch | null {
  if (base.team.id !== next.team.id) return null;
  const collections = [base, next].flatMap((detail) => [
    detail.workers,
    detail.messages,
    detail.executions,
    detail.missions,
    detail.activities,
  ]);
  if (!collections.every(hasUniqueIds)) return null;
  const patch: TeamDetailPatch = {};
  if (!sameJson(base.team, next.team)) patch.team = next.team;
  const workers = diffCollection(
    base.workers.map(withoutLiveOutput),
    next.workers.map(withoutLiveOutput),
  );
  if (workers !== undefined) patch.workers = workers;
  const baseLiveOutput = new Map(base.workers.map(({ id, liveOutput }) => [id, liveOutput]));
  const liveOutputs = next.workers.flatMap(({ id, liveOutput }) => {
    const previous = baseLiveOutput.get(id) ?? '';
    return liveOutput === previous
      ? []
      : [{ agentId: id, ...diffLiveOutput(previous, liveOutput) }];
  });
  if (liveOutputs.length > 0) patch.liveOutputs = liveOutputs;
  const messages = diffCollection(base.messages, next.messages);
  if (messages !== undefined) patch.messages = messages;
  const executions = diffCollection(base.executions, next.executions);
  if (executions !== undefined) patch.executions = executions;
  const missions = diffCollection(base.missions, next.missions);
  if (missions !== undefined) patch.missions = missions;
  const activities = diffCollection(base.activities, next.activities);
  if (activities !== undefined) patch.activities = activities;
  if (!sameJson(base.budgets, next.budgets)) patch.budgets = next.budgets;
  return patch;
}

export function isEmptyTeamDetailPatch(patch: TeamDetailPatch): boolean {
  return Object.keys(patch).length === 0;
}

/** Thrown when a patch does not fit the detail it is applied to; the reader must resynchronize. */
export class TeamDetailPatchMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamDetailPatchMismatchError';
  }
}

function applyCollection<T extends { id: string }>(
  base: T[],
  patch: TeamCollectionPatch<T> | undefined,
): T[] {
  if (patch === undefined) return base;
  const upserts = new Map(patch.upserts.map((item) => [item.id, item]));
  if (patch.order === undefined) {
    const baseIds = new Set(base.map(({ id }) => id));
    if (patch.upserts.some(({ id }) => !baseIds.has(id)))
      throw new TeamDetailPatchMismatchError('A new item arrived without the new order');
    return base.map((item) => upserts.get(item.id) ?? item);
  }
  const baseById = new Map(base.map((item) => [item.id, item]));
  return patch.order.map((id) => {
    const item = upserts.get(id) ?? baseById.get(id);
    if (item === undefined) throw new TeamDetailPatchMismatchError(`Unknown item ${id}`);
    return item;
  });
}

/**
 * Applies a patch made by {@link diffTeamDetail}. Everything the patch leaves unchanged keeps its
 * identity, so a reader can skip re-rendering what did not change. Throws
 * {@link TeamDetailPatchMismatchError} when the patch was not made from this detail.
 */
export function applyTeamDetailPatch(base: TeamDetail, patch: TeamDetailPatch): TeamDetail {
  const liveOutputs = new Map((patch.liveOutputs ?? []).map((entry) => [entry.agentId, entry]));
  let workers = base.workers;
  if (patch.workers !== undefined || liveOutputs.size > 0) {
    const baseById = new Map(base.workers.map((worker) => [worker.id, worker]));
    const upserts = new Map((patch.workers?.upserts ?? []).map((worker) => [worker.id, worker]));
    const order = patch.workers?.order ?? base.workers.map(({ id }) => id);
    if (patch.workers?.order === undefined && [...upserts.keys()].some((id) => !baseById.has(id)))
      throw new TeamDetailPatchMismatchError('A new Worker arrived without the new order');
    const ids = new Set(order);
    if ([...liveOutputs.keys()].some((id) => !ids.has(id)))
      throw new TeamDetailPatchMismatchError('Live output for an unknown Worker');
    workers = order.map((id) => {
      const previous = baseById.get(id);
      const upsert = upserts.get(id);
      const live = liveOutputs.get(id);
      if (upsert === undefined && live === undefined) {
        if (previous === undefined) throw new TeamDetailPatchMismatchError(`Unknown Worker ${id}`);
        return previous;
      }
      const fields = upsert ?? previous;
      if (fields === undefined) throw new TeamDetailPatchMismatchError(`Unknown Worker ${id}`);
      const previousOutput = previous?.liveOutput ?? '';
      if (live !== undefined && live.drop > previousOutput.length)
        throw new TeamDetailPatchMismatchError('Live output is shorter than the patch expects');
      const liveOutput =
        live === undefined ? previousOutput : previousOutput.slice(live.drop) + live.append;
      return { ...fields, liveOutput };
    });
  }
  return {
    team: patch.team ?? base.team,
    workers,
    messages: applyCollection(base.messages, patch.messages),
    executions: applyCollection(base.executions, patch.executions),
    missions: applyCollection(base.missions, patch.missions),
    activities: applyCollection(base.activities, patch.activities),
    budgets: patch.budgets ?? base.budgets,
  };
}

// Canvas view persistence (Slice 6.1, FR-CAN-02): per-Task camera + Worker node layout, saved with
// an optimistic-concurrency revision. Bounds mirror useCamera.ts's MIN_SCALE/MAX_SCALE and a
// generous world-coordinate range — wide enough for any reachable pan/drag, narrow enough to
// reject garbage.
const canvasWorldCoordinateSchema = z.number().finite().min(-20_000).max(20_000);
export const canvasCameraSchema = z
  .object({
    x: canvasWorldCoordinateSchema,
    y: canvasWorldCoordinateSchema,
    scale: z.number().finite().min(0.04).max(1.6),
  })
  .strict();
export type CanvasCamera = z.infer<typeof canvasCameraSchema>;

export const canvasNodePositionSchema = z
  .object({ x: canvasWorldCoordinateSchema, y: canvasWorldCoordinateSchema })
  .strict();
export type CanvasNodePosition = z.infer<typeof canvasNodePositionSchema>;

// A Team has no headcount cap (Managers hire their own Workers — a Leader + 3 Managers + 27 Workers
// org is an ordinary Team), and the Canvas saves a position for every card it has ever placed, so
// this is a sanity bound on the payload, not a domain limit. 128 worst-case entries (uuid key,
// unrounded drag coordinates, ~90 bytes each) stay well inside persistence's 16 KiB
// CANVAS_VIEW_MAX_SERIALIZED_BYTES.
export const CANVAS_NODE_POSITIONS_MAX_ENTRIES = 128;
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

export const IMAGE_ATTACHMENT_MAX_COUNT = 4;
export const IMAGE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_ATTACHMENT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const imageAttachmentMimeTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp']);
export type ImageAttachmentMimeType = z.infer<typeof imageAttachmentMimeTypeSchema>;
export const imageAttachmentMetadataSchema = z
  .object({
    id: idSchema,
    fileName: z.string().min(1).max(255),
    mimeType: imageAttachmentMimeTypeSchema,
    byteLength: z.number().int().min(1).max(IMAGE_ATTACHMENT_MAX_BYTES),
    createdAt: timestampSchema,
  })
  .strict();
export type ImageAttachmentMetadata = z.infer<typeof imageAttachmentMetadataSchema>;
export const imageAttachmentMetadataListSchema = z
  .array(imageAttachmentMetadataSchema)
  .max(IMAGE_ATTACHMENT_MAX_COUNT)
  .superRefine((attachments, context) => {
    if (new Set(attachments.map(({ id }) => id)).size !== attachments.length)
      context.addIssue({ code: 'custom', message: 'Attachment IDs must be unique' });
    const total = attachments.reduce((sum, attachment) => sum + attachment.byteLength, 0);
    if (total > IMAGE_ATTACHMENT_MAX_TOTAL_BYTES)
      context.addIssue({ code: 'custom', message: 'Attachment bytes exceed the aggregate limit' });
  });
export const imageAttachmentCapabilitySchema = z
  .object({
    status: z.enum(['pending', 'supported', 'unsupported']),
    reason: z.string().min(1).max(500).nullable(),
    selectionIdentity: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type ImageAttachmentCapability = z.infer<typeof imageAttachmentCapabilitySchema>;
export const imageAttachmentRemoveInputSchema = z
  .object({ taskId: idSchema, attachmentId: idSchema })
  .strict();
export const imageAttachmentPreviewInputSchema = z
  .object({ taskId: idSchema, attachmentId: idSchema })
  .strict();
/** Longest edge of the Composer thumbnail Main renders for a draft image. */
export const IMAGE_ATTACHMENT_PREVIEW_MAX_EDGE = 320;
export const imageAttachmentPreviewSchema = z
  .object({
    id: idSchema,
    mimeType: z.literal('image/webp'),
    width: z.number().int().min(1).max(IMAGE_ATTACHMENT_PREVIEW_MAX_EDGE),
    height: z.number().int().min(1).max(IMAGE_ATTACHMENT_PREVIEW_MAX_EDGE),
    /** base64 of a downscaled copy. The renderer turns this into a `data:` URL, so showing a
     * thumbnail can neither read the filesystem nor issue a request (same rule as generated
     * images). Full-size bytes never leave Main. */
    base64: z.string().min(1).max(2_000_000),
  })
  .strict();
export type ImageAttachmentPreview = z.infer<typeof imageAttachmentPreviewSchema>;
export const imageAttachmentIdsSchema = z
  .array(idSchema)
  .max(IMAGE_ATTACHMENT_MAX_COUNT)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', message: 'Attachment IDs must be unique' });
  });

export const chatMessageSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    turnId: idSchema.nullable(),
    author: z.enum(['user', 'assistant', 'system']),
    content: z.string().max(1_000_000),
    workContent: z.string().max(1_000_000).nullable().optional(),
    attachments: imageAttachmentMetadataListSchema.default([]),
    createdAt: timestampSchema,
  })
  .strict();
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const turnStageSchema = z.enum(['understanding', 'planning', 'executing', 'synthesizing']);
export type TurnStage = z.infer<typeof turnStageSchema>;

export const skillSourceSchema = z.enum(['builtin', 'created', 'agents', 'claude']);
export const skillKindSchema = z.enum(['chat', 'team']);
export const skillProfileSchema = z.enum(['portable', 'codex-native', 'claude-native']);
export const skillRuntimeSupportSchema = z.enum(['full', 'portable', 'blocked']);
export const skillActivationPolicySchema = z.enum(['manual', 'auto-allowed']);
export const skillCompatibilityReportSchema = z
  .object({
    profile: skillProfileSchema,
    runtimeSupport: z
      .object({
        codex: skillRuntimeSupportSchema,
        claude: skillRuntimeSupportSchema,
        grok: skillRuntimeSupportSchema.default('blocked'),
        provider: skillRuntimeSupportSchema,
      })
      .strict(),
    features: z.array(z.string().min(1).max(100)).max(64),
    requestedTools: z.array(z.string().min(1).max(256)).max(64),
    warnings: z.array(z.string().min(1).max(1_024)).max(256),
    blockers: z.array(z.string().min(1).max(1_024)).max(256),
    requiresConversion: z.boolean(),
    nativeModeConsentRequired: z.boolean(),
  })
  .strict();
export const skillIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const skillDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const skillRefSchema = z
  .object({
    skillId: skillIdSchema,
    source: skillSourceSchema,
    digest: skillDigestSchema,
  })
  .strict();
export const turnSkillSelectionSchema = z
  .object({
    kind: skillKindSchema,
    ref: skillRefSchema,
    arguments: z.string().max(8_000).optional(),
  })
  .strict();
export const turnSkillSelectionsSchema = z
  .array(turnSkillSelectionSchema)
  .max(6)
  .superRefine((selections, context) => {
    const refs = new Set<string>();
    let chatCount = 0;
    let teamCount = 0;
    for (const selection of selections) {
      const key = `${selection.ref.source}:${selection.ref.skillId}:${selection.ref.digest}`;
      if (refs.has(key))
        context.addIssue({
          code: 'custom',
          message: '同じSkillを複数回選択できません',
        });
      refs.add(key);
      if (selection.kind === 'chat') chatCount += 1;
      else teamCount += 1;
    }
    if (chatCount > 5) context.addIssue({ code: 'custom', message: 'Chat Skillは最大5件です' });
    if (teamCount > 1) context.addIssue({ code: 'custom', message: 'Team Skillは最大1件です' });
  });
export const skillDraftFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(500)
      .refine(isSafeSkillDraftPath, 'Skill Draftのファイルパスが安全ではありません'),
    content: z.string().max(1024 * 1024),
  })
  .strict();
export const skillDraftSchema = z
  .object({
    id: idSchema,
    kind: skillKindSchema,
    skillId: skillIdSchema,
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2_000),
    digest: skillDigestSchema,
    files: z.array(skillDraftFileSchema).min(1).max(256),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export const skillDraftCreateInputSchema = z
  .object({
    kind: skillKindSchema,
    skillId: skillIdSchema,
    files: z.array(skillDraftFileSchema).min(1).max(256),
  })
  .strict();
/**
 * LLM-facing subset of skillDraftCreateInputSchema.
 *
 * Keep this JSON Schema no stricter than the Zod contract above. Safe path
 * traversal checks remain server-side because this supported schema subset
 * cannot express isSafeSkillDraftPath.
 */
export const SKILL_DRAFT_CREATE_INPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['chat', 'team'] },
    skillId: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
    },
    files: {
      type: 'array',
      minItems: 1,
      maxItems: 256,
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 500 },
          content: { type: 'string', maxLength: 1024 * 1024 },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  required: ['kind', 'skillId', 'files'],
  additionalProperties: false,
} as const;
export const skillDraftInstallInputSchema = z
  .object({
    draftId: idSchema,
    expectedDigest: skillDigestSchema,
    confirmed: z.literal(true),
  })
  .strict();
export const skillDraftIdInputSchema = z.object({ draftId: idSchema }).strict();
export const createdSkillMutationInputSchema = z
  .object({ skillId: skillIdSchema, digest: skillDigestSchema })
  .strict();
export const createdSkillEnabledInputSchema = createdSkillMutationInputSchema
  .extend({ enabled: z.boolean() })
  .strict();
export const skillExportInputSchema = createdSkillMutationInputSchema
  .extend({ format: z.enum(['original', 'portable']).default('original') })
  .strict();
export const skillActivationPolicyInputSchema = z
  .object({ ref: skillRefSchema, policy: skillActivationPolicySchema })
  .strict();
export type SkillDraftFile = z.infer<typeof skillDraftFileSchema>;
export type SkillDraft = z.infer<typeof skillDraftSchema>;
export type SkillDraftCreateInput = z.infer<typeof skillDraftCreateInputSchema>;
export type SkillProfile = z.infer<typeof skillProfileSchema>;
export type SkillRuntimeSupport = z.infer<typeof skillRuntimeSupportSchema>;
export type SkillActivationPolicy = z.infer<typeof skillActivationPolicySchema>;
export type SkillCompatibilityReport = z.infer<typeof skillCompatibilityReportSchema>;

export const queuedInputSchema = z
  .object({
    ordinal: z.number().int().positive(),
    text: taskTextSchema,
    skills: turnSkillSelectionsSchema.optional(),
  })
  .strict();
export type QueuedInput = z.infer<typeof queuedInputSchema>;

export const contextUsageSchema = z
  .object({
    usedTokens: z.number().int().nonnegative(),
    hardCapTokens: z.number().int().positive(),
    projectTokens: z.number().int().nonnegative().default(0),
    fragments: z.array(
      z
        .object({
          source: z.enum(['system', 'history', 'goal', 'compaction', 'background', 'skill']),
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

export const rootedPathSchema = z
  .object({
    /** Missing on records written before multi-root support; interpreted as the legacy Primary. */
    rootId: idSchema.default('legacy-primary'),
    rootLabel: z.string().min(1).max(200).default('Workspace'),
    path: z.string().min(1).max(4_096),
  })
  .strict();
export type RootedPath = z.infer<typeof rootedPathSchema>;

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
    rootId: idSchema.default('legacy-primary'),
    rootLabel: z.string().min(1).max(200).default('Workspace'),
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
    rootId: idSchema.default('legacy-primary'),
    rootLabel: z.string().min(1).max(200).default('Workspace'),
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
    /** Workspace root that owns this path. Legacy single-root callers resolve to the Primary. */
    rootId: idSchema.default('legacy-primary'),
    path: z.string().min(1).max(1024),
    /** The complete file, present only when `editable` is true. */
    text: z.string().max(2_097_152),
    /** sha256 of the bytes on disk at the moment of reading. */
    digest: digestSchema,
    editable: z.boolean(),
    /** Why not, when `editable` is false. Shown to the user rather than a generic failure. */
    reason: z
      .enum(['too_large', 'binary', 'not_a_file', 'outside_workspace', 'recovery_required'])
      .nullable(),
  })
  .strict();
export type FileOpenResult = z.infer<typeof fileOpenResultSchema>;

export const fileSaveInputSchema = z
  .object({
    taskId: idSchema,
    /** Missing on operations created before multi-root support; resolves to the current Primary. */
    rootId: idSchema.default('legacy-primary'),
    path: z.string().min(1).max(1024),
    text: z.string().max(2_097_152),
    /** The digest the editor started from. A mismatch means someone else wrote the file since. */
    baseDigest: digestSchema,
  })
  .strict();

/**
 * `conflict` is not an error, it is the mechanism: the file changed under the editor, so the
 * original on-disk version was restored and the user gets to decide. If another write landed during
 * that atomic rollback, `conflictPath` retains the displaced version instead of deleting it.
 * `refused` covers everything the app will not do at all — outside the Workspace, a symlink, not a
 * regular file, too large.
 */
export const fileSaveResultSchema = z
  .object({
    outcome: z.enum(['saved', 'conflict', 'refused']),
    /** The file's digest after a successful save, so the editor can keep editing without re-opening. */
    digest: digestSchema.nullable(),
    reason: z
      .enum(['too_large', 'binary', 'not_a_file', 'outside_workspace', 'io_error'])
      .nullable(),
    /** A retained sibling containing the version displaced by conflict rollback, when present. */
    conflictPath: z.string().min(1).max(1200).nullable().default(null),
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

export const TURN_DIFF_DISPLAY_PATH_MAX_LENGTH = 8_704;
export const turnDiffEntrySchema = z
  .object({
    ordinal: z.number().int().positive(),
    kind: z.enum(['add', 'mkdir', 'update', 'delete', 'rename']),
    path: z.string().min(1).max(TURN_DIFF_DISPLAY_PATH_MAX_LENGTH),
    destination: z.string().min(1).max(TURN_DIFF_DISPLAY_PATH_MAX_LENGTH).nullable(),
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
/**
 * Upper bound on live-only approval detail.
 *
 * Sized for the largest card a `write_stdin` approval can produce: every one of its 2,048 accepted
 * characters escaped to its longest visible form (8 characters each), plus the command line, cwd,
 * session id and digest header. Producers validate against this before an approval is created.
 */
export const APPROVAL_EPHEMERAL_EXECUTION_MAX_CHARACTERS = 20_480;

/**
 * What a desktop-control run does, as its approval card shows it (built by Main from the sealed
 * argv). Display only: no decision is taken from it, and an approval without it shows the plain
 * command card. Names come from the app being operated and are untrusted text.
 */
export const desktopActionTargetSchema = z
  .object({
    /** Whether the app and part were read from the snapshot the ref belongs to. */
    resolved: z.boolean(),
    app: z.string().min(1).max(120).optional(),
    window: z.string().min(1).max(120).optional(),
    /** The part's role, in Japanese. */
    role: z.string().min(1).max(40).optional(),
    name: z.string().min(1).max(120).optional(),
    /** The ref or window id as given, shown when the target could not be confirmed. */
    reference: z.string().min(1).max(120).optional(),
  })
  .strict();
export type DesktopActionTarget = z.infer<typeof desktopActionTargetSchema>;

export const desktopActionKindSchema = z.enum([
  'read',
  'operate',
  'input',
  'launch',
  'window',
  'close',
  'other',
]);
export const desktopActionModeSchema = z.enum(['read', 'background', 'foreground']);

export const desktopActionStepSchema = z
  .object({
    kind: desktopActionKindSchema,
    title: z.string().min(1).max(40),
    mode: desktopActionModeSchema,
    target: desktopActionTargetSchema.optional(),
    /** The text it enters, the value it selects or the keys it presses. */
    text: z.string().min(1).max(1_000).optional(),
    /** What `text` is: entered text, a selected value, keys, clipboard text or a button's name. */
    textRole: z.enum(['enter', 'select', 'keys', 'clipboard', 'button']).optional(),
  })
  .strict();
export type DesktopActionStep = z.infer<typeof desktopActionStepSchema>;

export const DESKTOP_ACTION_MAX_STEPS = 20;

export const desktopApprovalActionSchema = desktopActionStepSchema
  .extend({
    /** The operations of a batch, in order, up to the bound; `stepsOmitted` counts the rest. */
    steps: z.array(desktopActionStepSchema).max(DESKTOP_ACTION_MAX_STEPS).optional(),
    stepsOmitted: z.number().int().positive().optional(),
    /** Whether the card offers 「Task中許可」. Main refuses it anyway when this is false. */
    allowTaskGrant: z.boolean(),
    notes: z.array(z.string().min(1).max(200)).max(6),
    /** Whether the card opens its details: something could not be confirmed or shown in full. */
    openDetails: z.boolean(),
  })
  .strict();
export type DesktopApprovalAction = z.infer<typeof desktopApprovalActionSchema>;

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
    /**
     * Live-only detail for a pending approval, never written to the approval row or the persisted
     * `approval.requested` event. It carries the exact bytes a decision is being made about — the
     * characters a `write_stdin` call would send — which must reach the card in full but must not
     * survive the decision in plaintext (Issue #473). Absent on anything replayed from storage.
     *
     * A value over this bound is refused as a tool error before the approval exists. Parsing the
     * event is what delivers the card, so a payload the schema rejects would leave a Turn waiting
     * on an approval nobody can see — the producer must stay inside the bound, never discover it.
     */
    ephemeralExecution: z
      .string()
      .min(1)
      .max(APPROVAL_EPHEMERAL_EXECUTION_MAX_CHARACTERS)
      .optional(),
    /** A desktop-control run's own card (absent on every other approval and on older rows). */
    desktopAction: desktopApprovalActionSchema.optional(),
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
    userInputSelection: z.number().int().min(0).max(2).optional(),
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
      type: z.literal('skill.draft.created'),
      ...turnEventBase,
      draft: skillDraftSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('skill.activated'),
      ...turnEventBase,
      ref: skillRefSchema,
      name: z.string().min(1).max(200),
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
      rootId: idSchema.default('legacy-primary'),
      rootLabel: z.string().min(1).max(200).default('Workspace'),
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
    activatedSkills: z
      .array(
        z
          .object({ turnId: idSchema, ref: skillRefSchema, name: z.string().min(1).max(200) })
          .strict(),
      )
      .max(4_096)
      .default([]),
    latestTurnDiff: turnDiffSchema.nullable().default(null),
    /**
     * Turns that Main closed as `interrupted` when it restarted while they were still running
     * (issue #842). The Renderer marks them in the history, so a partial reply does not read as a
     * finished one once the dismissible restart notice is gone.
     */
    interruptedTurnIds: z.array(idSchema).max(4_096).default([]),
    /**
     * The Task's kept Auto decision rows — the newest 200 denials and the newest 200 others, oldest
     * first — up to `lastSeq` (issue #863). Read in the same call as the counts below and
     * `lastSeq`, so a decision recorded while the snapshot waited is in all three or in none.
     */
    autoDecisions: z.array(autoPermissionDecisionSchema).default([]),
    /**
     * Every Auto decision of the Task counted per Turn and kind, up to `lastSeq` (issue #863). The
     * list of decisions is capped, so the Timeline's per-Turn summary reads its counts from here.
     */
    autoDecisionCounts: z
      .array(
        z
          .object({
            turnId: idSchema,
            allow: z.number().int().nonnegative(),
            allowOnce: z.number().int().nonnegative(),
            deny: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .default([]),
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
  'REFERENCE_IN_USE',
  'STEER_STALE',
  'STEER_UNSUPPORTED',
  'OPERATION_CONFLICT',
  'OPERATION_IN_PROGRESS',
  'USER_CANCELED',
  'FORBIDDEN',
  'INVALID_REQUEST',
  'RUNTIME_UNAVAILABLE',
  'RUNTIME_CLI_MISSING',
  'RUNTIME_RATE_LIMIT',
  'RUNTIME_BILLING_REQUIRED',
  'RUNTIME_FAILED',
  'RUNTIME_TIMEOUT',
  'RUNTIME_STOP_UNCONFIRMED',
  'RUNTIME_PROTOCOL_ERROR',
  'INTERNAL_ERROR',
]);
export type PublicErrorCode = z.infer<typeof publicErrorCodeSchema>;

export const publicErrorSchema = z
  .object({
    code: publicErrorCodeSchema,
    userMessage: z.string().min(1).max(500),
    retryable: z.boolean(),
    retryAt: timestampSchema.optional(),
  })
  .strict();
export type PublicError = z.infer<typeof publicErrorSchema>;

export const runtimeKindSchema = z.enum(['mock', 'codex', 'claude', 'grok']);
export type RuntimeKind = z.infer<typeof runtimeKindSchema>;
export const providerRuntimeKindSchema = z.enum([
  'builtin_cli',
  'official_api',
  'openai_compatible',
  'mock',
]);
export type ProviderRuntimeKind = z.infer<typeof providerRuntimeKindSchema>;
export const providerComputeLocationSchema = z.enum(['cloud', 'local']);
export type ProviderComputeLocation = z.infer<typeof providerComputeLocationSchema>;
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
export const providerConnectionRateLimitLowerInputSchema = z
  .object({
    connectionId: connectionIdSchema,
    maxConcurrentRequests: z.number().int().positive().optional(),
    requestsPerMinute: z.number().int().positive().optional(),
    tokensPerMinute: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.maxConcurrentRequests !== undefined ||
      input.requestsPerMinute !== undefined ||
      input.tokensPerMinute !== undefined,
    { message: 'At least one Provider rate limit must be supplied' },
  );
export type ProviderConnectionRateLimitLowerInput = z.infer<
  typeof providerConnectionRateLimitLowerInputSchema
>;
export const providerConnectionSchema = z
  .object({
    id: connectionIdSchema,
    providerId: providerIdSchema,
    runtimeKind: providerRuntimeKindSchema,
    displayName: z.string().min(1).max(100),
    enabled: z.boolean(),
    /** Whether Sprint Coder may release a local Provider model after its last logical use.
     * Optional while older renderer/main builds and persisted fixtures cross the upgrade boundary. */
    automaticModelRelease: z.boolean().optional(),
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
export const providerConnectionViewSchema = providerConnectionSchema.extend({
  /** Main-derived inference location. This is deliberately not persisted with the Connection. */
  computeLocation: providerComputeLocationSchema,
});
export type ProviderConnectionView = z.infer<typeof providerConnectionViewSchema>;
export const providerConnectionModelReleaseUpdateInputSchema = z
  .object({
    connectionId: connectionIdSchema,
    automaticModelRelease: z.boolean(),
  })
  .strict();
export type ProviderConnectionModelReleaseUpdateInput = z.infer<
  typeof providerConnectionModelReleaseUpdateInputSchema
>;
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
export const orcaRouterConnectionCreateInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    apiKey: z.string().min(1).max(16_384),
  })
  .strict();
export type OrcaRouterConnectionCreateInput = z.infer<typeof orcaRouterConnectionCreateInputSchema>;
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
export type GeminiConnectionCreateInput = z.infer<typeof geminiConnectionCreateInputSchema>;
export const xAIConnectionCreateInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    apiKey: z.string().min(1).max(16_384),
  })
  .strict();
export type XAIConnectionCreateInput = z.infer<typeof xAIConnectionCreateInputSchema>;
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
    /** Explicit inference location. Optional only for compatibility with older Profile fixtures. */
    computeLocation: providerComputeLocationSchema.optional(),
    /** A bundled, declarative hint. Runtime code still applies its own fixed Ollama allow-list. */
    nativeModelLifecycle: z.literal('ollama').optional(),
    protocol: providerProfileProtocolSchema,
    modelsPath: z.string().startsWith('/').max(256).nullable(),
    curatedModels: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            displayName: z.string().min(1).max(256),
          })
          .strict(),
      )
      .max(500),
    verificationModel: z.string().min(1).max(256).nullable(),
    authentication: z
      .object({
        headerName: z.string().min(1).max(128),
        scheme: z.string().max(64),
      })
      .strict(),
    requiredCredentialFields: z.array(z.enum(['api_key', 'account_id'])).max(8),
    errorOverrides: z.array(providerProfileErrorOverrideSchema).max(32),
    sourceReference: z.string().url().max(2_048),
    reviewedAt: timestampSchema,
  })
  .strict()
  .superRefine((profile, context) => {
    if (
      profile.modelsPath === null &&
      (profile.curatedModels.length === 0 || profile.verificationModel === null)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A curated Profile requires models and a verification model',
      });
  });
export type ProviderProfile = z.infer<typeof providerProfileSchema>;
export const providerProfileConnectionCreateInputSchema = z
  .object({
    profileId: providerIdSchema,
    displayName: z.string().trim().min(1).max(100),
    apiKey: z.string().min(1).max(16_384).optional(),
    baseUrl: z.string().url().max(2_048).optional(),
    accountId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type ProviderProfileConnectionCreateInput = z.infer<
  typeof providerProfileConnectionCreateInputSchema
>;
export const capabilitySourceSchema = z.enum([
  'provider_api',
  'runtime_metadata',
  'official_curated',
  'unknown',
]);
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
    connectionDisplayName: z.string().min(1).max(100).optional(),
    providerId: providerIdSchema,
    /** Stable provider/gateway name supplied by Main. Optional across mixed-version boundaries. */
    providerDisplayName: z.string().min(1).max(100).optional(),
    modelAuthor: catalogValueSchema(z.string().min(1).max(128)).optional(),
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
      providerMetadata: z
        .object({
          geminiThoughtSignature: z.string().min(1).max(65_536).optional(),
          geminiCallIdPresent: z.boolean().optional(),
        })
        .strict()
        .optional(),
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
export const providerMessageToolCallSchema = z
  .object({
    callId: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    input: z.json(),
    providerMetadata: z
      .object({
        geminiThoughtSignature: z.string().min(1).max(65_536).optional(),
        geminiCallIdPresent: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ProviderMessageToolCall = z.infer<typeof providerMessageToolCallSchema>;
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
            toolName: z.string().min(1).max(256).optional(),
            toolCalls: z.array(providerMessageToolCallSchema).max(128).optional(),
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
            if (message.role !== 'tool' && message.toolName !== undefined)
              context.addIssue({
                code: 'custom',
                path: ['toolName'],
                message: 'toolName is only valid for tool result messages',
              });
            if (
              message.role !== 'assistant' &&
              message.toolCalls !== undefined &&
              message.toolCalls.length > 0
            )
              context.addIssue({
                code: 'custom',
                path: ['toolCalls'],
                message: 'toolCalls are only valid on assistant messages',
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
    toolChoice: z
      .union([
        z.enum(['auto', 'required']),
        z.object({ name: z.string().min(1).max(256) }).strict(),
      ])
      .optional(),
    webSearch: z.boolean().optional(),
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
 * CLI itself — app-server `model/list` carries `supportedReasoningEfforts` (each with the
 * CLI's own description text) and `defaultReasoningEffort` per model. So this is deliberately an
 * open string rather than an enum: the authority is the CLI, not this schema, and a new model
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
    // "this provider does not publish a per-model set" — Claude's discovered entries leave it off and
    // keep using `claudeEffortSchema`; Codex's `auto` sentinel leaves it off because the concrete
    // model it resolves to is chosen by the CLI, so nothing can be promised about its set.
    efforts: z.array(effortOptionSchema).max(16).optional(),
    // The model's own default level, used to clamp a persisted choice this model does not support
    // (switching from Sol to GPT-5.5 drops `max`/`ultra`, and keeping the old value would fail the
    // next turn outright).
    defaultEffort: effortOptionSchema.shape.id.optional(),
    // Built-in subscription runtimes do not expose the same provider model-list APIs as API-key
    // connections. Preserve the capability evidence discovered by the CLI adapter so Main does
    // not have to discard it and turn every subscription model into "unknown".
    capabilities: z
      .object({
        toolCalling: catalogValueSchema(z.boolean()),
        structuredOutput: catalogValueSchema(z.boolean()),
        multimodalInput: catalogValueSchema(z.boolean()),
        reasoning: catalogValueSchema(z.boolean()),
      })
      .strict()
      .optional(),
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
export const runtimeReadinessSchema = z.enum(['ready', 'authentication_required', 'unavailable']);
export type RuntimeReadiness = z.infer<typeof runtimeReadinessSchema>;
export const modelFallbackNoticeSchema = z
  .object({
    changes: z
      .array(
        z
          .object({
            runtimeKind: z.enum(['codex', 'claude', 'grok']),
            migratedCount: z.number().int().min(0).max(1_000_000),
            resetCount: z.number().int().min(0).max(1_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();
export type ModelFallbackNotice = z.infer<typeof modelFallbackNoticeSchema>;
export const updateErrorCategorySchema = z.enum([
  'network',
  'release_feed',
  'decryption',
  'filesystem',
  'updater',
  'unknown',
]);
export type UpdateErrorCategory = z.infer<typeof updateErrorCategorySchema>;
export const updateHealthSchema = z
  .object({
    successfulChecks: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    failedChecks: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    consecutiveFailures: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    lastSuccessAt: z.string().datetime().nullable(),
    lastFailureAt: z.string().datetime().nullable(),
    lastErrorCategory: updateErrorCategorySchema.nullable(),
  })
  .strict();
export type UpdateHealth = z.infer<typeof updateHealthSchema>;
export const updateCheckResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('up_to_date') }).strict(),
  z
    .object({
      status: z.literal('update_available'),
      version: z.string().min(1).max(64),
    })
    .strict(),
  z.object({ status: z.literal('already_checking') }).strict(),
  z.object({ status: z.literal('unsupported') }).strict(),
  z
    .object({
      status: z.literal('failed'),
      errorCategory: updateErrorCategorySchema,
    })
    .strict(),
]);
export type UpdateCheckResult = z.infer<typeof updateCheckResultSchema>;
export const resolvedCliCommandSchema = z
  .object({
    source: z.enum([
      'explicit',
      'path',
      'user-local',
      'npm',
      'desktop-direct',
      'desktop-versioned',
      'fallback',
    ]),
    executable: z.string().min(1).max(2_048),
    version: z.string().min(1).max(128),
    compatibility: z.enum(['verified', 'compatible', 'untested', 'unsupported']),
    capabilities: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u)).max(32),
  })
  .strict();
export type ResolvedCliCommand = z.infer<typeof resolvedCliCommandSchema>;
export const runtimeSettingsSchema = z
  .object({
    kind: runtimeKindSchema,
    codexAvailable: z.boolean(),
    codexReadiness: runtimeReadinessSchema,
    // Additive parallel availability field for the Claude CLI runtime (Slice 3.4). Existing
    // `codexAvailable` consumers are unaffected; `models`/`model` reflect the currently selected
    // Runtime kind's own capability list (Codex's or Claude's), per the Main-side probe.
    claudeAvailable: z.boolean(),
    claudeReadiness: runtimeReadinessSchema,
    grokAvailable: z.boolean().default(false),
    grokReadiness: runtimeReadinessSchema.default('unavailable'),
    codexCli: resolvedCliCommandSchema.nullable().default(null),
    claudeCli: resolvedCliCommandSchema.nullable().default(null),
    grokCli: resolvedCliCommandSchema.nullable().default(null),
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
    modelFallbackNotice: modelFallbackNoticeSchema.nullable(),
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
export const teamModelResearchSettingsSchema = z
  .object({
    researchBeforeHiring: z.boolean(),
  })
  .strict();
export type TeamModelResearchSettings = z.infer<typeof teamModelResearchSettingsSchema>;
export const teamModelResearchSettingsSetInputSchema = teamModelResearchSettingsSchema;
/** How many Worker executions may run at once across the whole app (each Team is also held to
 * its own policy). Applies to executions admitted after the change, without a restart. */
export const teamConcurrencySettingsSchema = z
  .object({
    maxConcurrentExecutions: teamConcurrencyLimitSchema,
  })
  .strict();
export type TeamConcurrencySettings = z.infer<typeof teamConcurrencySettingsSchema>;
export const teamConcurrencySettingsSetInputSchema = teamConcurrencySettingsSchema;
export const teamModelSelectionGuidanceSchema = z
  .object({
    guidance: z.string().max(4000),
  })
  .strict();
export type TeamModelSelectionGuidance = z.infer<typeof teamModelSelectionGuidanceSchema>;
export const teamModelSelectionGuidanceSetInputSchema = teamModelSelectionGuidanceSchema;
export const sprintCoderPrePromptSchema = z
  .object({
    prompt: z.string().max(8000),
  })
  .strict();
export type SprintCoderPrePrompt = z.infer<typeof sprintCoderPrePromptSchema>;
export const sprintCoderPrePromptSetInputSchema = sprintCoderPrePromptSchema;
export const teamModelIdentitySchema = z
  .object({
    connectionId: connectionIdSchema,
    providerId: providerIdSchema,
    modelId: z.string().min(1).max(256),
  })
  .strict();
export type TeamModelIdentity = z.infer<typeof teamModelIdentitySchema>;
export const teamModelRestrictionSchema = z
  .object({
    mode: z.enum(['all', 'selected']),
    allowedModels: z.array(teamModelIdentitySchema).max(512),
  })
  .strict()
  .superRefine(({ mode, allowedModels }, context) => {
    if (mode === 'selected' && allowedModels.length === 0)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedModels'],
        message: 'Select at least one Team model',
      });
    const identities = new Set<string>();
    for (const [index, model] of allowedModels.entries()) {
      const key = `${model.connectionId}\0${model.providerId}\0${model.modelId}`;
      if (identities.has(key))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allowedModels', index],
          message: 'Duplicate Team model identity',
        });
      identities.add(key);
    }
  });
export type TeamModelRestriction = z.infer<typeof teamModelRestrictionSchema>;
export const teamModelSettingsSchema = z
  .object({
    restriction: teamModelRestrictionSchema,
    availableModels: z.array(providerModelSchema).max(512),
  })
  .strict();
export type TeamModelSettings = z.infer<typeof teamModelSettingsSchema>;
export const teamModelRestrictionSetInputSchema = teamModelRestrictionSchema;
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
export const modelCatalogAccessTypeSchema = z.enum(['subscription', 'api', 'local']);
export type ModelCatalogAccessType = z.infer<typeof modelCatalogAccessTypeSchema>;
export const modelCatalogQueryInputSchema = z
  .object({
    taskId: idSchema,
    text: z.string().max(200).default(''),
    connectionIds: z.array(connectionIdSchema).max(32).default([]),
    providerIds: z.array(providerIdSchema).max(32).default([]),
    accessTypes: z.array(modelCatalogAccessTypeSchema).max(3).default([]),
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

export const graphRenderInputSchema = z
  .object({ taskId: idSchema, diagram: z.record(z.string(), z.unknown()) })
  .strict();
export const graphGetInputSchema = z.object({ taskId: idSchema }).strict();
export const graphCancelInputSchema = graphGetInputSchema
  .extend({ generationId: z.string().uuid().optional() })
  .strict();
export const graphReleaseInputSchema = graphGetInputSchema
  .extend({ instanceId: z.string().uuid() })
  .strict();
export const graphElementIdSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u);
export const graphSourceRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('read'),
      tokenId: z.string().uuid(),
      elementKind: z.enum(['node', 'edge']),
      elementId: graphElementIdSchema,
      lineStart: z.number().int().positive(),
      lineEnd: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal('saved'), sourceId: z.string().uuid() }).strict(),
]);
export type GraphSourceRequest = z.infer<typeof graphSourceRequestSchema>;
export const graphSourceRefSchema = z
  .object({
    id: z.string().uuid(),
    elementKind: z.enum(['node', 'edge']),
    elementId: graphElementIdSchema,
    rootId: idSchema,
    rootIdentityDigest: digestSchema,
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) =>
          !value.startsWith('/') &&
          !value.includes('\\') &&
          !value.includes('\0') &&
          value.split('/').every((part) => part !== '..' && part !== '.' && part.length > 0),
      ),
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    contentHash: digestSchema,
    excerptHash: digestSchema,
    excerpt: z.string().max(16384),
    observedAt: z.string().datetime(),
  })
  .strict()
  .refine((value) => value.lineStart <= value.lineEnd);
export type GraphSourceRef = z.infer<typeof graphSourceRefSchema>;
export const graphSourcesInputSchema = z
  .object({
    taskId: idSchema,
    renderRevision: z.number().int().positive(),
    elementKind: z.enum(['node', 'edge']),
    elementId: graphElementIdSchema,
  })
  .strict();
export const graphSourcePreviewInputSchema = z
  .object({
    taskId: idSchema,
    renderRevision: z.number().int().positive(),
    sourceId: z.string().uuid(),
  })
  .strict();
export const graphSourcePreviewSchema = z
  .object({
    source: graphSourceRefSchema,
    status: z.enum(['current', 'changed', 'root_changed', 'missing', 'unavailable']),
    currentExcerpt: z.string().max(16384).nullable(),
    truncated: z.boolean(),
  })
  .strict();
export type GraphSourcePreview = z.infer<typeof graphSourcePreviewSchema>;
export const graphSourceCheckInputSchema = z
  .object({
    taskId: idSchema,
    renderRevision: z.number().int().positive(),
    instanceId: z.string().uuid(),
  })
  .strict();
export type GraphSourceCheckInput = z.infer<typeof graphSourceCheckInputSchema>;
export const graphSourceStatusSchema = graphSourceCheckInputSchema
  .extend({
    sequence: z.number().int().positive(),
    phase: z.enum(['checking', 'checked']),
    checkedAt: z.string().datetime().nullable(),
    monitoring: z.boolean(),
    sources: z
      .array(
        z
          .object({ sourceId: z.string().uuid(), status: graphSourcePreviewSchema.shape.status })
          .strict(),
      )
      .max(64),
  })
  .strict();
export type GraphSourceStatus = z.infer<typeof graphSourceStatusSchema>;
export const graphMissionResumeInputSchema = graphSourceCheckInputSchema
  .extend({
    missionId: idSchema,
    stepKey: graphMissionKeySchema,
    generation: z.number().int().positive(),
    workspaceReviewDigest: digestSchema.optional(),
  })
  .strict();
export type GraphMissionResumeInput = z.infer<typeof graphMissionResumeInputSchema>;
export const graphWorkspaceReviewSchema = z
  .object({
    digest: digestSchema,
    files: z
      .array(
        z
          .object({
            repository: z.number().int().min(1).max(16),
            path: z.string().min(1).max(4096),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
export type GraphWorkspaceReview = z.infer<typeof graphWorkspaceReviewSchema>;
export const graphMissionUpdateInputSchema = graphSourceCheckInputSchema
  .extend({
    missionId: idSchema,
    expectedSemanticRevision: z.number().int().positive(),
  })
  .strict();
export type GraphMissionUpdateInput = z.infer<typeof graphMissionUpdateInputSchema>;
export const graphMissionUpdateReviewSchema = graphMissionUpdateInputSchema
  .extend({
    requestId: z.string().uuid(),
    contextDigest: digestSchema,
    beforeRenderRevision: z.number().int().positive(),
    changedKeys: z.array(graphMissionKeySchema).max(12),
    affectedKeys: z.array(graphMissionKeySchema).max(12),
  })
  .strict();
export type GraphMissionUpdateReview = z.infer<typeof graphMissionUpdateReviewSchema>;
export const graphMissionUpdateAgreementSchema = graphMissionUpdateInputSchema
  .extend({
    requestId: z.string().uuid(),
    contextDigest: digestSchema,
  })
  .strict();
export type GraphMissionUpdateAgreement = z.infer<typeof graphMissionUpdateAgreementSchema>;
export const graphMissionStartInputSchema = graphSourceCheckInputSchema
  .extend({ contextDigest: digestSchema })
  .strict();
export type GraphMissionStartInput = z.infer<typeof graphMissionStartInputSchema>;
export const graphMissionReviewSchema = graphSourceCheckInputSchema
  .extend({
    contextDigest: digestSchema,
    checkedAt: z.string().datetime(),
    matched: z.boolean(),
    issues: z
      .array(
        z
          .object({
            stepKey: graphMissionKeySchema.nullable(),
            rootId: idSchema.nullable(),
            path: z.string().max(1024).nullable(),
            code: z.enum([
              'plan_missing',
              'team_unavailable',
              'worker_unavailable',
              'worker_busy',
              'write_denied',
              'root_unavailable',
              'root_changed',
              'path_unavailable',
              'source_changed',
              'state_changed',
            ]),
          })
          .strict(),
      )
      .max(1100),
  })
  .strict();
export type GraphMissionReview = z.infer<typeof graphMissionReviewSchema>;
export const graphAnnotationSchema = z
  .object({
    elementKind: z.enum(['node', 'edge']),
    elementId: graphElementIdSchema,
    basis: z.enum(['inferred', 'proposed']),
    rationale: z.string().min(1).max(1000),
  })
  .strict();
export type GraphAnnotation = z.infer<typeof graphAnnotationSchema>;
export const graphDocumentSchema = z
  .object({
    id: z.string().uuid(),
    taskId: idSchema,
    kind: z.enum(['architecture', 'workflow']),
    title: z.string().min(1).max(160),
    semanticRevision: z.number().int().positive(),
    renderRevision: z.number().int().positive(),
    semanticDigest: digestSchema,
    diagram: z.record(z.string(), z.unknown()),
    sources: z.array(graphSourceRefSchema).max(64).default([]),
    annotations: z.array(graphAnnotationSchema).max(256).default([]),
    missionPlan: graphMissionPlanSchema.nullable().default(null),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type GraphDocument = z.infer<typeof graphDocumentSchema>;
export const graphGenerationSchema = z
  .object({
    id: z.string().uuid(),
    taskId: idSchema,
    sequence: z.number().int().positive(),
    state: z.enum(['running', 'canceling', 'succeeded', 'failed', 'canceled', 'interrupted']),
    proposedTitle: z.string().min(1).max(160).nullable(),
    baseRenderRevision: z.number().int().nonnegative(),
    resultRenderRevision: z.number().int().positive().nullable(),
    failureStage: z.enum(['input', 'engine', 'render', 'check', 'publish']).nullable(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const active = value.state === 'running' || value.state === 'canceling';
    if (
      active !== (value.finishedAt === null) ||
      (value.state === 'succeeded') !== (value.resultRenderRevision !== null) ||
      (value.state === 'failed') !== (value.failureStage !== null)
    )
      context.addIssue({ code: 'custom', message: 'Inconsistent graph generation state' });
  });
export type GraphGeneration = z.infer<typeof graphGenerationSchema>;
export const graphHistoryInputSchema = graphGetInputSchema
  .extend({
    beforeRenderRevision: z.number().int().positive().optional(),
  })
  .strict();
export const graphVersionSummarySchema = graphDocumentSchema.pick({
  id: true,
  taskId: true,
  kind: true,
  title: true,
  semanticRevision: true,
  renderRevision: true,
  updatedAt: true,
});
export const graphHistorySchema = z
  .object({
    versions: z.array(graphVersionSummarySchema).max(25),
    nextBeforeRenderRevision: z.number().int().positive().nullable(),
  })
  .strict();
export const graphCompareInputSchema = z
  .object({
    taskId: idSchema,
    beforeRenderRevision: z.number().int().positive(),
    afterRenderRevision: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.beforeRenderRevision < value.afterRenderRevision);
export const graphDiffSchema = z
  .object({
    graphId: z.string().uuid(),
    taskId: idSchema,
    before: graphVersionSummarySchema,
    after: graphVersionSummarySchema,
    contentChanged: z.boolean(),
    presentationOnly: z.boolean(),
    changes: z
      .array(
        z
          .object({
            kind: z.enum([
              'node',
              'edge',
              'lane',
              'phase',
              'group',
              'diagram',
              'source',
              'annotation',
              'mission',
              'step',
            ]),
            id: z.string().max(4000).nullable(),
            action: z.enum(['added', 'removed', 'changed']),
            beforeLabel: z.string().max(4000).nullable(),
            afterLabel: z.string().max(4000).nullable(),
            fields: z
              .array(
                z
                  .object({
                    name: z.string().max(256),
                    before: z.string().max(262144).nullable(),
                    after: z.string().max(262144).nullable(),
                  })
                  .strict(),
              )
              .max(64),
          })
          .strict(),
      )
      .max(2725),
  })
  .strict();
export type GraphHistoryInput = z.infer<typeof graphHistoryInputSchema>;
export type GraphHistory = z.infer<typeof graphHistorySchema>;
export type GraphVersionSummary = z.infer<typeof graphVersionSummarySchema>;
export type GraphCompareInput = z.infer<typeof graphCompareInputSchema>;
export type GraphDiff = z.infer<typeof graphDiffSchema>;
export const graphViewSchema = z
  .object({
    id: z.string().uuid(),
    taskId: idSchema,
    revision: z.number().int().positive(),
    renderRevision: z.number().int().positive(),
    title: z.string().min(1).max(160),
    kind: z.enum(['architecture', 'workflow']),
    digest: digestSchema,
    instanceId: z.string().uuid(),
    viewRevision: z.number().int().positive(),
    artifactUrl: z.string().regex(/^app:\/\/graph\/[a-f0-9-]{36}\?theme=dark$/u),
    nodeIds: z.array(graphElementIdSchema).min(1).max(64),
    edgeIds: z.array(graphElementIdSchema).max(192),
    annotations: z.array(graphAnnotationSchema).max(256).optional(),
    missionPlan: graphMissionPlanSchema.nullable().optional(),
  })
  .strict();
export type GraphView = z.infer<typeof graphViewSchema>;

/**
 * Reserved fenced-code language for the anchor Main appends to an assistant reply at the moment a
 * graph tool rendered a diagram. The Renderer turns that block into an inline graph card at that
 * position in the reply; it is app-inserted, never model-written.
 */
export const GRAPH_INLINE_FENCE_LANG = 'sprint-graph';
export const graphInlineReferenceSchema = z
  .object({
    graphId: z.string().uuid(),
    revision: z.number().int().positive(),
    renderRevision: z.number().int().positive(),
    title: z.string().min(1).max(160),
    kind: z.enum(['architecture', 'workflow']),
    nodeCount: z.number().int().nonnegative().max(64),
    edgeCount: z.number().int().nonnegative().max(192),
  })
  .strict();
export type GraphInlineReference = z.infer<typeof graphInlineReferenceSchema>;
export function graphInlineReference(view: GraphView): GraphInlineReference {
  return {
    graphId: view.id,
    revision: view.revision,
    renderRevision: view.renderRevision,
    title: view.title,
    kind: view.kind,
    nodeCount: view.nodeIds.length,
    edgeCount: view.edgeIds.length,
  };
}
/**
 * The anchor as appended to the assistant message: its own paragraph, so the surrounding text keeps
 * its Markdown structure, with a fence longer than any backtick run inside the JSON so a title can
 * never close it early.
 */
export function formatGraphInlineMarker(reference: GraphInlineReference): string {
  const body = JSON.stringify(graphInlineReferenceSchema.parse(reference));
  const longestRun = Math.max(0, ...[...body.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `\n\n${fence}${GRAPH_INLINE_FENCE_LANG}\n${body}\n${fence}\n\n`;
}
/** Parses one anchor block's body; anything that is not a well-formed reference renders as code. */
export function parseGraphInlineReference(source: string): GraphInlineReference | null {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  const parsed = graphInlineReferenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export type GraphRenderInput = z.infer<typeof graphRenderInputSchema>;
export const graphProposeToolInputSchema = z
  .object({
    diagram: z.record(z.string(), z.unknown()),
    expectedRenderRevision: z.number().int().nonnegative(),
    sources: z.array(graphSourceRequestSchema).max(64).default([]),
    annotations: z.array(graphAnnotationSchema).max(256).default([]),
    missionPlan: graphMissionPlanSchema.nullable().default(null),
  })
  .strict();
export const graphReadToolInputSchema = z
  .object({ renderRevision: z.number().int().positive().optional() })
  .strict();
export const GRAPH_PROPOSE_TOOL_INPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    diagram: { type: 'object' },
    expectedRenderRevision: { type: 'integer', minimum: 0 },
    missionPlan: {
      allOf: [{ if: { not: { type: 'null' } }, then: GRAPH_MISSION_PLAN_JSON_SCHEMA }],
    },
    annotations: {
      type: 'array',
      maxItems: 256,
      items: {
        type: 'object',
        properties: {
          elementKind: { enum: ['node', 'edge'] },
          elementId: { type: 'string' },
          basis: { enum: ['inferred', 'proposed'] },
          rationale: { type: 'string', minLength: 1, maxLength: 1000 },
        },
        required: ['elementKind', 'elementId', 'basis', 'rationale'],
        additionalProperties: false,
      },
    },
    sources: {
      type: 'array',
      maxItems: 64,
      items: {
        type: 'object',
        properties: {
          kind: { enum: ['read', 'saved'] },
          tokenId: { type: 'string' },
          sourceId: { type: 'string' },
          elementKind: { enum: ['node', 'edge'] },
          elementId: { type: 'string' },
          lineStart: { type: 'integer', minimum: 1 },
          lineEnd: { type: 'integer', minimum: 1 },
        },
        required: ['kind'],
        additionalProperties: false,
        allOf: [
          {
            if: { properties: { kind: { const: 'read' } }, required: ['kind'] },
            then: {
              required: ['tokenId', 'elementKind', 'elementId', 'lineStart', 'lineEnd'],
              not: { required: ['sourceId'] },
            },
          },
          {
            if: { properties: { kind: { const: 'saved' } }, required: ['kind'] },
            then: {
              required: ['sourceId'],
              allOf: [
                { not: { required: ['tokenId'] } },
                { not: { required: ['elementKind'] } },
                { not: { required: ['elementId'] } },
                { not: { required: ['lineStart'] } },
                { not: { required: ['lineEnd'] } },
              ],
            },
          },
        ],
      },
    },
  },
  required: ['diagram', 'expectedRenderRevision'],
  additionalProperties: false,
} as const;
export const GRAPH_READ_TOOL_INPUT_JSON_SCHEMA = {
  type: 'object',
  properties: { renderRevision: { type: 'integer', minimum: 1 } },
  additionalProperties: false,
} as const;
export const graphSelectionSchema = z
  .object({
    type: z.literal('sprint-graph-selection'),
    instanceId: z.string().uuid(),
    graphId: z.string().uuid(),
    revision: z.number().int().positive(),
    kind: z.enum(['node', 'edge']),
    id: graphElementIdSchema,
  })
  .strict();
export type GraphSelection = z.infer<typeof graphSelectionSchema>;
/**
 * Announced by the artifact's bridge script once its click/keyboard listeners are registered.
 * This says the frame's document can handle a click — it says nothing about whether Chromium will
 * route one to it, which is a separate problem (see graphClickSchema).
 */
export const graphReadySchema = z
  .object({
    type: z.literal('sprint-graph-ready'),
    instanceId: z.string().uuid(),
    graphId: z.string().uuid(),
    revision: z.number().int().positive(),
  })
  .strict();
export type GraphReady = z.infer<typeof graphReadySchema>;

export const GRAPH_WORKER_OUTPUT_MAX_BYTES = 256 * 1024;
/** Fixed categories only: graph text, paths and renderer messages are never diagnostics. */
export const graphWorkerDiagnosticCodeSchema = z.enum([
  'layout/constraint',
  'workflow/node-overlap',
  'workflow/unknown-node-lane',
  'workflow/invalid-node-column',
  'workflow/non-finite-node-geometry',
  'workflow/solver-budget-exhausted',
  'workflow/route-preset-conflict',
  'workflow/viewbox-capacity',
  'check/file_readable',
  'check/single_svg',
  'check/finite_svg',
  'check/orthogonal_arrows',
  'check/label_route_clearance',
  'check/relationship_crossings',
  'check/relationship_corridors',
  'check/container_border_runs',
  'check/route_rhythm',
  'check/legend_clearance',
]);
export type GraphWorkerDiagnosticCode = z.infer<typeof graphWorkerDiagnosticCodeSchema>;
/** A private Graph utility-process result; Main acknowledges receipt before the worker exits. */
export const graphWorkerResultSchema = z
  .object({
    type: z.literal('sprint-graph-result'),
    output: z.string().max(GRAPH_WORKER_OUTPUT_MAX_BYTES),
    exitCode: z.number().int().min(0).max(255),
    stderrBytes: z.number().int().min(0).max(GRAPH_WORKER_OUTPUT_MAX_BYTES),
    diagnosticCodes: z.array(graphWorkerDiagnosticCodeSchema).max(16).optional(),
  })
  .strict();
export type GraphWorkerResult = z.infer<typeof graphWorkerResultSchema>;
export const graphWorkerAckSchema = z
  .object({ type: z.literal('sprint-graph-result-ack') })
  .strict();
/**
 * A click the parent received on the graph `<iframe>` element itself, forwarded to the artifact in
 * frame-relative coordinates. The graph artifact runs out of process, and until Chromium has
 * registered that frame's hit-test region a click aimed at it is delivered to the parent renderer
 * instead — where it surfaces as a click on the iframe element, which never happens once routing
 * works. Replaying it inside the frame is what stops those clicks from being lost.
 */
export const graphClickSchema = z
  .object({
    type: z.literal('sprint-graph-click'),
    instanceId: z.string().uuid(),
    graphId: z.string().uuid(),
    revision: z.number().int().positive(),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
  })
  .strict();
export type GraphClick = z.infer<typeof graphClickSchema>;
export const emptyPayloadSchema = z.object({}).strict();
export const skillCatalogItemSchema = z
  .object({
    ref: skillRefSchema,
    kind: skillKindSchema,
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2_000),
    enabled: z.boolean(),
    activationPolicy: skillActivationPolicySchema,
    compatibility: skillCompatibilityReportSchema,
    removable: z.boolean(),
    exportable: z.boolean(),
  })
  .strict();
export const skillCatalogSchema = z
  .object({
    revision: z.string().min(1).max(128),
    items: z.array(skillCatalogItemSchema).max(4_096),
  })
  .strict();
export const taskSkillSelectionInputSchema = z
  .object({
    taskId: idSchema,
    skills: turnSkillSelectionsSchema,
  })
  .strict();
export type SkillSource = z.infer<typeof skillSourceSchema>;
export type SkillKind = z.infer<typeof skillKindSchema>;
export type SkillRef = z.infer<typeof skillRefSchema>;
export type TurnSkillSelection = z.infer<typeof turnSkillSelectionSchema>;
export type SkillCatalogItem = z.infer<typeof skillCatalogItemSchema>;
export type SkillCatalog = z.infer<typeof skillCatalogSchema>;
export const taskCreateInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    localOnly: z.boolean().optional(),
    projectId: idSchema.optional(),
  })
  .strict();
export const projectCreateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    folders: projectFolderInputsSchema.optional(),
  })
  .strict();
export const projectFoldersListInputSchema = z.object({ projectId: idSchema }).strict();
export const projectFoldersReplaceInputSchema = z
  .object({
    projectId: idSchema,
    expectedRevision: z.number().int().positive(),
    folders: projectFolderInputsSchema,
  })
  .strict();
export const projectUpdateInputSchema = z
  .object({
    projectId: idSchema,
    expectedRevision: z.number().int().positive(),
    name: z.string().trim().min(1).max(120).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((input) => input.name !== undefined || input.archived !== undefined, {
    message: 'At least one Project field must be updated',
  });
export const projectAssignTaskInputSchema = z
  .object({
    projectId: idSchema,
    taskId: idSchema,
    expectedProjectId: idSchema.nullable(),
  })
  .strict();
export const projectUnassignTaskInputSchema = z
  .object({ taskId: idSchema, expectedProjectId: idSchema.nullable() })
  .strict();
export const projectInstructionSchema = z
  .string()
  .refine((value) => new TextEncoder().encode(value).byteLength <= 16_384, {
    message: 'Project instruction must not exceed 16 KiB',
  });
export const projectGetInputSchema = z.object({ projectId: idSchema }).strict();
export const projectInstructionResultSchema = z
  .object({
    instruction: projectInstructionSchema,
    revision: z.number().int().positive(),
    contextEpoch: z.number().int().nonnegative(),
  })
  .strict();
export const projectInstructionSetInputSchema = projectGetInputSchema
  .extend({
    expectedRevision: z.number().int().positive(),
    instruction: projectInstructionSchema,
  })
  .strict();
export const projectContextManifestItemSchema = z
  .object({
    itemId: z.string().min(1),
    kind: z.enum(['instruction', 'memory', 'reference']),
    sourceTaskId: idSchema.nullable(),
    sourceTurnId: idSchema.nullable(),
    sourceReferenceId: idSchema.nullable(),
    candidateDigest: digestSchema,
    sealedDigest: digestSchema.nullable(),
    included: z.boolean(),
    exclusionReason: z.string().min(1).nullable(),
    authority: z.enum(['user', 'none']),
    localOnly: z.boolean(),
    content: z.string().nullable(),
    capturedAt: timestampSchema,
  })
  .strict();
export const projectContextManifestSummarySchema = z
  .object({
    turnId: idSchema,
    projectId: idSchema.nullable(),
    projectContextEpoch: z.number().int().nonnegative().nullable(),
    candidateSnapshotDigest: digestSchema,
    sealedDigest: digestSchema,
    createdAt: timestampSchema,
  })
  .strict();
export const projectContextManifestSchema = projectContextManifestSummarySchema
  .extend({
    sealId: idSchema,
    taskId: idSchema,
    projectRevision: z.number().int().positive().nullable(),
    compacted: z.boolean(),
    items: z.array(projectContextManifestItemSchema),
  })
  .strict();
export const projectContextManifestsListInputSchema = z.object({ taskId: idSchema }).strict();
export const projectContextManifestGetInputSchema = z
  .object({ taskId: idSchema, turnId: idSchema })
  .strict();
export type ProjectInstruction = z.infer<typeof projectInstructionResultSchema>;
export type ProjectContextManifestSummary = z.infer<typeof projectContextManifestSummarySchema>;
export type ProjectContextManifest = z.infer<typeof projectContextManifestSchema>;
export const projectReferenceStatusSchema = z.enum([
  'healthy',
  'changed',
  'missing',
  'unreadable',
  'workspace_changed',
  'too_large',
  'non_text',
]);
export const projectReferenceSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    sourceTaskId: idSchema.nullable(),
    projectRootId: idSchema.nullable().default(null),
    relativePath: z.string().min(1).max(1024),
    enabled: z.boolean(),
    revision: z.number().int().positive(),
    lastSealedDigest: digestSchema.nullable(),
    status: projectReferenceStatusSchema,
    currentDigest: digestSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export const projectReferencesListInputSchema = z.object({ projectId: idSchema }).strict();
export const projectReferenceAddInputSchema = z
  .object({
    projectId: idSchema,
    sourceTaskId: idSchema.optional(),
    projectRootId: idSchema.optional(),
    relativePath: z.string().min(1).max(1024),
  })
  .strict()
  .refine(
    ({ sourceTaskId, projectRootId }) =>
      (sourceTaskId === undefined) !== (projectRootId === undefined),
    { message: 'Exactly one reference root must be supplied' },
  );
export const projectReferencePickInputSchema = z
  .object({
    projectId: idSchema,
    sourceTaskId: idSchema.optional(),
    projectRootId: idSchema.optional(),
  })
  .strict()
  .refine(
    ({ sourceTaskId, projectRootId }) =>
      (sourceTaskId === undefined) !== (projectRootId === undefined),
    { message: 'Exactly one reference root must be supplied' },
  );
export const projectReferenceUpdateInputSchema = z
  .object({
    referenceId: idSchema,
    expectedRevision: z.number().int().positive(),
    enabled: z.boolean(),
  })
  .strict();
export const projectReferenceRemoveInputSchema = z
  .object({ referenceId: idSchema, expectedRevision: z.number().int().positive() })
  .strict();
export type ProjectReference = z.infer<typeof projectReferenceSchema>;
export const projectMemorySchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    sourceTaskId: idSchema,
    sourceTurnId: idSchema,
    content: z.string().min(1).max(4000),
    createdBy: z.enum(['user', 'assistant']),
    status: z.enum(['active', 'disabled']),
    revision: z.number().int().positive(),
    localOnly: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export const projectMemoriesListInputSchema = z.object({ projectId: idSchema }).strict();
export const projectMemoryCreateInputSchema = z
  .object({
    projectId: idSchema,
    sourceTurnId: idSchema,
    content: z.string().trim().min(1).max(4000),
  })
  .strict();
export const projectMemoryUpdateInputSchema = z
  .object({
    memoryId: idSchema,
    expectedRevision: z.number().int().positive(),
    content: z.string().trim().min(1).max(4000).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict()
  .refine((input) => input.content !== undefined || input.status !== undefined, {
    message: 'Memory update must change content or status',
  });
export type ProjectMemory = z.infer<typeof projectMemorySchema>;
export const taskIdPayloadSchema = z.object({ taskId: idSchema }).strict();
/** A Workspace-relative path within a Task. Validated as a bounded string here; whether it is
 * actually inside the Workspace is Main's decision, not the schema's (issue #43). */
export const filePathPayloadSchema = z
  .object({
    taskId: idSchema,
    /** Missing on operations created before multi-root support; resolves to the current Primary. */
    rootId: idSchema.default('legacy-primary'),
    path: z.string().min(1).max(1024),
  })
  .strict();
export const taskRenameInputSchema = z
  .object({ taskId: idSchema, title: z.string().trim().min(1).max(200) })
  .strict();
export const taskPinnedInputSchema = z.object({ taskId: idSchema, pinned: z.boolean() }).strict();
export const taskArchivedInputSchema = z
  .object({ taskId: idSchema, archived: z.boolean() })
  .strict();
export const taskGoalInputSchema = z.object({ taskId: idSchema, goal: taskTextSchema }).strict();
export const goalStartInputSchema = z
  .object({
    taskId: idSchema,
    objective: z
      .string()
      .max(4000)
      .refine((text) => text.trim() !== '', {
        message: 'Goal objective must not be blank',
      }),
    skills: turnSkillSelectionsSchema.default([]),
  })
  .strict();
export const goalControlInputSchema = z.object({ taskId: idSchema }).strict();
export const goalResumeInputSchema = z
  .object({ taskId: idSchema, skills: turnSkillSelectionsSchema.default([]) })
  .strict();
export const goalRunResultSchema = z.object({ task: taskSummarySchema, turnId: idSchema }).strict();
export const taskDraftInputSchema = z.object({ taskId: idSchema, draft: taskTextSchema }).strict();
// Indentation is meaningful in Markdown/code; check for blank input without rewriting it.
const turnTextInputSchema = taskTextSchema.refine((text) => text.trim() !== '', {
  message: 'Turn text must not be blank',
});
const turnTextAndSkillsInputShape = {
  taskId: idSchema,
  text: turnTextInputSchema,
  skills: turnSkillSelectionsSchema.default([]),
} as const;
export const turnStartInputSchema = z
  .object({
    ...turnTextAndSkillsInputShape,
    attachmentIds: imageAttachmentIdsSchema,
    attachmentSelectionIdentity: z.string().min(1).max(512).nullable(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.attachmentIds.length > 0 !== (input.attachmentSelectionIdentity !== null))
      context.addIssue({
        code: 'custom',
        message: 'Attachment selection identity must match attachment presence',
      });
  });
export const turnQueueInputSchema = z.object(turnTextAndSkillsInputShape).strict();
export const turnQueueResultSchema = z.object({ ordinal: z.number().int().positive() }).strict();
export const turnSteerInputSchema = z
  .object({
    taskId: idSchema,
    text: turnTextInputSchema,
    expectedTurnId: idSchema,
  })
  .strict();
export const turnStopAndSendInputSchema = z.object(turnTextAndSkillsInputShape).strict();
export const turnCancelInputSchema = z
  .object({
    taskId: idSchema,
    turnId: idSchema,
    startNextQueued: z.boolean().optional(),
  })
  .strict();
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
    /** Diagnostic-only bundle containing the corrupt main/WAL/SHM generation, when preserved. */
    corruptBundlePath: z.string().nullable(),
    /** The preserved WAL may contain committed pages that were not present in the restored backup. */
    possibleCommittedDataLoss: z.boolean(),
    /** Turns finalised as `interrupted` because the app exited while they were running. */
    interruptedTurns: z.number().int().nonnegative(),
  })
  .strict();
export type DatabaseRecovery = z.infer<typeof databaseRecoverySchema>;

export const commandSandboxCapabilitySchema = z
  .object({
    available: z.boolean(),
    backend: z.string().min(1).max(128),
    reason: z.string().min(1).max(128).nullable(),
    probedAt: z.string().datetime(),
  })
  .strict();
export type CommandSandboxCapability = z.infer<typeof commandSandboxCapabilitySchema>;

export const appInfoSchema = z
  .object({
    version: z.string(),
    platform: z.string(),
    recovery: databaseRecoverySchema,
    updateHealth: updateHealthSchema,
    commandSandbox: commandSandboxCapabilitySchema.optional(),
    settingsWorkspaceV2: z.boolean().optional(),
    projectMultiFolderUx: z.boolean().optional(),
  })
  .strict();
export type AppInfo = z.infer<typeof appInfoSchema>;

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
    turnId: idSchema.nullable().default(null),
    diagnosticId: idSchema.nullable().default(null),
    errorCode: z.string().max(64).nullable(),
    userMessage: z.string().max(500).nullable(),
  })
  .strict();
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;
export const runtimeFailureDiagnosticQuerySchema = z
  .object({
    taskId: idSchema,
    diagnosticId: idSchema.optional(),
  })
  .strict();
export const runtimeFailureDiagnosticExportSchema = z.string().max(20_000).nullable();
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
  graphs: {
    checkSources(input: GraphSourceCheckInput): Promise<GraphSourceStatus>;
    reviewMission(input: GraphSourceCheckInput): Promise<GraphMissionReview>;
    startMission(input: GraphMissionStartInput): Promise<TeamMissionSummary>;
    resumeIntegration(input: GraphMissionResumeInput): Promise<TeamMissionSummary>;
    resumeStep(input: GraphMissionResumeInput): Promise<TeamMissionSummary>;
    reviewWorkspace(input: GraphMissionResumeInput): Promise<GraphWorkspaceReview>;
    requestUpdate(input: GraphMissionUpdateInput): Promise<GraphMissionUpdateReview>;
    reviewUpdate(input: GraphMissionUpdateInput): Promise<GraphMissionUpdateReview>;
    agreeUpdate(input: GraphMissionUpdateAgreement): Promise<TeamMissionSummary>;
    subscribeSources(listener: (status: GraphSourceStatus) => void): () => void;
    render(input: GraphRenderInput): Promise<GraphView>;
    get(taskId: string): Promise<GraphView | null>;
    generation(taskId: string): Promise<GraphGeneration | null>;
    sources(input: z.infer<typeof graphSourcesInputSchema>): Promise<GraphSourceRef[]>;
    previewSource(
      input: z.infer<typeof graphSourcePreviewInputSchema>,
    ): Promise<GraphSourcePreview>;
    subscribeGeneration(listener: (generation: GraphGeneration) => void): () => void;
    history(input: GraphHistoryInput): Promise<GraphHistory>;
    compare(input: GraphCompareInput): Promise<GraphDiff>;
    cancel(taskId: string, generationId?: string): Promise<void>;
    release(taskId: string, instanceId: string): Promise<void>;
    subscribe(listener: (view: GraphView) => void): () => void;
  };
  app: { getInfo(): Promise<AppInfo> };
  windowControls: {
    platform: string;
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    onMaximizedChanged(listener: (maximized: boolean) => void): () => void;
  };
  tasks: {
    list(): Promise<TaskSummary[]>;
    /** Receives non-persisted Task summary updates such as a completed generated title. */
    subscribe(listener: (task: TaskSummary) => void): () => void;
    create(input?: {
      title?: string;
      localOnly?: boolean;
      projectId?: string;
    }): Promise<TaskSummary>;
    messages(taskId: string): Promise<ChatMessage[]>;
    rename(taskId: string, title: string): Promise<TaskSummary>;
    setPinned(taskId: string, pinned: boolean): Promise<TaskSummary>;
    setArchived(taskId: string, archived: boolean): Promise<TaskSummary>;
    setGoal(taskId: string, goal: string): Promise<TaskSummary>;
    getDraft(taskId: string): Promise<string>;
    setDraft(taskId: string, draft: string): Promise<void>;
  };
  goals: {
    start(input: {
      taskId: string;
      objective: string;
      skills?: readonly TurnSkillSelection[];
    }): Promise<{ task: TaskSummary; turnId: string }>;
    pause(taskId: string): Promise<TaskSummary>;
    resume(
      taskId: string,
      skills?: readonly TurnSkillSelection[],
    ): Promise<{ task: TaskSummary; turnId: string }>;
    clear(taskId: string): Promise<TaskSummary>;
  };
  attachments: {
    capability(taskId: string): Promise<ImageAttachmentCapability>;
    pick(taskId: string): Promise<ImageAttachmentMetadata | null>;
    /** Adds the image currently on the OS clipboard. Resolves `null` when it holds none. */
    paste(taskId: string): Promise<ImageAttachmentMetadata | null>;
    listDraft(taskId: string): Promise<ImageAttachmentMetadata[]>;
    /** Downscaled bytes as base64, for a `data:` URL thumbnail. Rejects an unknown draft. */
    preview(input: { taskId: string; attachmentId: string }): Promise<ImageAttachmentPreview>;
    remove(input: { taskId: string; attachmentId: string }): Promise<void>;
  };
  projects: {
    list(): Promise<ProjectSummary[]>;
    pickFolders(): Promise<ProjectFolderPickerResult>;
    folders: {
      list(input: { projectId: string }): Promise<ProjectFolder[]>;
      replace(input: {
        projectId: string;
        expectedRevision: number;
        folders: ProjectFolderInput[];
      }): Promise<ProjectSummary>;
    };
    get(input: { projectId: string }): Promise<ProjectInstruction>;
    setInstruction(input: {
      projectId: string;
      expectedRevision: number;
      instruction: string;
    }): Promise<ProjectInstruction>;
    listContextManifests(input: { taskId: string }): Promise<ProjectContextManifestSummary[]>;
    getContextManifest(input: { taskId: string; turnId: string }): Promise<ProjectContextManifest>;
    references: {
      list(input: { projectId: string }): Promise<ProjectReference[]>;
      pick(input: {
        projectId: string;
        sourceTaskId?: string;
        projectRootId?: string;
      }): Promise<ProjectReference | null>;
      add(input: {
        projectId: string;
        sourceTaskId?: string;
        projectRootId?: string;
        relativePath: string;
      }): Promise<ProjectReference>;
      update(input: {
        referenceId: string;
        expectedRevision: number;
        enabled: boolean;
      }): Promise<ProjectReference>;
      remove(input: { referenceId: string; expectedRevision: number }): Promise<void>;
    };
    memories: {
      list(input: { projectId: string }): Promise<ProjectMemory[]>;
      createFromTurn(input: {
        projectId: string;
        sourceTurnId: string;
        content: string;
      }): Promise<ProjectMemory>;
      update(input: {
        memoryId: string;
        expectedRevision: number;
        content?: string;
        status?: 'active' | 'disabled';
      }): Promise<ProjectMemory>;
    };
    create(input: { name: string; folders?: ProjectFolderInput[] }): Promise<ProjectSummary>;
    update(input: {
      projectId: string;
      expectedRevision: number;
      name?: string;
      archived?: boolean;
    }): Promise<ProjectSummary>;
    assignTask(input: {
      projectId: string;
      taskId: string;
      expectedProjectId: string | null;
    }): Promise<TaskSummary>;
    unassignTask(input: { taskId: string; expectedProjectId: string | null }): Promise<TaskSummary>;
  };
  teams: {
    promote(taskId: string): Promise<TeamSummary>;
    get(taskId: string): Promise<TeamDetail | null>;
    updatePolicy(input: TeamPolicyUpdateInput): Promise<TeamDetail>;
    hireWorker(input: TeamHireWorkerInput): Promise<WorkerSummary>;
    resumeMission(input: TeamResumeMissionInput): Promise<TeamMissionSummary>;
    resumeExecutionIntegration(input: TeamResumeExecutionIntegrationInput): Promise<TeamDetail>;
    /** Worktrees Team Workers left on disk for this Task (issue #544). */
    listRetainedWorktrees(
      taskId: string,
      cursor?: TeamRetainedWorktreeCursor,
    ): Promise<TeamRetainedWorktreeList>;
    inspectRetainedWorktree(
      input: TeamRetainedWorktreeRef,
    ): Promise<TeamRetainedWorktreeInspection>;
    /** Shows the retained worktree folder in the OS file manager. */
    openRetainedWorktree(input: TeamRetainedWorktreeRef): Promise<void>;
    /** Deletes the retained worktree with every change in it, and returns the list left. */
    discardRetainedWorktree(input: TeamRetainedWorktreeRef): Promise<TeamRetainedWorktreeList>;
    sendToWorker(input: TeamSendMessageInput): Promise<TeamMessageSummary>;
    stopWorker(input: TeamWorkerRef): Promise<WorkerSummary>;
    stopAll(taskId: string): Promise<TeamDetail>;
    subscribe(
      taskId: string,
      listener: (event: TeamEvent) => void,
      onError?: () => void,
    ): () => void;
    getCanvasView(taskId: string): Promise<CanvasView | null>;
    saveCanvasView(input: CanvasViewSaveInput): Promise<CanvasViewSaveResult>;
  };
  workspace: {
    get(taskId: string): Promise<WorkspaceSelection>;
    getEffective(taskId: string): Promise<EffectiveWorkspaceSet>;
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
    /** Returns a redacted JSON diagnostic for the latest failed Turn or a diagnostic id. */
    getFailureDiagnostic(input: { taskId: string; diagnosticId?: string }): Promise<string | null>;
  };
  updates: {
    subscribeHealth(listener: (health: UpdateHealth) => void): () => void;
    checkNow(): Promise<UpdateCheckResult>;
    openManualUpdate(): void;
    openUpdateLog(): void;
  };
  files: {
    /** Every edit recorded for this Task, oldest first. Read on select rather than replayed through
     * the event port, which only carries events newer than the snapshot's lastSeq. */
    list(taskId: string): Promise<FileChangeRecord[]>;
    /** Opens the native file picker and returns a safe editable file, or null when cancelled. */
    pick(taskId: string): Promise<FileOpenResult | null>;
    /** Reads a file in full so it can be edited, or refuses with a reason. */
    open(taskId: string, rootId: string, path: string): Promise<FileOpenResult>;
    /** Restores verified pre-save bytes after the user confirms an ambiguous interrupted save. */
    recover(taskId: string, rootId: string, path: string): Promise<FileOpenResult>;
    /** Writes the user's own edit. Refuses rather than overwriting when the file changed underneath. */
    save(input: {
      taskId: string;
      rootId: string;
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
    /** Detects the Codex, Claude and Grok CLIs again without an app restart. Resolves once the
     * new detection has settled; `getRuntime` then reads it. */
    refreshRuntimeDetection(): Promise<void>;
    setRuntime(kind: RuntimeKind, taskId?: string): Promise<void>;
    setModel(model: string, taskId?: string): Promise<void>;
    setEffort(effort: ClaudeEffort): Promise<void>;
    /** Codex reasoning level. Rejects a level the selected model does not advertise (see
     * `effortOptionSchema`) — Codex fails the whole turn on an unsupported one. */
    setCodexEffort(effort: string): Promise<void>;
    getTeamModelResearch(): Promise<TeamModelResearchSettings>;
    setTeamModelResearch(input: TeamModelResearchSettings): Promise<void>;
    getTeamConcurrency(): Promise<TeamConcurrencySettings>;
    setTeamConcurrency(input: TeamConcurrencySettings): Promise<void>;
    getTeamModelSelectionGuidance(): Promise<TeamModelSelectionGuidance>;
    setTeamModelSelectionGuidance(input: TeamModelSelectionGuidance): Promise<void>;
    getSprintCoderPrePrompt(): Promise<SprintCoderPrePrompt>;
    setSprintCoderPrePrompt(input: SprintCoderPrePrompt): Promise<void>;
    getTeamModelSettings(): Promise<TeamModelSettings>;
    setTeamModelRestriction(input: TeamModelRestriction): Promise<void>;
    getDefaultTeamPolicy(): Promise<TeamPolicy>;
    setDefaultTeamPolicy(policy: TeamPolicy): Promise<void>;
  };
  skills: {
    list(): Promise<SkillCatalog>;
    getDraftSelection(taskId: string): Promise<TurnSkillSelection[]>;
    setDraftSelection(taskId: string, skills: TurnSkillSelection[]): Promise<void>;
    listDrafts(): Promise<SkillDraft[]>;
    createDraft(input: SkillDraftCreateInput): Promise<SkillDraft>;
    installDraft(
      draftId: string,
      expectedDigest: string,
      confirmed: true,
    ): Promise<SkillCatalogItem>;
    discardDraft(draftId: string): Promise<void>;
    removeCreated(skillId: string, digest: string): Promise<void>;
    setCreatedEnabled(skillId: string, digest: string, enabled: boolean): Promise<void>;
    setActivationPolicy(ref: SkillRef, policy: SkillActivationPolicy): Promise<void>;
    exportCreated(
      skillId: string,
      digest: string,
      format?: 'original' | 'portable',
    ): Promise<string | null>;
  };
  models: {
    query(input: ModelCatalogQueryInput): Promise<ModelCatalogQueryResult>;
    setSelection(taskId: string, selection: ModelSelection): Promise<ModelSelection>;
  };
  providers: {
    listConnections(): Promise<ProviderConnectionView[]>;
    listProfiles(): Promise<ProviderProfile[]>;
    createOpenAIConnection(input: OpenAIConnectionCreateInput): Promise<ProviderConnection>;
    createOpenRouterConnection(input: OpenRouterConnectionCreateInput): Promise<ProviderConnection>;
    createOrcaRouterConnection(input: OrcaRouterConnectionCreateInput): Promise<ProviderConnection>;
    createAnthropicConnection(input: AnthropicConnectionCreateInput): Promise<ProviderConnection>;
    createGeminiConnection(input: GeminiConnectionCreateInput): Promise<ProviderConnection>;
    createXAIConnection(input: XAIConnectionCreateInput): Promise<ProviderConnection>;
    createProfileConnection(
      input: ProviderProfileConnectionCreateInput,
    ): Promise<ProviderConnection>;
    verifyConnection(connectionId: string): Promise<ProviderConnection>;
    lowerRateLimits(input: ProviderConnectionRateLimitLowerInput): Promise<ProviderConnection>;
    setAutomaticModelRelease(
      input: ProviderConnectionModelReleaseUpdateInput,
    ): Promise<ProviderConnection>;
  };
  permissions: {
    get(taskId: string): Promise<PermissionSettings>;
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
      skills?: TurnSkillSelection[];
      attachmentIds: string[];
      attachmentSelectionIdentity: string | null;
    }): Promise<{ turnId: string; renamedTask?: TaskSummary | undefined }>;
    queue(input: {
      taskId: string;
      text: string;
      skills?: TurnSkillSelection[];
    }): Promise<{ ordinal: number }>;
    steer(input: { taskId: string; text: string; expectedTurnId: string }): Promise<void>;
    stopAndSend(input: {
      taskId: string;
      text: string;
      skills?: TurnSkillSelection[];
    }): Promise<void>;
    cancel(input: z.infer<typeof turnCancelInputSchema>): Promise<void>;
    snapshot(taskId: string): Promise<TurnSnapshot>;
    subscribe(
      taskId: string,
      cb: (ev: TurnEvent) => void,
      opts?: { afterSeq?: number },
    ): () => void;
  };
}

export const IPC_CHANNELS = {
  graphsRender: 'sprint-coder:graphs:render',
  graphsGet: 'sprint-coder:graphs:get',
  graphsGeneration: 'sprint-coder:graphs:generation',
  graphsSources: 'sprint-coder:graphs:sources',
  graphsSourcePreview: 'sprint-coder:graphs:source-preview',
  graphsSourceCheck: 'sprint-coder:graphs:source-check',
  graphsSourceStatus: 'sprint-coder:graphs:source-status',
  graphsMissionReview: 'sprint-coder:graphs:mission-review',
  graphsMissionStart: 'sprint-coder:graphs:mission-start',
  graphsMissionResumeIntegration: 'sprint-coder:graphs:mission-resume-integration',
  graphsMissionResumeStep: 'sprint-coder:graphs:mission-resume-step',
  graphsWorkspaceReview: 'sprint-coder:graphs:workspace-review',
  graphsRequestUpdate: 'sprint-coder:graphs:request-update',
  graphsReviewUpdate: 'sprint-coder:graphs:review-update',
  graphsAgreeUpdate: 'sprint-coder:graphs:agree-update',
  graphsGenerationUpdated: 'sprint-coder:graphs:generation-updated',
  graphsHistory: 'sprint-coder:graphs:history',
  graphsCompare: 'sprint-coder:graphs:compare',
  graphsCancel: 'sprint-coder:graphs:cancel',
  graphsRelease: 'sprint-coder:graphs:release',
  graphsUpdated: 'sprint-coder:graphs:updated',
  appGetInfo: 'sprint-coder:app:get-info',
  tasksList: 'sprint-coder:tasks:list',
  /** Push-only (webContents.send), never bound to an ipcMain.handle input schema. */
  tasksUpdated: 'sprint-coder:tasks:updated',
  tasksCreate: 'sprint-coder:tasks:create',
  tasksMessages: 'sprint-coder:tasks:messages',
  tasksRename: 'sprint-coder:tasks:rename',
  tasksSetPinned: 'sprint-coder:tasks:set-pinned',
  tasksSetArchived: 'sprint-coder:tasks:set-archived',
  tasksSetGoal: 'sprint-coder:tasks:set-goal',
  goalsStart: 'sprint-coder:goals:start',
  goalsPause: 'sprint-coder:goals:pause',
  goalsResume: 'sprint-coder:goals:resume',
  goalsClear: 'sprint-coder:goals:clear',
  tasksGetDraft: 'sprint-coder:tasks:get-draft',
  tasksSetDraft: 'sprint-coder:tasks:set-draft',
  attachmentsCapability: 'sprint-coder:attachments:capability',
  attachmentsPick: 'sprint-coder:attachments:pick',
  attachmentsPaste: 'sprint-coder:attachments:paste',
  attachmentsListDraft: 'sprint-coder:attachments:list-draft',
  attachmentsPreview: 'sprint-coder:attachments:preview',
  attachmentsRemove: 'sprint-coder:attachments:remove',
  projectsList: 'sprint-coder:projects:list',
  projectsPickFolders: 'sprint-coder:projects:pick-folders',
  projectsFoldersList: 'sprint-coder:projects:folders:list',
  projectsFoldersReplace: 'sprint-coder:projects:folders:replace',
  projectsGet: 'sprint-coder:projects:get',
  projectsSetInstruction: 'sprint-coder:projects:set-instruction',
  projectsListContextManifests: 'sprint-coder:projects:list-context-manifests',
  projectsGetContextManifest: 'sprint-coder:projects:get-context-manifest',
  projectsReferencesList: 'sprint-coder:projects:references:list',
  projectsReferencesPick: 'sprint-coder:projects:references:pick',
  projectsReferencesAdd: 'sprint-coder:projects:references:add',
  projectsReferencesUpdate: 'sprint-coder:projects:references:update',
  projectsReferencesRemove: 'sprint-coder:projects:references:remove',
  projectsMemoriesList: 'sprint-coder:projects:memories:list',
  projectsMemoriesCreate: 'sprint-coder:projects:memories:create',
  projectsMemoriesUpdate: 'sprint-coder:projects:memories:update',
  projectsCreate: 'sprint-coder:projects:create',
  projectsUpdate: 'sprint-coder:projects:update',
  projectsAssignTask: 'sprint-coder:projects:assign-task',
  projectsUnassignTask: 'sprint-coder:projects:unassign-task',
  teamsPromote: 'sprint-coder:teams:promote',
  teamsGet: 'sprint-coder:teams:get',
  teamsUpdatePolicy: 'sprint-coder:teams:update-policy',
  teamsHireWorker: 'sprint-coder:teams:hire-worker',
  teamsSend: 'sprint-coder:teams:send',
  teamsStopWorker: 'sprint-coder:teams:stop-worker',
  teamsStopAll: 'sprint-coder:teams:stop-all',
  teamsResumeMission: 'sprint-coder:teams:resume-mission',
  teamsResumeExecutionIntegration: 'sprint-coder:teams:resume-execution-integration',
  teamsListRetainedWorktrees: 'sprint-coder:teams:list-retained-worktrees',
  teamsInspectRetainedWorktree: 'sprint-coder:teams:inspect-retained-worktree',
  teamsOpenRetainedWorktree: 'sprint-coder:teams:open-retained-worktree',
  teamsDiscardRetainedWorktree: 'sprint-coder:teams:discard-retained-worktree',
  teamsSubscribe: 'sprint-coder:teams:subscribe',
  teamsUnsubscribe: 'sprint-coder:teams:unsubscribe',
  teamsEvent: 'sprint-coder:teams:event',
  teamsGetCanvasView: 'sprint-coder:teams:get-canvas-view',
  teamsSaveCanvasView: 'sprint-coder:teams:save-canvas-view',
  workspaceGet: 'sprint-coder:workspace:get',
  workspaceGetEffective: 'sprint-coder:workspace:get-effective',
  workspaceSelect: 'sprint-coder:workspace:select',
  settingsGetRuntime: 'sprint-coder:settings:get-runtime',
  settingsRefreshRuntimeDetection: 'sprint-coder:settings:refresh-runtime-detection',
  settingsSetRuntime: 'sprint-coder:settings:set-runtime',
  settingsSetModel: 'sprint-coder:settings:set-model',
  settingsSetEffort: 'sprint-coder:settings:set-effort',
  skillsList: 'sprint-coder:skills:list',
  skillsGetDraftSelection: 'sprint-coder:skills:get-draft-selection',
  skillsSetDraftSelection: 'sprint-coder:skills:set-draft-selection',
  skillsListDrafts: 'sprint-coder:skills:list-drafts',
  skillsCreateDraft: 'sprint-coder:skills:create-draft',
  skillsInstallDraft: 'sprint-coder:skills:install-draft',
  skillsDiscardDraft: 'sprint-coder:skills:discard-draft',
  skillsRemoveCreated: 'sprint-coder:skills:remove-created',
  skillsSetCreatedEnabled: 'sprint-coder:skills:set-created-enabled',
  skillsSetActivationPolicy: 'sprint-coder:skills:set-activation-policy',
  skillsExportCreated: 'sprint-coder:skills:export-created',
  /** Push-only (webContents.send), never bound to an ipcMain.handle input schema. */
  reasoningEvent: 'sprint-coder:turns:reasoning',
  fileEditEvent: 'sprint-coder:turns:file-edit',
  runtimeStatusEvent: 'sprint-coder:runtime:status',
  /** Push-only update health contains classifications, never raw updater errors or paths. */
  updateHealthEvent: 'sprint-coder:update:health',
  updateCheckNow: 'sprint-coder:update:check-now',
  updateOpenManual: 'sprint-coder:update:open-manual',
  updateOpenLog: 'sprint-coder:update:open-log',
  runtimeFailureDiagnosticGet: 'sprint-coder:runtime:failure-diagnostic:get',
  imagesList: 'sprint-coder:images:list',
  filesList: 'sprint-coder:files:list',
  filesPick: 'sprint-coder:files:pick',
  filesOpen: 'sprint-coder:files:open',
  filesRecover: 'sprint-coder:files:recover',
  filesSave: 'sprint-coder:files:save',
  imagesRead: 'sprint-coder:images:read',
  settingsSetCodexEffort: 'sprint-coder:settings:set-codex-effort',
  settingsGetTeamModelResearch: 'sprint-coder:settings:get-team-model-research',
  settingsSetTeamModelResearch: 'sprint-coder:settings:set-team-model-research',
  settingsGetTeamConcurrency: 'sprint-coder:settings:get-team-concurrency',
  settingsSetTeamConcurrency: 'sprint-coder:settings:set-team-concurrency',
  settingsGetTeamModelSelectionGuidance: 'sprint-coder:settings:get-team-model-selection-guidance',
  settingsSetTeamModelSelectionGuidance: 'sprint-coder:settings:set-team-model-selection-guidance',
  settingsGetSprintCoderPrePrompt: 'sprint-coder:settings:get-sprint-coder-pre-prompt',
  settingsSetSprintCoderPrePrompt: 'sprint-coder:settings:set-sprint-coder-pre-prompt',
  settingsGetTeamModelSettings: 'sprint-coder:settings:get-team-model-settings',
  settingsSetTeamModelRestriction: 'sprint-coder:settings:set-team-model-restriction',
  settingsGetDefaultTeamPolicy: 'sprint-coder:settings:get-default-team-policy',
  settingsSetDefaultTeamPolicy: 'sprint-coder:settings:set-default-team-policy',
  modelsCatalogQuery: 'sprint-coder:models:catalog-query',
  modelsSetSelection: 'sprint-coder:models:set-selection',
  providersListConnections: 'sprint-coder:providers:list-connections',
  providersListProfiles: 'sprint-coder:providers:list-profiles',
  providersCreateOpenAIConnection: 'sprint-coder:providers:create-openai-connection',
  providersCreateOpenRouterConnection: 'sprint-coder:providers:create-openrouter-connection',
  providersCreateOrcaRouterConnection: 'sprint-coder:providers:create-orcarouter-connection',
  providersCreateAnthropicConnection: 'sprint-coder:providers:create-anthropic-connection',
  providersCreateGeminiConnection: 'sprint-coder:providers:create-gemini-connection',
  providersCreateXAIConnection: 'sprint-coder:providers:create-xai-connection',
  providersCreateProfileConnection: 'sprint-coder:providers:create-profile-connection',
  providersVerifyConnection: 'sprint-coder:providers:verify-connection',
  providersLowerRateLimits: 'sprint-coder:providers:lower-rate-limits',
  providersSetAutomaticModelRelease: 'sprint-coder:providers:set-automatic-model-release',
  permissionsGet: 'sprint-coder:permissions:get',
  permissionsSet: 'sprint-coder:permissions:set',
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
