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
  // Computer Use is a controller-only tool.  Keeping it in the shared catalog lets Main and
  // the native host agree on the protocol while the domain registry still filters it from Chat,
  // Team, and Managed Coding Harness snapshots.
  'computer',
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
  'computer.observe',
  'computer.control',
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
export const teamPolicySchema = z
  .object({
    maxAgentDepth: z.number().int().min(1).max(4),
    maxConcurrentExecutions: z.number().int().min(1).max(8),
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
    connectionId: teamConnectionIdSchema.nullable(),
    requestedProvider: teamProviderIdSchema.nullable(),
    requestedModel: z.string().min(1).max(256).nullable(),
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

export const teamEventSchema = z.discriminatedUnion('type', [
  teamSubscriptionSnapshotSchema,
  z
    .object({
      type: z.literal('updated'),
      seq: z.number().int().min(1),
      detail: teamDetailSchema,
    })
    .strict(),
]);
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
    retryAt: timestampSchema.optional(),
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
export const providerComputeLocationSchema = z.enum(['cloud', 'local']);
export type ProviderComputeLocation = z.infer<typeof providerComputeLocationSchema>;
const localHardwareByteCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const localHardwareUnknownComponentSchema = z.enum([
  'system_memory',
  'cpu_identity',
  'cpu_features',
  'gpu_devices',
  'gpu_memory',
  'backend_availability',
]);
export const localHardwareSnapshotSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(['complete', 'partial', 'unknown']),
    observedAt: timestampSchema,
    platform: z.enum(['darwin', 'win32', 'linux', 'other']),
    architecture: z.string().min(1).max(32),
    memory: z
      .object({
        totalBytes: localHardwareByteCountSchema.nullable(),
        availableBytes: localHardwareByteCountSchema.nullable(),
        topology: z.enum(['unified', 'discrete', 'shared', 'unknown']),
      })
      .strict(),
    cpu: z
      .object({
        model: z.string().min(1).max(256).nullable(),
        logicalCores: z.number().int().positive().max(4_096).nullable(),
        features: z.array(z.string().regex(/^[a-z0-9._-]{1,32}$/)).max(64),
        featuresStatus: z.enum(['known', 'unknown']),
      })
      .strict(),
    gpuDevicesStatus: z.enum(['known', 'unknown']),
    gpus: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            active: z.boolean().nullable(),
            vendorId: z.number().int().nonnegative().max(0xffffffff).nullable(),
            deviceId: z.number().int().nonnegative().max(0xffffffff).nullable(),
            vendorName: z.string().min(1).max(128).nullable(),
            deviceName: z.string().min(1).max(256).nullable(),
            memory: z
              .object({
                dedicatedTotalBytes: localHardwareByteCountSchema.nullable(),
                dedicatedAvailableBytes: localHardwareByteCountSchema.nullable(),
                sharedTotalBytes: localHardwareByteCountSchema.nullable(),
                unifiedTotalBytes: localHardwareByteCountSchema.nullable(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(16),
    backends: z
      .array(
        z
          .object({
            kind: z.enum(['cpu', 'metal', 'cuda', 'vulkan']),
            status: z.enum(['available', 'unavailable', 'unknown']),
          })
          .strict(),
      )
      .max(4),
    /** Components with one or more unavailable required sub-fields. A partial component may retain
     * independently observed values (for example total RAM when current free RAM failed). */
    unknownComponents: z.array(localHardwareUnknownComponentSchema).max(6),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const unknown = new Set(snapshot.unknownComponents);
    if (new Set(snapshot.unknownComponents).size !== snapshot.unknownComponents.length)
      context.addIssue({ code: 'custom', message: 'Duplicate unknown hardware component' });
    if (new Set(snapshot.backends.map((backend) => backend.kind)).size !== snapshot.backends.length)
      context.addIssue({ code: 'custom', message: 'Duplicate local backend' });
    if (new Set(snapshot.gpus.map((gpu) => gpu.id)).size !== snapshot.gpus.length)
      context.addIssue({ code: 'custom', message: 'Duplicate GPU id' });
    if (snapshot.gpuDevicesStatus === 'unknown' && snapshot.gpus.length > 0)
      context.addIssue({
        code: 'custom',
        message: 'Unknown GPU enumeration cannot contain GPU devices',
        path: ['gpus'],
      });
    if (snapshot.cpu.featuresStatus === 'unknown' && snapshot.cpu.features.length > 0)
      context.addIssue({
        code: 'custom',
        message: 'Unknown CPU features cannot contain feature values',
        path: ['cpu', 'features'],
      });
    if (
      snapshot.memory.totalBytes !== null &&
      snapshot.memory.availableBytes !== null &&
      snapshot.memory.availableBytes > snapshot.memory.totalBytes
    )
      context.addIssue({
        code: 'custom',
        message: 'Available system memory cannot exceed total memory',
        path: ['memory', 'availableBytes'],
      });
    for (const [index, gpu] of snapshot.gpus.entries()) {
      if (
        gpu.memory.dedicatedTotalBytes !== null &&
        gpu.memory.dedicatedAvailableBytes !== null &&
        gpu.memory.dedicatedAvailableBytes > gpu.memory.dedicatedTotalBytes
      )
        context.addIssue({
          code: 'custom',
          message: 'Available dedicated GPU memory cannot exceed total dedicated GPU memory',
          path: ['gpus', index, 'memory', 'dedicatedAvailableBytes'],
        });
    }
    const expectedUnknown = new Set(
      [
        snapshot.memory.totalBytes === null || snapshot.memory.availableBytes === null
          ? 'system_memory'
          : null,
        snapshot.cpu.model === null || snapshot.cpu.logicalCores === null ? 'cpu_identity' : null,
        snapshot.cpu.featuresStatus === 'unknown' ? 'cpu_features' : null,
        snapshot.gpuDevicesStatus === 'unknown' ? 'gpu_devices' : null,
        snapshot.backends.length === 0 ||
        snapshot.backends.some((backend) => backend.status === 'unknown')
          ? 'backend_availability'
          : null,
        snapshot.gpuDevicesStatus === 'unknown' ||
        snapshot.gpus.some((gpu) => {
          if (snapshot.memory.topology === 'unified') return gpu.memory.unifiedTotalBytes === null;
          if (snapshot.memory.topology === 'discrete')
            return (
              gpu.memory.dedicatedTotalBytes === null ||
              gpu.memory.dedicatedAvailableBytes === null ||
              (snapshot.platform === 'win32' && gpu.memory.sharedTotalBytes === null)
            );
          if (snapshot.memory.topology === 'shared') return gpu.memory.sharedTotalBytes === null;
          return true;
        })
          ? 'gpu_memory'
          : null,
      ].filter(
        (component): component is z.infer<typeof localHardwareUnknownComponentSchema> =>
          component !== null,
      ),
    );
    for (const component of expectedUnknown)
      if (!unknown.has(component))
        context.addIssue({
          code: 'custom',
          message: `Missing unknown component marker: ${component}`,
          path: ['unknownComponents'],
        });
    for (const component of unknown)
      if (!expectedUnknown.has(component))
        context.addIssue({
          code: 'custom',
          message: `Unexpected unknown component marker: ${component}`,
          path: ['unknownComponents'],
        });
    const allPrimaryFactsUnknown = [
      'system_memory',
      'cpu_identity',
      'cpu_features',
      'gpu_devices',
      'backend_availability',
    ].every((component) =>
      unknown.has(component as z.infer<typeof localHardwareUnknownComponentSchema>),
    );
    if (snapshot.status === 'complete' && expectedUnknown.size > 0)
      context.addIssue({
        code: 'custom',
        message: 'Complete hardware snapshot cannot contain unknown components',
        path: ['status'],
      });
    if (snapshot.status === 'partial' && (expectedUnknown.size === 0 || allPrimaryFactsUnknown))
      context.addIssue({
        code: 'custom',
        message: 'Partial hardware snapshot must contain both known and unknown facts',
        path: ['status'],
      });
    if (snapshot.status === 'unknown' && !allPrimaryFactsUnknown)
      context.addIssue({
        code: 'custom',
        message: 'Unknown hardware snapshot cannot contain usable primary facts',
        path: ['status'],
      });
  });
export type LocalHardwareSnapshot = z.infer<typeof localHardwareSnapshotSchema>;

export const localFitStateSchema = z.enum([
  'unknown',
  'estimated_comfortable',
  'estimated_cpu',
  'estimated_insufficient',
  'unsupported',
  'verified_loaded',
  'verified_tools',
]);
export type LocalFitState = z.infer<typeof localFitStateSchema>;
export const localFitMemoryBreakdownSchema = z
  .object({
    weightsBytes: localHardwareByteCountSchema,
    kvCacheBytes: localHardwareByteCountSchema,
    scratchBytes: localHardwareByteCountSchema,
    runtimeReserveBytes: localHardwareByteCountSchema,
    safetyMarginBytes: localHardwareByteCountSchema,
    requiredHostBytes: localHardwareByteCountSchema,
    requiredAcceleratorBytes: localHardwareByteCountSchema,
  })
  .strict()
  .superRefine((breakdown, context) => {
    const expected =
      breakdown.weightsBytes +
      breakdown.kvCacheBytes +
      breakdown.scratchBytes +
      breakdown.runtimeReserveBytes +
      breakdown.safetyMarginBytes;
    if (
      !Number.isSafeInteger(expected) ||
      breakdown.requiredHostBytes + breakdown.requiredAcceleratorBytes !== expected
    )
      context.addIssue({ code: 'custom', message: 'Inconsistent local fit memory breakdown' });
  });
export type LocalFitMemoryBreakdown = z.infer<typeof localFitMemoryBreakdownSchema>;
export const localVerificationBindingSchema = z
  .object({
    hostCapabilityFingerprint: digestSchema,
    modelRepo: z.string().min(1).max(256),
    immutableRevision: z.string().regex(/^[a-f0-9]{40,64}$/),
    artifactHashes: z.array(digestSchema).min(1).max(256),
    quantization: z.string().min(1).max(64),
    contextTokens: z.number().int().positive().max(1_048_576),
    kvCacheType: z.string().min(1).max(64),
    batchSize: z.number().int().positive().max(1_048_576),
    /** Optional for read compatibility; new verifications always bind the effective layer count. */
    gpuLayers: z.number().int().min(0).max(4_096).optional(),
    gpuOffloadRatio: z.number().min(0).max(1),
    sidecarVersion: z.string().min(1).max(128),
    backend: z.enum(['cpu', 'metal', 'cuda', 'vulkan']),
  })
  .strict()
  .superRefine((binding, context) => {
    if (new Set(binding.artifactHashes).size !== binding.artifactHashes.length)
      context.addIssue({ code: 'custom', message: 'Duplicate local artifact hash' });
  });
export type LocalVerificationBinding = z.infer<typeof localVerificationBindingSchema>;
export const localVerificationRecordSchema = z
  .object({
    level: z.enum(['loaded', 'tools']),
    verifiedAt: timestampSchema,
    binding: localVerificationBindingSchema,
  })
  .strict();
export type LocalVerificationRecord = z.infer<typeof localVerificationRecordSchema>;
export const localFitAssessmentSchema = z
  .object({
    state: localFitStateSchema,
    label: z.string().min(1).max(120),
    detail: z.string().min(1).max(500),
    breakdown: localFitMemoryBreakdownSchema.nullable(),
    verification: localVerificationRecordSchema.nullable(),
  })
  .strict()
  .superRefine((assessment, context) => {
    const estimated = assessment.state.startsWith('estimated_');
    const verified = assessment.state.startsWith('verified_');
    if (estimated && assessment.breakdown === null)
      context.addIssue({
        code: 'custom',
        message: 'Estimated fit requires a memory breakdown',
        path: ['breakdown'],
      });
    if (estimated && !/(推定|見込み)/u.test(`${assessment.label}${assessment.detail}`))
      context.addIssue({
        code: 'custom',
        message: 'Estimated fit copy must identify itself as an estimate',
        path: ['label'],
      });
    if (verified !== (assessment.verification !== null))
      context.addIssue({
        code: 'custom',
        message: 'Verified fit and verification evidence must appear together',
        path: ['verification'],
      });
    if (!estimated && !verified && assessment.breakdown !== null)
      context.addIssue({
        code: 'custom',
        message: 'Unknown and unsupported fit cannot contain a memory estimate',
        path: ['breakdown'],
      });
    if (
      assessment.verification !== null &&
      ((assessment.state === 'verified_tools' && assessment.verification.level !== 'tools') ||
        (assessment.state === 'verified_loaded' && assessment.verification.level !== 'loaded'))
    )
      context.addIssue({
        code: 'custom',
        message: 'Verified fit state must match its evidence level',
        path: ['state'],
      });
  });
export type LocalFitAssessment = z.infer<typeof localFitAssessmentSchema>;

export const publicModelCatalogSourceSchema = z.enum(['hugging_face', 'localai_gallery', 'all']);
export type PublicModelCatalogSource = z.infer<typeof publicModelCatalogSourceSchema>;
export const publicModelCatalogPurposeSchema = z.enum([
  'all',
  'code',
  'text_generation',
  'conversational',
]);
export const publicModelCatalogQuerySchema = z
  .object({
    text: z.string().trim().max(200).default(''),
    source: publicModelCatalogSourceSchema.default('all'),
    purpose: publicModelCatalogPurposeSchema.default('code'),
    compatibility: z.enum(['compatible', 'all']).default('compatible'),
    sort: z.enum(['downloads', 'updated', 'name']).default('downloads'),
    direction: z.enum(['ascending', 'descending']).default('descending'),
    cursor: z.string().min(1).max(128).nullable().default(null),
    limit: z.number().int().min(1).max(50).default(50),
  })
  .strict();
export type PublicModelCatalogQuery = z.infer<typeof publicModelCatalogQuerySchema>;
export const publicModelInstallabilitySchema = z
  .object({
    state: z.enum([
      'installable',
      'browse_only',
      'unsupported',
      'metadata_required',
      'access_restricted',
    ]),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type PublicModelInstallability = z.infer<typeof publicModelInstallabilitySchema>;
export const publicModelCatalogItemSchema = z
  .object({
    id: z.string().min(1).max(320),
    source: z.enum(['hugging_face', 'localai_gallery']),
    sourceId: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    author: z.string().min(1).max(128).nullable(),
    sourceUrl: z.string().url().max(1_024),
    immutableRevision: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .nullable(),
    gated: z.boolean(),
    private: z.boolean(),
    viewable: z.boolean(),
    installability: publicModelInstallabilitySchema,
    license: z.string().min(1).max(128).nullable(),
    purpose: z.string().min(1).max(64).nullable(),
    tags: z.array(z.string().min(1).max(128)).max(32),
    downloads: z.number().int().nonnegative().nullable(),
    updatedAt: timestampSchema.nullable(),
  })
  .strict();
export type PublicModelCatalogItem = z.infer<typeof publicModelCatalogItemSchema>;
export const publicModelCatalogErrorSchema = z
  .object({
    source: z.enum(['hugging_face', 'localai_gallery']),
    code: z.enum([
      'offline',
      'rate_limited',
      'source_unavailable',
      'invalid_response',
      'invalid_cursor',
    ]),
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    retryAt: timestampSchema.nullable(),
  })
  .strict();
export const publicModelCatalogPageSchema = z
  .object({
    items: z.array(publicModelCatalogItemSchema).max(50),
    nextCursor: z.string().min(1).max(128).nullable(),
    errors: z.array(publicModelCatalogErrorSchema).max(2),
  })
  .strict();
export type PublicModelCatalogPage = z.infer<typeof publicModelCatalogPageSchema>;
export const publicModelCatalogDetailInputSchema = z
  .object({
    source: z.enum(['hugging_face', 'localai_gallery']),
    sourceId: z.string().min(1).max(256),
  })
  .strict();
export type PublicModelCatalogDetailInput = z.infer<typeof publicModelCatalogDetailInputSchema>;
export const publicModelArtifactSchema = z
  .object({
    id: z.string().min(1).max(320),
    filename: z.string().min(1).max(512),
    format: z.enum(['gguf', 'other']),
    /** Semantic role within a Managed Local model bundle. A projector is still GGUF bytes. */
    role: z.enum(['model', 'mmproj']).default('model'),
    /** Fail-closed family key derived from the immutable artifact filename for model/mmproj pairing. */
    multimodalCompatibilityKey: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .max(128)
      .nullable()
      .optional(),
    quantization: z.string().min(1).max(64).nullable(),
    sizeBytes: localHardwareByteCountSchema.nullable(),
    sha256: digestSchema.nullable(),
    sourceUrl: z.string().url().max(2_048).nullable(),
    installability: publicModelInstallabilitySchema,
  })
  .strict();
export type PublicModelArtifact = z.infer<typeof publicModelArtifactSchema>;
export const publicModelCatalogDetailSchema = z
  .object({
    item: publicModelCatalogItemSchema,
    description: z.string().max(4_000),
    architecture: z.string().min(1).max(128).nullable(),
    parameterCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    contextTokens: z.number().int().positive().max(1_048_576).nullable(),
    toolTemplate: z.enum(['available', 'unavailable', 'unknown']),
    backend: z.string().min(1).max(128).nullable(),
    variants: z.array(z.string().min(1).max(256)).max(64),
    referenceUrls: z.array(z.string().url().max(2_048)).max(16),
    artifacts: z.array(publicModelArtifactSchema).max(256),
  })
  .strict();
export type PublicModelCatalogDetail = z.infer<typeof publicModelCatalogDetailSchema>;
export const localDownloadJobStateSchema = z.enum([
  'queued',
  'downloading',
  'paused',
  'interrupted',
  'verifying',
  'installed',
  'failed',
  'canceled',
]);
export type LocalDownloadJobState = z.infer<typeof localDownloadJobStateSchema>;
export const localDownloadFailureCodeSchema = z.enum([
  'network',
  'size_unknown',
  'size_changed',
  'disk_full',
  'source_changed',
  'hash_mismatch',
  'missing_shard',
  'unsafe_store',
  'delete_failed',
]);
export type LocalDownloadFailureCode = z.infer<typeof localDownloadFailureCodeSchema>;
export const localDownloadJobSchema = z
  .object({
    id: z.string().uuid(),
    modelId: z.string().regex(/^[a-f0-9]{64}$/u),
    /** Human-readable catalog identity. Optional across mixed-version preload upgrades. */
    sourceId: z.string().min(1).max(256).optional(),
    state: localDownloadJobStateSchema,
    artifactCount: z.number().int().min(1).max(256),
    completedArtifacts: z.number().int().min(0).max(256),
    downloadedBytes: localHardwareByteCountSchema,
    totalBytes: localHardwareByteCountSchema,
    failureCode: localDownloadFailureCodeSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((job, context) => {
    if (job.completedArtifacts > job.artifactCount)
      context.addIssue({
        code: 'custom',
        path: ['completedArtifacts'],
        message: 'Completed artifact count exceeds the job artifact count',
      });
    if (job.downloadedBytes > job.totalBytes)
      context.addIssue({
        code: 'custom',
        path: ['downloadedBytes'],
        message: 'Downloaded bytes exceed the job total',
      });
    if (
      (job.state === 'verifying' || job.state === 'installed') &&
      (job.completedArtifacts !== job.artifactCount || job.downloadedBytes !== job.totalBytes)
    )
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'Verified and installed jobs must contain every declared artifact byte',
      });
    if (job.state === 'failed' && job.failureCode === null)
      context.addIssue({
        code: 'custom',
        path: ['failureCode'],
        message: 'Failed jobs require a bounded failure code',
      });
  });
export type LocalDownloadJob = z.infer<typeof localDownloadJobSchema>;
export const installedLocalModelSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/u),
    source: z.enum(['hugging_face', 'localai_gallery']),
    sourceId: z.string().min(1).max(256),
    immutableRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
    quantization: z.string().min(1).max(64),
    artifactCount: z.number().int().min(1).max(256),
    totalBytes: localHardwareByteCountSchema,
    state: z.enum(['installing', 'installed', 'deleting', 'delete_failed']),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type InstalledLocalModel = z.infer<typeof installedLocalModelSchema>;

/** Typed, allowlisted llama.cpp launch controls stored per installed model. */
export const MANAGED_LOCAL_DEFAULT_GPU_LAYERS = 999;
export const MANAGED_LOCAL_DEFAULT_CONTEXT_TOKENS = 8_192;
export const MANAGED_LOCAL_DEFAULT_BATCH_SIZE = 512;
export const MANAGED_LOCAL_MAX_GPU_LAYERS = 4_096;
export const MANAGED_LOCAL_MAX_CONTEXT_TOKENS = 1_048_576;
export const MANAGED_LOCAL_MAX_BATCH_SIZE = 4_096;
export const MANAGED_LOCAL_MAX_MICRO_BATCH_SIZE = 512;

/** llama.cpp `--ubatch-size` in tokens, derived from the effective logical batch size. */
export function managedLocalMicroBatchSize(batchSize: number): number {
  return Math.min(batchSize, MANAGED_LOCAL_MAX_MICRO_BATCH_SIZE);
}
export const managedLocalLaunchBackendSchema = z.enum(['auto', 'cpu', 'metal', 'cuda', 'vulkan']);
export type ManagedLocalLaunchBackend = z.infer<typeof managedLocalLaunchBackendSchema>;
export const managedLocalEffectiveLaunchBackendSchema = z.enum(['cpu', 'metal', 'cuda', 'vulkan']);
export type ManagedLocalEffectiveLaunchBackend = z.infer<
  typeof managedLocalEffectiveLaunchBackendSchema
>;
function validateManagedLocalLaunchSettings(
  settings: {
    backend: ManagedLocalLaunchBackend;
    gpuLayers: number;
    contextTokens: number;
    batchSize: number;
  },
  context: z.RefinementCtx,
): void {
  if (settings.backend === 'cpu' && settings.gpuLayers !== 0)
    context.addIssue({
      code: 'custom',
      path: ['gpuLayers'],
      message: 'CPU Managed Local launch must use zero GPU layers',
    });
  if (settings.backend !== 'auto' && settings.backend !== 'cpu' && settings.gpuLayers === 0)
    context.addIssue({
      code: 'custom',
      path: ['gpuLayers'],
      message: 'Accelerated Managed Local launch must use GPU layers',
    });
  if (settings.batchSize > settings.contextTokens)
    context.addIssue({
      code: 'custom',
      path: ['batchSize'],
      message: 'Managed Local batch size cannot exceed context tokens',
    });
}
export const managedLocalLaunchSettingsSchema = z
  .object({
    backend: managedLocalLaunchBackendSchema,
    gpuLayers: z.number().int().min(0).max(MANAGED_LOCAL_MAX_GPU_LAYERS),
    contextTokens: z.number().int().min(256).max(MANAGED_LOCAL_MAX_CONTEXT_TOKENS),
    batchSize: z.number().int().positive().max(MANAGED_LOCAL_MAX_BATCH_SIZE),
  })
  .strict()
  .superRefine(validateManagedLocalLaunchSettings);
export type ManagedLocalLaunchSettings = z.infer<typeof managedLocalLaunchSettingsSchema>;
export const managedLocalLaunchSettingsMapSchema = z
  .record(z.string().regex(/^[a-f0-9]{64}$/u), managedLocalLaunchSettingsSchema)
  .superRefine((settings, context) => {
    if (Object.keys(settings).length > 256)
      context.addIssue({ code: 'custom', message: 'Too many Managed Local launch settings' });
  });
export type ManagedLocalLaunchSettingsMap = z.infer<typeof managedLocalLaunchSettingsMapSchema>;
export const managedLocalLaunchSettingsGetInputSchema = z
  .object({ modelId: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
export const managedLocalLaunchSettingsSetInputSchema = managedLocalLaunchSettingsGetInputSchema
  .extend(managedLocalLaunchSettingsSchema.shape)
  .strict()
  .superRefine(validateManagedLocalLaunchSettings);
export type ManagedLocalLaunchSettingsSetInput = z.infer<
  typeof managedLocalLaunchSettingsSetInputSchema
>;
export const managedLocalEffectiveLaunchSettingsSchema = z
  .object({
    backend: managedLocalEffectiveLaunchBackendSchema,
    gpuLayers: z.number().int().min(0).max(MANAGED_LOCAL_MAX_GPU_LAYERS),
    contextTokens: z.number().int().min(256).max(MANAGED_LOCAL_MAX_CONTEXT_TOKENS),
    batchSize: z.number().int().positive().max(MANAGED_LOCAL_MAX_BATCH_SIZE),
    runtimeVersion: z.string().regex(/^[a-zA-Z0-9._+-]{1,64}$/u),
  })
  .strict()
  .superRefine((settings, context) => {
    if (settings.backend === 'cpu' && settings.gpuLayers !== 0)
      context.addIssue({
        code: 'custom',
        path: ['gpuLayers'],
        message: 'CPU Managed Local launch must use zero GPU layers',
      });
    if (settings.backend !== 'cpu' && settings.gpuLayers === 0)
      context.addIssue({
        code: 'custom',
        path: ['gpuLayers'],
        message: 'Accelerated Managed Local launch must use GPU layers',
      });
    if (settings.batchSize > settings.contextTokens)
      context.addIssue({
        code: 'custom',
        path: ['batchSize'],
        message: 'Effective Managed Local batch size cannot exceed context tokens',
      });
  });
export type ManagedLocalEffectiveLaunchSettings = z.infer<
  typeof managedLocalEffectiveLaunchSettingsSchema
>;
export const managedLocalLaunchSettingsViewSchema = z
  .object({
    modelId: z.string().regex(/^[a-f0-9]{64}$/u),
    configured: managedLocalLaunchSettingsSchema,
    effective: managedLocalEffectiveLaunchSettingsSchema.nullable(),
    /** Whether one verified projector will be passed to llama.cpp as `--mmproj`. */
    multimodal: z.boolean(),
  })
  .strict();
export type ManagedLocalLaunchSettingsView = z.infer<typeof managedLocalLaunchSettingsViewSchema>;

/**
 * Request-level controls that Managed Local can actually honour.  llama.cpp does not expose the
 * built-in CLI's provider-specific Effort control, so this contract deliberately contains the
 * template's thinking switch instead of pretending that `low`/`high` map to a local runtime.
 */
export const MANAGED_LOCAL_DEFAULT_MAX_OUTPUT_TOKENS = 512;
export const MANAGED_LOCAL_MAX_OUTPUT_TOKENS = 131_072;
export const MANAGED_LOCAL_TOOL_MAX_OUTPUT_TOKENS = 1_024;
const managedLocalMaxOutputTokensSchema = z
  .number()
  .int()
  .min(1)
  .max(MANAGED_LOCAL_MAX_OUTPUT_TOKENS);
export const managedLocalInferenceSettingsSchema = z
  .object({
    maxOutputTokens: managedLocalMaxOutputTokensSchema,
    thinking: z.boolean(),
  })
  .strict();
export type ManagedLocalInferenceSettings = z.infer<typeof managedLocalInferenceSettingsSchema>;
export const managedLocalInferenceSettingsMapSchema = z
  .record(z.string().regex(/^[a-f0-9]{64}$/u), managedLocalInferenceSettingsSchema)
  .superRefine((settings, context) => {
    if (Object.keys(settings).length > 256)
      context.addIssue({ code: 'custom', message: 'Too many Managed Local model settings' });
  });
export type ManagedLocalInferenceSettingsMap = z.infer<
  typeof managedLocalInferenceSettingsMapSchema
>;
export const managedLocalInferenceSettingsGetInputSchema = z
  .object({ modelId: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
export const managedLocalInferenceSettingsSetInputSchema =
  managedLocalInferenceSettingsGetInputSchema
    .extend(managedLocalInferenceSettingsSchema.shape)
    .strict();
export type ManagedLocalInferenceSettingsSetInput = z.infer<
  typeof managedLocalInferenceSettingsSetInputSchema
>;

/** The values that the next ordinary `/v1/chat/completions` request will contain. */
export const managedLocalEffectiveInferenceSettingsSchema = z
  .object({
    maxOutputTokens: managedLocalMaxOutputTokensSchema,
    thinking: z.boolean(),
    /** `null` means the field is omitted; llama.cpp only gives `none` a defined meaning here. */
    reasoningEffort: z.literal('none').nullable(),
  })
  .strict();
export type ManagedLocalEffectiveInferenceSettings = z.infer<
  typeof managedLocalEffectiveInferenceSettingsSchema
>;

/** Tool extraction is a bounded internal subrequest and intentionally disables thinking. */
export const managedLocalToolInferenceSettingsSchema = z
  .object({
    maxOutputTokens: z.literal(MANAGED_LOCAL_TOOL_MAX_OUTPUT_TOKENS),
    thinking: z.literal(false),
    reasoningEffort: z.literal('none'),
  })
  .strict();
export type ManagedLocalToolInferenceSettings = z.infer<
  typeof managedLocalToolInferenceSettingsSchema
>;

export const managedLocalInferenceSettingsViewSchema = z
  .object({
    modelId: z.string().regex(/^[a-f0-9]{64}$/u),
    configured: managedLocalInferenceSettingsSchema,
    effective: managedLocalEffectiveInferenceSettingsSchema,
    toolCall: managedLocalToolInferenceSettingsSchema,
  })
  .strict();
export type ManagedLocalInferenceSettingsView = z.infer<
  typeof managedLocalInferenceSettingsViewSchema
>;

export const managedLocalRuntimeFailureCodeSchema = z.enum([
  'unsupported_target',
  'bundle_invalid',
  'backend_unavailable',
  'memory_unknown',
  'memory_insufficient',
  'model_busy',
  'startup_failed',
  'health_failed',
  'crashed',
  'stop_timeout',
]);
export const managedLocalRuntimeRecoverySchema = z
  .object({
    lowerContextTokens: z.number().int().min(256).max(1_048_576).nullable(),
    useCpuOnly: z.boolean(),
    detail: z.string().min(1).max(500),
  })
  .strict();
export const managedLocalRuntimeSnapshotSchema = z
  .object({
    state: z.enum(['unavailable', 'stopped', 'starting', 'running', 'stopping', 'crashed']),
    target: z
      .string()
      .regex(/^(?:darwin|win32|linux)-(?:x64|arm64)$/u)
      .nullable(),
    runtimeVersion: z
      .string()
      .regex(/^[a-zA-Z0-9._+-]{1,64}$/u)
      .nullable(),
    modelId: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    backend: z.enum(['cpu', 'metal', 'cuda', 'vulkan']).nullable(),
    gpuLayers: z.number().int().min(0).max(4_096).nullable(),
    contextTokens: z.number().int().min(256).max(1_048_576).nullable(),
    batchSize: z.number().int().positive().max(1_048_576).nullable(),
    activeLeaseCount: z.number().int().nonnegative().max(10_000),
    fit: localFitAssessmentSchema.nullable(),
    failureCode: managedLocalRuntimeFailureCodeSchema.nullable(),
    recovery: managedLocalRuntimeRecoverySchema.nullable(),
    observedAt: timestampSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const summaryFields = [
      snapshot.backend,
      snapshot.gpuLayers,
      snapshot.contextTokens,
      snapshot.batchSize,
    ];
    if (
      summaryFields.some((value) => value === null) !==
      summaryFields.every((value) => value === null)
    )
      context.addIssue({
        code: 'custom',
        message: 'Managed Local effective settings must be complete or absent',
      });
    if (
      snapshot.state === 'running' &&
      (snapshot.target === null ||
        snapshot.runtimeVersion === null ||
        snapshot.modelId === null ||
        snapshot.backend === null ||
        snapshot.gpuLayers === null ||
        snapshot.contextTokens === null ||
        snapshot.batchSize === null)
    )
      context.addIssue({ code: 'custom', message: 'Running Managed Local state is incomplete' });
    if (snapshot.backend === 'cpu' && snapshot.gpuLayers !== null && snapshot.gpuLayers !== 0)
      context.addIssue({
        code: 'custom',
        message: 'CPU Managed Local runtime must use zero GPU layers',
      });
    if (
      snapshot.backend !== null &&
      snapshot.backend !== 'cpu' &&
      snapshot.gpuLayers !== null &&
      snapshot.gpuLayers === 0
    )
      context.addIssue({
        code: 'custom',
        message: 'Accelerated Managed Local runtime must use GPU layers',
      });
    if ((snapshot.failureCode === null) !== (snapshot.recovery === null))
      context.addIssue({
        code: 'custom',
        message: 'Managed Local failure and recovery guidance must appear together',
      });
  });
export type ManagedLocalRuntimeSnapshot = z.infer<typeof managedLocalRuntimeSnapshotSchema>;
export const localModelInstallInputSchema = z
  .object({
    source: z.enum(['hugging_face', 'localai_gallery']),
    sourceId: z.string().min(1).max(256),
    artifactIds: z.array(z.string().min(1).max(320)).min(1).max(256),
    quantization: z.string().min(1).max(64),
    confirmed: z.literal(true),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.artifactIds).size !== input.artifactIds.length)
      context.addIssue({ code: 'custom', path: ['artifactIds'], message: 'Duplicate artifact id' });
  });
export type LocalModelInstallInput = z.infer<typeof localModelInstallInputSchema>;
export const localModelFitInputSchema = z
  .object({
    source: z.enum(['hugging_face', 'localai_gallery']),
    sourceId: z.string().min(1).max(256),
    artifactId: z.string().min(1).max(320),
    mmprojArtifactId: z.string().min(1).max(320).optional(),
    contextTokens: z.number().int().min(256).max(1_048_576),
  })
  .strict();
export type LocalModelFitInput = z.infer<typeof localModelFitInputSchema>;
export const localDownloadJobInputSchema = z.object({ jobId: z.string().uuid() }).strict();
export const localDownloadCancelInputSchema = localDownloadJobInputSchema.extend({
  confirmed: z.literal(true),
});
export const installedLocalModelInputSchema = z
  .object({ modelId: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
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
            runtimeKind: z.enum(['codex', 'claude']),
            migratedCount: z.number().int().min(0).max(1_000_000),
            resetCount: z.number().int().min(0).max(1_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(2),
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
    codexCli: resolvedCliCommandSchema.nullable().default(null),
    claudeCli: resolvedCliCommandSchema.nullable().default(null),
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

export const emptyPayloadSchema = z.object({}).strict();
export const skillProviderSchema = z.enum(['claude', 'agents']);
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
    compatibility: skillCompatibilityReportSchema,
  })
  .strict();
export const skillImportInputSchema = z
  .object({ previewId: z.string().uuid(), nativeModeConfirmed: z.boolean().default(false) })
  .strict();
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
export type SkillSource = z.infer<typeof skillSourceSchema>;
export type SkillKind = z.infer<typeof skillKindSchema>;
export type SkillRef = z.infer<typeof skillRefSchema>;
export type TurnSkillSelection = z.infer<typeof turnSkillSelectionSchema>;
export type SkillCatalogItem = z.infer<typeof skillCatalogItemSchema>;
export type SkillCatalog = z.infer<typeof skillCatalogSchema>;
export type SkillCandidateSummary = z.infer<typeof skillCandidateSummarySchema>;
export type SkillScanResult = z.infer<typeof skillScanResultSchema>;
export type SkillPreviewResult = z.infer<typeof skillPreviewResultSchema>;
export type SkillImportResult = z.infer<typeof skillImportResultSchema>;
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
    objective: z.string().trim().min(1).max(4000),
    skills: turnSkillSelectionsSchema.default([]),
  })
  .strict();
export const goalControlInputSchema = z.object({ taskId: idSchema }).strict();
export const goalResumeInputSchema = z
  .object({ taskId: idSchema, skills: turnSkillSelectionsSchema.default([]) })
  .strict();
export const goalRunResultSchema = z.object({ task: taskSummarySchema, turnId: idSchema }).strict();
export const taskDraftInputSchema = z.object({ taskId: idSchema, draft: taskTextSchema }).strict();
const turnTextAndSkillsInputShape = {
  taskId: idSchema,
  text: z.string().trim().min(1).max(100_000),
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
    text: z.string().trim().min(1).max(100_000),
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

/*
 * Computer Use contracts (Issue #333)
 *
 * These DTOs deliberately describe identity and bounded observations rather than OS handles.
 * Process ids, window handles, executable paths, raw provider responses, and active grants never
 * cross the renderer boundary.  Main may use the richer native identity internally, while the
 * profile and picker contracts below expose only stable, non-authoritative fingerprints.
 */

export const computerUseModeSchema = z.enum(['observe_only', 'supervised', 'full_access_app']);
export type ComputerUseMode = z.infer<typeof computerUseModeSchema>;
const COMPUTER_USE_MODE_RANK: Readonly<Record<ComputerUseMode, number>> = Object.freeze({
  observe_only: 0,
  supervised: 1,
  full_access_app: 2,
});

/** Returns the least-privileged mode attested by every supplied boundary. */
export function bindComputerUseMaximumMode(...modes: readonly ComputerUseMode[]): ComputerUseMode {
  if (modes.length === 0) return 'observe_only';
  return modes.reduce((least, mode) =>
    COMPUTER_USE_MODE_RANK[mode] < COMPUTER_USE_MODE_RANK[least] ? mode : least,
  );
}

export function computerUseModeIsWithinMaximum(
  mode: ComputerUseMode,
  maximumMode: ComputerUseMode,
): boolean {
  return COMPUTER_USE_MODE_RANK[mode] <= COMPUTER_USE_MODE_RANK[maximumMode];
}
/**
 * Language for which the target application's native UI was attested. `unknown` is a negative
 * capability fact: it can be observed or supervised, but it never authorizes full-access input.
 */
export const computerUsePolicyLanguageSchema = z.enum(['en', 'ja', 'unknown']);
export type ComputerUsePolicyLanguage = z.infer<typeof computerUsePolicyLanguageSchema>;

export function computerUsePolicyLanguageIsSupported(
  language: ComputerUsePolicyLanguage,
): language is Exclude<ComputerUsePolicyLanguage, 'unknown'> {
  return language === 'en' || language === 'ja';
}

/** Returns the common supported attestation, or `unknown` for missing/mixed evidence. */
export function bindComputerUsePolicyLanguage(
  ...languages: readonly ComputerUsePolicyLanguage[]
): ComputerUsePolicyLanguage {
  const first = languages[0];
  return first !== undefined &&
    computerUsePolicyLanguageIsSupported(first) &&
    languages.every((language) => language === first)
    ? first
    : 'unknown';
}

/** Runtime availability can be reported on every desktop; only these two platforms attach. */
export const computerUseRuntimePlatformSchema = z.enum(['darwin', 'win32', 'linux', 'other']);
export type ComputerUseRuntimePlatform = z.infer<typeof computerUseRuntimePlatformSchema>;
/** Identity and native input contracts are deliberately narrower than runtime availability. */
export const computerUsePlatformSchema = z.enum(['darwin', 'win32']);
export type ComputerUsePlatform = z.infer<typeof computerUsePlatformSchema>;
export const computerUsePickerKindSchema = z.enum(['menu', 'dialog', 'shortcut', 'explicit']);
export type ComputerUsePickerKind = z.infer<typeof computerUsePickerKindSchema>;

export const computerUseResultSchema = z.enum([
  'completed',
  'rejected',
  'paused',
  'canceled',
  'unknown_effect',
]);
export type ComputerUseResult = z.infer<typeof computerUseResultSchema>;

export const computerUseActionKindSchema = z.enum([
  'invoke',
  'set_text',
  'select',
  'toggle',
  'expand_collapse',
  'scroll',
  'click',
  'type',
  'key',
  'wait',
  'finish',
]);
export type ComputerUseActionKind = z.infer<typeof computerUseActionKindSchema>;

export const computerUseKeySchema = z.enum([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
]);
export type ComputerUseKey = z.infer<typeof computerUseKeySchema>;

const computerUseIdSchema = z.string().min(1).max(128);
const computerUseDigestSchema = digestSchema;
const computerUseLabelSchema = z.string().trim().min(1).max(256);
const computerUseConnectionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const computerUseModelIdSchema = z.string().trim().min(1).max(256);
const computerUseProviderEgressConsentBindingSchema = z
  .object({ connectionId: computerUseConnectionIdSchema, modelId: computerUseModelIdSchema })
  .strict();
export type ComputerUseProviderEgressConsentBinding = z.infer<
  typeof computerUseProviderEgressConsentBindingSchema
>;
const computerUseUtf8TextSchema = z
  .string()
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 4_096,
    'Text action exceeds the 4096-byte UTF-8 limit',
  );
const computerUsePreviewSchema = z.string().max(256, 'Approval preview exceeds 256 characters');

/** Native-side identity. It is never accepted from a renderer registration request. */
export const computerWindowsAppIdentitySchema = z
  .object({
    platform: z.literal('win32'),
    identityDigest: computerUseDigestSchema,
    executablePath: z.string().min(1).max(4_096),
    executableDigest: computerUseDigestSchema,
    signerDigest: computerUseDigestSchema.nullable(),
    packageFamilyName: z.string().min(1).max(256).nullable(),
    appUserModelId: z.string().min(1).max(256).nullable(),
    displayName: computerUseLabelSchema,
    policyLanguage: computerUsePolicyLanguageSchema.default('unknown'),
    maximumMode: computerUseModeSchema.default('observe_only'),
  })
  .strict();
export type ComputerWindowsAppIdentity = z.infer<typeof computerWindowsAppIdentitySchema>;

/** Native-side identity. It is never accepted from a renderer registration request. */
export const computerMacosAppIdentitySchema = z
  .object({
    platform: z.literal('darwin'),
    identityDigest: computerUseDigestSchema,
    bundleId: z.string().min(1).max(256),
    executablePath: z.string().min(1).max(4_096),
    executableDigest: computerUseDigestSchema,
    teamId: z.string().min(1).max(64).nullable(),
    signingIdentifier: z.string().min(1).max(256).nullable(),
    cdHash: computerUseDigestSchema.nullable(),
    displayName: computerUseLabelSchema,
    policyLanguage: computerUsePolicyLanguageSchema.default('unknown'),
    maximumMode: computerUseModeSchema.default('observe_only'),
  })
  .strict();
export type ComputerMacosAppIdentity = z.infer<typeof computerMacosAppIdentitySchema>;

export const computerAppIdentitySchema = z.discriminatedUnion('platform', [
  computerWindowsAppIdentitySchema,
  computerMacosAppIdentitySchema,
]);
export type ComputerAppIdentity = z.infer<typeof computerAppIdentitySchema>;
export const computerUseAppIdentitySchema = computerAppIdentitySchema;

/**
 * Stable identity facts that may be sent by a picker.  In particular this schema has no `path`,
 * `pid`, `processId`, `windowHandle`, or HWND field; Main obtains and verifies those facts itself.
 */
export const computerAppIdentityRefSchema = z
  .object({
    platform: computerUsePlatformSchema,
    identityDigest: computerUseDigestSchema,
    displayName: computerUseLabelSchema,
    bundleId: z.string().min(1).max(256).nullable().optional(),
    packageFamilyName: z.string().min(1).max(256).nullable().optional(),
    signerDigest: computerUseDigestSchema.nullable().optional(),
    teamId: z.string().min(1).max(64).nullable().optional(),
    policyLanguage: computerUsePolicyLanguageSchema.default('unknown'),
    maximumMode: computerUseModeSchema.default('observe_only'),
  })
  .strict();
export type ComputerAppIdentityRef = z.infer<typeof computerAppIdentityRefSchema>;

const computerUseBoundsSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive().max(32_768),
    height: z.number().finite().positive().max(32_768),
  })
  .strict();

export const computerUseWindowCandidateSchema = z
  .object({
    windowId: computerUseIdSchema,
    platform: computerUsePlatformSchema.optional(),
    appIdentityDigest: computerUseDigestSchema,
    windowIdentityDigest: computerUseDigestSchema,
    title: computerUseLabelSchema,
    bounds: computerUseBoundsSchema,
    focused: z.boolean(),
    eligible: z.boolean(),
    ownerKind: z.enum(['application', 'dialog', 'unknown']),
    modal: z.boolean(),
    revision: z.number().int().nonnegative(),
    policyLanguage: computerUsePolicyLanguageSchema.default('unknown'),
    maximumMode: computerUseModeSchema.default('observe_only'),
  })
  .strict();
export type ComputerUseWindowCandidate = z.infer<typeof computerUseWindowCandidateSchema>;
export const computerUseWindowSchema = computerUseWindowCandidateSchema;

export const computerUseAvailabilityStateSchema = z.enum([
  'ready',
  'feature_disabled',
  'unsupported_platform',
  'unsigned_package',
  'native_unavailable',
  'handshake_failed',
]);
export type ComputerUseAvailabilityState = z.infer<typeof computerUseAvailabilityStateSchema>;

export const computerUseAvailabilitySchema = z
  .object({
    platform: computerUseRuntimePlatformSchema,
    state: computerUseAvailabilityStateSchema,
    featureEnabled: z.boolean(),
    packageReady: z.boolean(),
    handshakeReady: z.boolean(),
    observe: z.boolean(),
    control: z.boolean(),
    available: z.boolean(),
    reasonCode: z
      .string()
      .regex(/^[a-z][a-z0-9._-]{0,63}$/)
      .nullable(),
    manifestDigest: computerUseDigestSchema.nullable(),
  })
  .strict()
  .superRefine((availability, context) => {
    const nativeBoundaryReady =
      availability.featureEnabled && availability.packageReady && availability.handshakeReady;
    if (availability.available !== (nativeBoundaryReady && availability.observe))
      context.addIssue({ code: 'custom', message: 'Availability does not match its gates' });
    if (availability.control && !availability.available)
      context.addIssue({
        code: 'custom',
        message: 'Control cannot be available when observe is not',
      });
    if (
      availability.state === 'ready' &&
      (!nativeBoundaryReady || !availability.observe || !availability.available)
    )
      context.addIssue({ code: 'custom', message: 'Ready availability requires all gates' });
    if (availability.state !== 'ready' && nativeBoundaryReady && availability.observe)
      context.addIssue({ code: 'custom', message: 'A failed state cannot have all gates ready' });
  });
export type ComputerUseAvailability = z.infer<typeof computerUseAvailabilitySchema>;
export const computerUseAvailabilityResultSchema = computerUseAvailabilitySchema;

export const computerUseProfileRegisterInputSchema = z
  // Main consumes a recent trusted input and opens the OS picker. No identity fact is accepted
  // from Renderer; provider/mode preferences are selected on the second onboarding screen.
  .object({ taskId: computerUseIdSchema })
  .strict();
export type ComputerUseProfileRegisterInput = z.infer<typeof computerUseProfileRegisterInputSchema>;

export const computerAppProfileSchema = z
  .object({
    id: computerUseIdSchema,
    label: computerUseLabelSchema,
    identity: computerAppIdentityRefSchema,
    mode: computerUseModeSchema,
    connectionId: computerUseConnectionIdSchema,
    modelId: computerUseModelIdSchema,
    providerEgressConsent: z.boolean(),
    remember: z.boolean().default(true),
    profileRevision: z.number().int().nonnegative().default(0),
    policyLanguage: computerUsePolicyLanguageSchema.default('unknown'),
    maximumMode: computerUseModeSchema.default('observe_only'),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.policyLanguage !== profile.identity.policyLanguage)
      context.addIssue({
        code: 'custom',
        message: 'Profile policy language must match its native identity attestation',
      });
    if (profile.maximumMode !== profile.identity.maximumMode)
      context.addIssue({
        code: 'custom',
        message: 'Profile maximum mode must match its native identity attestation',
      });
    if (!computerUseModeIsWithinMaximum(profile.mode, profile.maximumMode))
      context.addIssue({
        code: 'custom',
        message: 'Profile mode exceeds its native maximum mode',
      });
  });
export type ComputerAppProfile = z.infer<typeof computerAppProfileSchema>;
export const computerUseProfileSchema = computerAppProfileSchema;
export const computerUseAppProfileSchema = computerAppProfileSchema;

export const computerUseProfilePreferenceSetInputSchema = z
  .object({
    profileId: computerUseIdSchema,
    expectedProfileRevision: z.number().int().nonnegative(),
    label: computerUseLabelSchema.optional(),
    mode: computerUseModeSchema.optional(),
    connectionId: computerUseConnectionIdSchema.optional(),
    modelId: computerUseModelIdSchema.optional(),
    providerEgressConsent: z.boolean().optional(),
    remember: z.boolean().optional(),
  })
  .strict()
  .refine(
    ({ label, mode, connectionId, modelId, providerEgressConsent, remember }) =>
      label !== undefined ||
      mode !== undefined ||
      connectionId !== undefined ||
      modelId !== undefined ||
      providerEgressConsent !== undefined ||
      remember !== undefined,
    'Profile preference update cannot be empty',
  );
export type ComputerUseProfilePreferenceSetInput = z.infer<
  typeof computerUseProfilePreferenceSetInputSchema
>;
export const computerUseProfileUpdateInputSchema = computerUseProfilePreferenceSetInputSchema;

export const computerUseProfileListInputSchema = z
  .object({ taskId: computerUseIdSchema.optional() })
  .strict();
export type ComputerUseProfileListInput = z.infer<typeof computerUseProfileListInputSchema>;
export const computerUseProfileListResultSchema = z
  .object({ profiles: z.array(computerAppProfileSchema).max(64) })
  .strict();
export type ComputerUseProfileListResult = z.infer<typeof computerUseProfileListResultSchema>;
export const computerUseWindowCandidatesInputSchema = z
  .object({ taskId: computerUseIdSchema, profileId: computerUseIdSchema })
  .strict();
export type ComputerUseWindowCandidatesInput = z.infer<
  typeof computerUseWindowCandidatesInputSchema
>;
export const computerUseWindowCandidatesResultSchema = z
  .object({
    profileId: computerUseIdSchema,
    candidates: z.array(computerUseWindowCandidateSchema).max(64),
  })
  .strict();
export type ComputerUseWindowCandidatesResult = z.infer<
  typeof computerUseWindowCandidatesResultSchema
>;

export const computerUseStartInputSchema = z
  .object({
    taskId: computerUseIdSchema,
    /** Reuses the start consent lane to resume the exact paused ephemeral session. */
    resumeSessionId: computerUseIdSchema.optional(),
    profileId: computerUseIdSchema,
    windowId: computerUseIdSchema,
    mode: computerUseModeSchema.default('full_access_app'),
    connectionId: computerUseConnectionIdSchema,
    modelId: computerUseModelIdSchema,
    providerEgressConsent: z.boolean(),
    providerEgressConsentBinding: computerUseProviderEgressConsentBindingSchema,
    remember: z.boolean().default(false),
    expectedPolicyEpoch: z.number().int().nonnegative(),
    expectedWindowRevision: z.number().int().positive(),
    expectedProfileRevision: z.number().int().positive(),
  })
  .strict();
export type ComputerUseStartInput = z.infer<typeof computerUseStartInputSchema>;

export const computerUseStopReasonSchema = z.enum([
  'user_stop',
  'emergency_stop',
  'task_changed',
  'turn_started',
  'policy_changed',
  'window_closed',
  'app_closed',
  'focus_lost',
  'stale_observation',
  'file_picker',
  'os_prompt',
  'user_takeover',
  'renderer_reloaded',
  'limit_reached',
  'native_unavailable',
  'error',
]);
export type ComputerUseStopReason = z.infer<typeof computerUseStopReasonSchema>;

export const computerUseSessionStateSchema = z.enum([
  'starting',
  'observing',
  'planning',
  'acting',
  'awaiting_approval',
  'paused',
  'stopping',
  'stopped',
  'failed',
]);
export type ComputerUseSessionState = z.infer<typeof computerUseSessionStateSchema>;

export const computerUseSessionStatusSchema = z
  .object({
    sessionId: computerUseIdSchema,
    taskId: computerUseIdSchema,
    profileId: computerUseIdSchema,
    windowId: computerUseIdSchema,
    connectionId: computerUseConnectionIdSchema,
    modelId: computerUseModelIdSchema,
    appIdentityDigest: computerUseDigestSchema,
    windowIdentityDigest: computerUseDigestSchema,
    profileRevision: z.number().int().nonnegative().default(0),
    mode: computerUseModeSchema,
    maximumMode: computerUseModeSchema.default('observe_only'),
    policyLanguage: computerUsePolicyLanguageSchema.default('unknown'),
    state: computerUseSessionStateSchema,
    statusRevision: z.number().int().nonnegative().default(0),
    policyEpoch: z.number().int().nonnegative(),
    observationRevision: z.number().int().nonnegative(),
    round: z.number().int().nonnegative().max(25),
    maxRounds: z.literal(25),
    startedAt: timestampSchema,
    expiresAt: timestampSchema,
    lastObservationAt: timestampSchema.nullable(),
    stopReason: computerUseStopReasonSchema.nullable(),
    /** Ephemeral card for the current action; Main must never persist its preview. */
    pendingApproval: z
      .lazy(() => computerUseApprovalSchema)
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((status, context) => {
    const startedAt = Date.parse(status.startedAt);
    const expiresAt = Date.parse(status.expiresAt);
    if (expiresAt <= startedAt)
      context.addIssue({ code: 'custom', message: 'Session expiry must be after start' });
    if (expiresAt - startedAt > 8 * 60 * 60 * 1_000)
      context.addIssue({ code: 'custom', message: 'Session exceeds the eight-hour limit' });
    if (status.state === 'stopped' && status.stopReason === null)
      context.addIssue({ code: 'custom', message: 'Stopped session requires a stop reason' });
    if (status.state !== 'stopped' && status.stopReason !== null)
      context.addIssue({ code: 'custom', message: 'Only stopped sessions have a stop reason' });
    if (
      status.mode === 'full_access_app' &&
      !computerUsePolicyLanguageIsSupported(status.policyLanguage)
    )
      context.addIssue({
        code: 'custom',
        message: 'Full access requires a supported target policy language attestation',
      });
    if (!computerUseModeIsWithinMaximum(status.mode, status.maximumMode))
      context.addIssue({ code: 'custom', message: 'Session mode exceeds its native maximum mode' });
  });
export type ComputerUseSessionStatus = z.infer<typeof computerUseSessionStatusSchema>;
export const computerUseSessionSchema = computerUseSessionStatusSchema;
export const computerUseStatusSchema = computerUseSessionStatusSchema;
export type ComputerUseSession = ComputerUseSessionStatus;
export const computerUseSessionStatusInputSchema = z
  .object({ sessionId: computerUseIdSchema })
  .strict();
export type ComputerUseSessionStatusInput = z.infer<typeof computerUseSessionStatusInputSchema>;
export const computerUseStopInputSchema = z
  .object({ sessionId: computerUseIdSchema, reason: computerUseStopReasonSchema })
  .strict();
export type ComputerUseStopInput = z.infer<typeof computerUseStopInputSchema>;

const normalizedCoordinateSchema = z.number().finite().min(0).max(1);
const semanticTargetSchema = z.string().min(1).max(128);
const semanticArgumentsSchema = z
  .record(z.string(), z.json())
  .refine((value) => Object.keys(value).length <= 64, 'Too many semantic action arguments');

const computerInvokeActionSchema = z
  .object({
    type: z.literal('invoke'),
    targetId: semanticTargetSchema,
    name: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
    arguments: semanticArgumentsSchema.default({}),
  })
  .strict();
const computerSetTextActionSchema = z
  .object({
    type: z.literal('set_text'),
    targetId: semanticTargetSchema,
    text: computerUseUtf8TextSchema,
  })
  .strict();
const computerSelectActionSchema = z
  .object({
    type: z.literal('select'),
    targetId: semanticTargetSchema,
    value: computerUseUtf8TextSchema,
  })
  .strict();
const computerToggleActionSchema = z
  .object({ type: z.literal('toggle'), targetId: semanticTargetSchema, value: z.boolean() })
  .strict();
const computerExpandCollapseActionSchema = z
  .object({
    type: z.literal('expand_collapse'),
    targetId: semanticTargetSchema,
    expanded: z.boolean(),
  })
  .strict();
const computerScrollActionSchema = z
  .object({
    type: z.literal('scroll'),
    x: normalizedCoordinateSchema,
    y: normalizedCoordinateSchema,
    deltaX: z.number().finite().int().min(-10_000).max(10_000).default(0),
    deltaY: z.number().finite().int().min(-10_000).max(10_000),
  })
  .strict()
  .refine(({ deltaX, deltaY }) => deltaX !== 0 || deltaY !== 0, 'Scroll delta cannot be zero');
const computerClickActionSchema = z
  .object({
    type: z.literal('click'),
    x: normalizedCoordinateSchema,
    y: normalizedCoordinateSchema,
    button: z.literal('left').default('left'),
  })
  .strict();
const computerTypeActionSchema = z
  .object({ type: z.literal('type'), text: computerUseUtf8TextSchema })
  .strict();
const computerKeyActionSchema = z
  .object({ type: z.literal('key'), key: computerUseKeySchema })
  .strict();
const computerWaitActionSchema = z
  .object({ type: z.literal('wait'), milliseconds: z.number().int().min(0).max(5_000) })
  .strict();
const computerFinishActionSchema = z
  .object({
    type: z.literal('finish'),
    reason: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export const computerUseNormalizedCoordinateSchema = normalizedCoordinateSchema;
export const computerUseTextActionSchema = computerUseUtf8TextSchema;

const computerUseActionUnionSchema = z.discriminatedUnion('type', [
  computerInvokeActionSchema,
  computerSetTextActionSchema,
  computerSelectActionSchema,
  computerToggleActionSchema,
  computerExpandCollapseActionSchema,
  computerScrollActionSchema,
  computerClickActionSchema,
  computerTypeActionSchema,
  computerKeyActionSchema,
  computerWaitActionSchema,
  computerFinishActionSchema,
]);

/** V1 deliberately accepts one discriminator and rejects aliases or unknown fields. */
export const computerUseActionSchema = computerUseActionUnionSchema;
export type ComputerUseAction = z.infer<typeof computerUseActionSchema>;

export const computerUseActionResultSchema = z
  .object({
    actionId: computerUseIdSchema,
    sessionId: computerUseIdSchema,
    observationRevision: z.number().int().nonnegative(),
    result: computerUseResultSchema,
    reasonCode: z
      .string()
      .regex(/^[a-z][a-z0-9._-]{0,63}$/)
      .nullable(),
  })
  .strict();
export type ComputerUseActionResult = z.infer<typeof computerUseActionResultSchema>;

export const computerUseImageSchema = z
  .object({
    mimeType: z.enum(['image/png', 'image/jpeg']),
    digest: computerUseDigestSchema,
    byteLength: z
      .number()
      .int()
      .positive()
      .max(8 * 1024 * 1024),
    width: z.number().int().positive().max(2_560),
    height: z.number().int().positive().max(1_600),
    /** Ephemeral transport only; Main never persists this field. */
    base64: z.string().max(12_000_000).optional(),
  })
  .strict();
export type ComputerUseImage = z.infer<typeof computerUseImageSchema>;

export const computerUseObservationSchema = z
  .object({
    sessionId: computerUseIdSchema,
    appIdentityDigest: computerUseDigestSchema,
    windowIdentityDigest: computerUseDigestSchema,
    profileRevision: z.number().int().nonnegative().default(0),
    policyLanguage: computerUsePolicyLanguageSchema.default('unknown'),
    maximumMode: computerUseModeSchema.default('observe_only'),
    screenBounds: computerUseBoundsSchema,
    revision: z.number().int().nonnegative(),
    observedAt: timestampSchema,
    expiresAt: timestampSchema,
    clientWidth: z.number().int().positive().max(2_560),
    clientHeight: z.number().int().positive().max(1_600),
    images: z.array(computerUseImageSchema).min(1).max(2),
    treeDigest: computerUseDigestSchema.nullable(),
    treeByteLength: z
      .number()
      .int()
      .nonnegative()
      .max(512 * 1024),
    treeDepth: z.number().int().nonnegative().max(16),
    treeNodeCount: z.number().int().nonnegative().max(5_000),
    /** Main/native-only fields. They are bounded and are never included in durable status/events. */
    accessibilityTree: z.string().optional(),
    targetSignatures: z.record(z.string(), z.string().max(256)).optional(),
    targetMetadata: z
      .record(
        z.string().min(1).max(128),
        z.object({ secure: z.boolean().optional(), highImpact: z.boolean().optional() }).strict(),
      )
      .optional(),
    /** Digest of the currently focused native control; never contains control text. */
    focusedElementSignature: computerUseDigestSchema.nullable().optional(),
    focusedElementSecure: z.boolean().optional(),
    focusedElementHighImpact: z.boolean().optional(),
    /** Native-only binding for the selected window plus its current same-owner dialog set. */
    dialogSetRevision: z.number().int().nonnegative().optional(),
    dialogSetDigest: computerUseDigestSchema.nullable().optional(),
    activeWindowIdentityDigest: computerUseDigestSchema.nullable().optional(),
    activeWindowKind: z.enum(['application', 'dialog']).optional(),
  })
  .strict()
  .superRefine((observation, context) => {
    const observedAt = Date.parse(observation.observedAt);
    const expiresAt = Date.parse(observation.expiresAt);
    if (expiresAt <= observedAt)
      context.addIssue({
        code: 'custom',
        message: 'Observation expiry must be after observation time',
      });
    if (expiresAt - observedAt > 30_000)
      context.addIssue({ code: 'custom', message: 'Observation exceeds the 30-second TTL' });
    const totalBytes = observation.images.reduce((sum, image) => sum + image.byteLength, 0);
    if (totalBytes > 16 * 1024 * 1024)
      context.addIssue({
        code: 'custom',
        message: 'Observation image bytes exceed the 16MiB limit',
      });
    if (observation.treeDigest === null && observation.treeByteLength !== 0)
      context.addIssue({ code: 'custom', message: 'Tree byte count requires a tree digest' });
    if (
      observation.treeDigest === null &&
      (observation.treeDepth !== 0 || observation.treeNodeCount !== 0)
    )
      context.addIssue({ code: 'custom', message: 'Tree shape requires a tree digest' });
    if (observation.treeDigest !== null && observation.treeByteLength === 0)
      context.addIssue({ code: 'custom', message: 'Tree digest requires a non-empty tree' });
    if (
      observation.accessibilityTree !== undefined &&
      new TextEncoder().encode(observation.accessibilityTree).byteLength > 512 * 1024
    )
      context.addIssue({ code: 'custom', message: 'Accessibility tree exceeds the 512KiB limit' });
    if (
      observation.targetSignatures !== undefined &&
      Object.keys(observation.targetSignatures).length > 5_000
    )
      context.addIssue({ code: 'custom', message: 'Too many accessibility target signatures' });
    if (
      observation.targetMetadata !== undefined &&
      Object.keys(observation.targetMetadata).length > 5_000
    )
      context.addIssue({
        code: 'custom',
        message: 'Too many accessibility target metadata entries',
      });
  });
export type ComputerUseObservation = z.infer<typeof computerUseObservationSchema>;

export const computerUseAccessibilityTreeSchema = z
  .object({
    digest: computerUseDigestSchema,
    byteLength: z
      .number()
      .int()
      .positive()
      .max(512 * 1024),
    depth: z.number().int().nonnegative().max(16),
    nodeCount: z.number().int().positive().max(5_000),
    /** Ephemeral transport only; Main never persists this field. */
    serialized: z.string().optional(),
  })
  .strict()
  .superRefine((tree, context) => {
    if (
      tree.serialized !== undefined &&
      new TextEncoder().encode(tree.serialized).byteLength > 512 * 1024
    )
      context.addIssue({ code: 'custom', message: 'Accessibility tree exceeds the 512KiB limit' });
  });
export type ComputerUseAccessibilityTree = z.infer<typeof computerUseAccessibilityTreeSchema>;

export const computerUseProviderResponseSchema = z
  .string()
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 64 * 1024,
    'Provider response exceeds the 64KiB limit',
  );

export const computerUseApprovalDecisionSchema = z.enum(['allow_once', 'allow_plan', 'deny']);
export type ComputerUseApprovalDecision = z.infer<typeof computerUseApprovalDecisionSchema>;
export const computerUsePlanEligibleActionKinds = [
  'invoke',
  'set_text',
  'select',
  'toggle',
  'expand_collapse',
] as const satisfies readonly ComputerUseActionKind[];
export function computerUseActionKindIsPlanEligible(kind: ComputerUseActionKind): boolean {
  return (computerUsePlanEligibleActionKinds as readonly ComputerUseActionKind[]).includes(kind);
}
export const computerUseApprovalSchema = z
  .object({
    id: computerUseIdSchema,
    sessionId: computerUseIdSchema,
    taskId: computerUseIdSchema,
    turnId: computerUseIdSchema.optional(),
    callId: computerUseIdSchema.optional(),
    actionType: computerUseActionKindSchema,
    actionDigest: computerUseDigestSchema,
    targetLabel: computerUseLabelSchema,
    preview: computerUsePreviewSchema,
    risk: toolRiskSchema,
    policyEpoch: z.number().int().nonnegative(),
    observationRevision: z.number().int().nonnegative(),
    eligibleForPlan: z.boolean(),
    allowedDecisions: z.array(computerUseApprovalDecisionSchema).min(2).max(3),
    state: z.enum(['pending', 'resolved', 'canceled', 'stale', 'expired']),
    decision: computerUseApprovalDecisionSchema.nullable(),
    revision: z.number().int().nonnegative(),
    challenge: z.string().min(8).max(256),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    decidedAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine((approval, context) => {
    if (new Set(approval.allowedDecisions).size !== approval.allowedDecisions.length)
      context.addIssue({ code: 'custom', message: 'Approval decisions must be unique' });
    if (!approval.allowedDecisions.includes('allow_once'))
      context.addIssue({ code: 'custom', message: 'Approval must offer allow_once' });
    if (!approval.allowedDecisions.includes('deny'))
      context.addIssue({ code: 'custom', message: 'Approval must offer deny' });
    const onlyOnce = !computerUseActionKindIsPlanEligible(approval.actionType);
    if (onlyOnce && approval.eligibleForPlan)
      context.addIssue({
        code: 'custom',
        message: 'Only the exact semantic action set can allow a plan',
      });
    if (onlyOnce && approval.allowedDecisions.includes('allow_plan'))
      context.addIssue({
        code: 'custom',
        message: 'Non-plan Computer Use approvals are allow_once only',
      });
    if (!approval.eligibleForPlan && approval.allowedDecisions.includes('allow_plan'))
      context.addIssue({
        code: 'custom',
        message: 'Non-eligible Computer Use actions are allow_once only',
      });
    if (approval.eligibleForPlan && !approval.allowedDecisions.includes('allow_plan'))
      context.addIssue({ code: 'custom', message: 'Plan-eligible approval must offer allow_plan' });
    if (approval.state === 'resolved') {
      if (approval.decision === null || approval.decidedAt === undefined)
        context.addIssue({
          code: 'custom',
          message: 'Resolved Computer Use approval needs a decision',
        });
    } else if (approval.decision !== null || approval.decidedAt !== undefined) {
      context.addIssue({ code: 'custom', message: 'Only resolved approvals may carry a decision' });
    }
  });
export type ComputerUseApproval = z.infer<typeof computerUseApprovalSchema>;
/** Resolving a card returns fresh session status; the transient card itself is not a durable DTO. */
export const computerUseApprovalResolutionSchema = computerUseSessionStatusSchema;
export type ComputerUseApprovalResolution = ComputerUseSessionStatus;
export const computerUseApprovalResolveInputSchema = z
  .object({
    approvalId: computerUseIdSchema,
    expectedRevision: z.number().int().nonnegative(),
    decision: computerUseApprovalDecisionSchema,
    challenge: z.string().min(8).max(256),
  })
  .strict();
export type ComputerUseApprovalResolveInput = z.infer<typeof computerUseApprovalResolveInputSchema>;

export const computerUseNativeCapabilitySchema = z.enum([
  'observe',
  'capture',
  'accessibility',
  'input',
]);
export const computerUseNativeManifestSchema = z
  .object({
    version: z.literal(1),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    platform: computerUsePlatformSchema,
    architecture: z.enum(['x64', 'arm64']),
    protocolVersion: z.number().int().positive(),
    apiVersion: z.number().int().positive(),
    nativeVersion: z.string().min(1).max(64),
    moduleDigest: computerUseDigestSchema,
    binaryDigest: computerUseDigestSchema,
    signerDigest: computerUseDigestSchema.nullable(),
    capabilities: z.array(computerUseNativeCapabilitySchema).min(1).max(4),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (new Set(manifest.capabilities).size !== manifest.capabilities.length)
      context.addIssue({ code: 'custom', message: 'Native capabilities must be unique' });
    if (manifest.platform === 'win32' && manifest.architecture !== 'x64')
      context.addIssue({ code: 'custom', message: 'Windows Computer Use is x64-only' });
  });
export type ComputerUseNativeManifest = z.infer<typeof computerUseNativeManifestSchema>;
export const nativeComputerUseManifestSchema = computerUseNativeManifestSchema;

export const computerUseProtocolMessageKindSchema = z.enum([
  'handshake',
  'request',
  'response',
  'event',
  'cancel',
]);
export const computerUseProtocolHeaderSchema = z
  .object({
    version: z.literal(1),
    kind: computerUseProtocolMessageKindSchema,
    requestId: computerUseIdSchema,
    sessionId: computerUseIdSchema,
    cancelId: computerUseIdSchema.nullable(),
    payloadLength: z
      .number()
      .int()
      .nonnegative()
      .max(16 * 1024 * 1024),
    payloadDigest: computerUseDigestSchema,
  })
  .strict()
  .superRefine((header, context) => {
    if (header.kind === 'cancel' && header.cancelId === null)
      context.addIssue({ code: 'custom', message: 'Cancel messages require cancelId' });
    if (header.kind !== 'cancel' && header.cancelId !== null)
      context.addIssue({ code: 'custom', message: 'Only cancel messages carry cancelId' });
  });
export type ComputerUseProtocolHeader = z.infer<typeof computerUseProtocolHeaderSchema>;
export const computerUseNativeProtocolHeaderSchema = computerUseProtocolHeaderSchema;

export const computerUseHandshakeSchema = z
  .object({
    protocolVersion: z.number().int().positive(),
    apiVersion: z.number().int().positive(),
    platform: computerUsePlatformSchema,
    architecture: z.enum(['x64', 'arm64']),
    manifestDigest: computerUseDigestSchema,
    moduleDigest: computerUseDigestSchema,
    capabilities: z.array(computerUseNativeCapabilitySchema).max(4),
    accepted: z.boolean(),
    reasonCode: z
      .string()
      .regex(/^[a-z][a-z0-9._-]{0,63}$/)
      .nullable(),
  })
  .strict()
  .superRefine((handshake, context) => {
    if (handshake.accepted && handshake.reasonCode !== null)
      context.addIssue({ code: 'custom', message: 'Accepted handshakes have no failure reason' });
    if (!handshake.accepted && handshake.reasonCode === null)
      context.addIssue({ code: 'custom', message: 'Rejected handshakes require a reason' });
  });
export type ComputerUseHandshake = z.infer<typeof computerUseHandshakeSchema>;

export const COMPUTER_USE_LIMITS = Object.freeze({
  maxConcurrentSessions: 1,
  maxRounds: 25,
  maxSessionHours: 8,
  observationTtlSeconds: 30,
  maxImagesPerObservation: 2,
  maxImageBytes: 8 * 1024 * 1024,
  maxObservationImageBytes: 16 * 1024 * 1024,
  maxImageWidth: 2_560,
  maxImageHeight: 1_600,
  maxTreeDepth: 16,
  maxTreeNodes: 5_000,
  maxTreeBytes: 512 * 1024,
  maxProviderResponseBytes: 64 * 1024,
  maxTextActionBytes: 4_096,
  maxApprovalPreviewBytes: 256,
  maxWaitMs: 5_000,
} as const);

export type ComputerUseApi = {
  availability(): Promise<ComputerUseAvailability>;
  registerProfile(input: ComputerUseProfileRegisterInput): Promise<ComputerAppProfile | null>;
  listProfiles(input?: ComputerUseProfileListInput): Promise<ComputerUseProfileListResult>;
  listWindowCandidates(
    input: ComputerUseWindowCandidatesInput,
  ): Promise<ComputerUseWindowCandidatesResult>;
  start(input: ComputerUseStartInput): Promise<ComputerUseSessionStatus>;
  getStatus(input: ComputerUseSessionStatusInput): Promise<ComputerUseSessionStatus | null>;
  stop(input: ComputerUseStopInput): Promise<void>;
  resolveApproval(input: ComputerUseApprovalResolveInput): Promise<ComputerUseSessionStatus>;
  subscribeStatus(
    sessionId: string,
    listener: (status: ComputerUseSessionStatus) => void,
  ): () => void;
};

export interface SprintCoderApi {
  /** Optional until the gated Computer Use capability is exposed by Main/Preload. */
  computerUse?: ComputerUseApi;
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
    sendToWorker(input: TeamSendMessageInput): Promise<TeamMessageSummary>;
    stopWorker(input: TeamWorkerRef): Promise<WorkerSummary>;
    stopAll(taskId: string): Promise<TeamDetail>;
    subscribe(taskId: string, listener: (event: TeamEvent) => void): () => void;
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
    setRuntime(kind: RuntimeKind, taskId?: string): Promise<void>;
    setModel(model: string, taskId?: string): Promise<void>;
    setEffort(effort: ClaudeEffort): Promise<void>;
    /** Codex reasoning level. Rejects a level the selected model does not advertise (see
     * `effortOptionSchema`) — Codex fails the whole turn on an unsupported one. */
    setCodexEffort(effort: string): Promise<void>;
    getTeamModelResearch(): Promise<TeamModelResearchSettings>;
    setTeamModelResearch(input: TeamModelResearchSettings): Promise<void>;
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
  localAI: {
    hardware(): Promise<LocalHardwareSnapshot>;
    runtime(): Promise<ManagedLocalRuntimeSnapshot>;
    launchSettings(modelId: string): Promise<ManagedLocalLaunchSettingsView>;
    setLaunchSettings(
      input: ManagedLocalLaunchSettingsSetInput,
    ): Promise<ManagedLocalLaunchSettingsView>;
    inferenceSettings(modelId: string): Promise<ManagedLocalInferenceSettingsView>;
    setInferenceSettings(
      input: ManagedLocalInferenceSettingsSetInput,
    ): Promise<ManagedLocalInferenceSettingsView>;
    query(input: PublicModelCatalogQuery): Promise<PublicModelCatalogPage>;
    detail(input: PublicModelCatalogDetailInput): Promise<PublicModelCatalogDetail>;
    listJobs(): Promise<LocalDownloadJob[]>;
    listInstalled(): Promise<InstalledLocalModel[]>;
    install(input: LocalModelInstallInput): Promise<LocalDownloadJob>;
    fit(input: LocalModelFitInput): Promise<LocalFitAssessment>;
    pause(jobId: string): Promise<LocalDownloadJob>;
    resume(jobId: string): Promise<LocalDownloadJob>;
    cancel(jobId: string, confirmed: true): Promise<LocalDownloadJob>;
    verify(modelId: string): Promise<LocalFitAssessment>;
    delete(modelId: string): Promise<void>;
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
  teamsSubscribe: 'sprint-coder:teams:subscribe',
  teamsUnsubscribe: 'sprint-coder:teams:unsubscribe',
  teamsEvent: 'sprint-coder:teams:event',
  teamsGetCanvasView: 'sprint-coder:teams:get-canvas-view',
  teamsSaveCanvasView: 'sprint-coder:teams:save-canvas-view',
  workspaceGet: 'sprint-coder:workspace:get',
  workspaceGetEffective: 'sprint-coder:workspace:get-effective',
  workspaceSelect: 'sprint-coder:workspace:select',
  settingsGetRuntime: 'sprint-coder:settings:get-runtime',
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
  localAIHardware: 'sprint-coder:local-ai:hardware',
  localAIRuntime: 'sprint-coder:local-ai:runtime',
  localAILaunchSettings: 'sprint-coder:local-ai:launch-settings',
  localAISetLaunchSettings: 'sprint-coder:local-ai:set-launch-settings',
  localAIInferenceSettings: 'sprint-coder:local-ai:inference-settings',
  localAISetInferenceSettings: 'sprint-coder:local-ai:set-inference-settings',
  localAICatalogQuery: 'sprint-coder:local-ai:catalog-query',
  localAICatalogDetail: 'sprint-coder:local-ai:catalog-detail',
  localAIListJobs: 'sprint-coder:local-ai:list-jobs',
  localAIListInstalled: 'sprint-coder:local-ai:list-installed',
  localAIInstall: 'sprint-coder:local-ai:install',
  localAIFit: 'sprint-coder:local-ai:fit',
  localAIPause: 'sprint-coder:local-ai:pause',
  localAIResume: 'sprint-coder:local-ai:resume',
  localAICancel: 'sprint-coder:local-ai:cancel',
  localAIVerify: 'sprint-coder:local-ai:verify',
  localAIDelete: 'sprint-coder:local-ai:delete',
  permissionsGet: 'sprint-coder:permissions:get',
  permissionsSet: 'sprint-coder:permissions:set',
  permissionsListAutoDecisions: 'sprint-coder:permissions:list-auto-decisions',
  approvalsListPending: 'sprint-coder:approvals:list-pending',
  approvalsListRecent: 'sprint-coder:approvals:list-recent',
  approvalsResolve: 'sprint-coder:approvals:resolve',
  computerUseAvailability: 'sprint-coder:computer-use:availability',
  computerUseProfilesList: 'sprint-coder:computer-use:profiles:list',
  computerUseProfileRegister: 'sprint-coder:computer-use:profiles:register',
  computerUseWindowCandidates: 'sprint-coder:computer-use:windows:list',
  computerUseStart: 'sprint-coder:computer-use:start',
  computerUseStatusGet: 'sprint-coder:computer-use:status:get',
  computerUseStop: 'sprint-coder:computer-use:stop',
  computerUseApprovalResolve: 'sprint-coder:computer-use:approval:resolve',
  /** One-way trusted Renderer activation intent, bound by Main before privileged invokes. */
  computerUseActivationIntent: 'sprint-coder:computer-use:activation-intent',
  /** Push Computer Use status; callers replay the latest transient snapshot after subscribing. */
  computerUseStatusEvent: 'sprint-coder:computer-use:status',
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
