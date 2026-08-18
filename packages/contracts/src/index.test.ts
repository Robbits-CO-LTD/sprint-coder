import { describe, expect, it } from 'vitest';
import * as contracts from './index';
import {
  claudeEffortSchema,
  commandEnvelopeSchema,
  contextUsageSchema,
  executionResolutionSchema,
  modelSelectionSchema,
  providerProfileConnectionCreateInputSchema,
  providerProfileSchema,
  permissionSettingsSchema,
  permissionSetInputSchema,
  providerConnectionRateLimitLowerInputSchema,
  providerConnectionSchema,
  projectAssignTaskInputSchema,
  projectCreateInputSchema,
  fileChangeSchema,
  fileEditFrameSchema,
  filePathPayloadSchema,
  fileSaveInputSchema,
  projectFoldersReplaceInputSchema,
  effectiveWorkspaceSetSchema,
  projectInstructionSetInputSchema,
  projectSummarySchema,
  projectUpdateInputSchema,
  publicErrorSchema,
  runtimeSettingsSchema,
  updateHealthSchema,
  codexUserConfigSettingsSchema,
  teamModelResearchSettingsSchema,
  teamModelRestrictionSchema,
  taskRenameInputSchema,
  teamBudgetStatusSchema,
  teamActivitySummarySchema,
  teamBlueprintSchema,
  teamDetailSchema,
  teamExecutionSummarySchema,
  teamExecutionIsolationSchema,
  teamResumeExecutionIntegrationInputSchema,
  teamEventSchema,
  teamSubscriptionInputSchema,
  teamSubscriptionSnapshotSchema,
  teamHireWorkerInputSchema,
  teamMessageSummarySchema,
  teamAssignMissionInputSchema,
  teamMissionSummarySchema,
  teamPolicyUpdateInputSchema,
  teamSendMessageInputSchema,
  teamSummarySchema,
  teamWorkerRefSchema,
  toolCatalogSnapshotSchema,
  turnEventSchema,
  turnSnapshotSchema,
  workerCompletionSchema,
  workerSummarySchema,
  skillDraftCreateInputSchema,
} from './index';

type Parser = { parse(value: unknown): unknown };
const approvalContracts = contracts as typeof contracts & {
  approvalDecisionSchema: Parser;
  approvalSummarySchema: Parser;
  approvalResolveInputSchema: Parser;
};

const pendingApproval = {
  id: 'approval-1',
  taskId: 'task-1',
  turnId: 'turn-1',
  callId: 'call-1',
  state: 'pending',
  decision: null,
  revision: 0,
  policyEpoch: 3,
  toolName: 'fetch_url',
  reason: 'The task requested network access.',
  target: 'https://example.com',
  impact: 'Sends a request to an external service.',
  execution: 'GET https://example.com',
  risk: 'medium',
  capability: 'network.fetch',
  challenge: 'approval-challenge-0001',
  createdAt: '2026-07-22T12:00:00.000Z',
  expiresAt: '2026-07-22T12:05:00.000Z',
} as const;

describe('public contracts', () => {
  const teamPolicy = {
    maxAgentDepth: 4,
    maxConcurrentExecutions: 8,
    allowWorkerDirectMessages: true,
    budgetMode: 'bounded',
  } as const;

  it('carries corrupt SQLite bundle diagnostics in startup recovery', () => {
    expect(
      contracts.databaseRecoverySchema.parse({
        corruptionDetected: true,
        restoredFromBackup: true,
        freshStart: false,
        corruptBundlePath: '/diagnostics/sprint-coder.db.corrupt-id',
        possibleCommittedDataLoss: true,
        interruptedTurns: 0,
      }),
    ).toMatchObject({
      corruptBundlePath: '/diagnostics/sprint-coder.db.corrupt-id',
      possibleCommittedDataLoss: true,
    });
  });

  it('bounds public image attachment draft metadata', () => {
    const attachment = {
      id: 'attachment-1',
      fileName: 'diagram.png',
      mimeType: 'image/png',
      byteLength: 4 * 1024 * 1024,
      createdAt: '2026-08-05T00:00:00.000Z',
    } as const;
    expect(contracts.imageAttachmentMetadataListSchema.parse([attachment])).toEqual([attachment]);
    expect(() =>
      contracts.imageAttachmentMetadataListSchema.parse([attachment, attachment]),
    ).toThrow(/unique/i);
    expect(() =>
      contracts.imageAttachmentMetadataListSchema.parse(
        Array.from({ length: 4 }, (_, index) => ({
          ...attachment,
          id: `attachment-${index}`,
          byteLength: 5 * 1024 * 1024,
        })),
      ),
    ).toThrow(/aggregate/i);
    expect(() =>
      contracts.imageAttachmentMetadataSchema.parse({
        ...attachment,
        mimeType: 'image/gif',
      }),
    ).toThrow();
  });

  it('keeps image IDs exclusive to direct Turn start and defaults old message outputs', () => {
    expect(
      contracts.turnStartInputSchema.parse({
        taskId: 'task-1',
        text: 'この画像を説明して',
        attachmentIds: ['attachment-1'],
        attachmentSelectionIdentity: 'selection-1',
      }),
    ).toMatchObject({
      attachmentIds: ['attachment-1'],
      attachmentSelectionIdentity: 'selection-1',
      skills: [],
    });
    expect(() =>
      contracts.turnStartInputSchema.parse({
        taskId: 'task-1',
        text: 'missing identity',
        attachmentIds: ['attachment-1'],
        attachmentSelectionIdentity: null,
      }),
    ).toThrow();
    expect(
      contracts.turnStartInputSchema.parse({
        taskId: 'task-1',
        text: 'text only',
        attachmentIds: [],
        attachmentSelectionIdentity: null,
      }),
    ).toMatchObject({ attachmentIds: [], attachmentSelectionIdentity: null });
    expect(() =>
      contracts.turnStartInputSchema.parse({ taskId: 'task-1', text: 'missing IDs' }),
    ).toThrow();
    expect(() =>
      contracts.turnQueueInputSchema.parse({
        taskId: 'task-1',
        text: 'queue',
        attachmentIds: ['attachment-1'],
      }),
    ).toThrow();
    expect(
      contracts.chatMessageSchema.parse({
        id: 'message-1',
        taskId: 'task-1',
        turnId: null,
        author: 'user',
        content: 'legacy',
        createdAt: '2026-08-05T00:00:00.000Z',
      }).attachments,
    ).toEqual([]);
  });

  it('validates Project summaries and mutation CAS inputs', () => {
    expect(projectCreateInputSchema.parse({ name: '  Project A  ' })).toEqual({
      name: 'Project A',
    });
    expect(projectCreateInputSchema.parse({ name: 'Project A', folders: [] })).toEqual({
      name: 'Project A',
      folders: [],
    });
    expect(
      projectUpdateInputSchema.parse({
        projectId: 'project-1',
        expectedRevision: 2,
        archived: true,
      }),
    ).toEqual({ projectId: 'project-1', expectedRevision: 2, archived: true });
    expect(
      projectAssignTaskInputSchema.parse({
        projectId: 'project-1',
        taskId: 'task-1',
        expectedProjectId: null,
      }),
    ).toEqual({ projectId: 'project-1', taskId: 'task-1', expectedProjectId: null });
    expect(() =>
      projectUpdateInputSchema.parse({ projectId: 'project-1', expectedRevision: 2 }),
    ).toThrow();
    expect(() => projectCreateInputSchema.parse({ name: ' '.repeat(121) })).toThrow();
    expect(
      projectSummarySchema.parse({
        id: 'project-1',
        name: 'Project A',
        archived: false,
        revision: 1,
        taskCount: 0,
        lastActivityAt: '2026-07-31T00:00:00.000Z',
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:00:00.000Z',
      }),
    ).toMatchObject({
      id: 'project-1',
      revision: 1,
      folderCount: 0,
      primaryFolder: null,
    });
    expect(
      projectFoldersReplaceInputSchema.parse({
        projectId: 'project-1',
        expectedRevision: 1,
        folders: [
          { path: '/tmp/a', role: 'primary' },
          { path: '/tmp/b', role: 'secondary' },
        ],
      }).folders,
    ).toHaveLength(2);
    expect(() =>
      projectFoldersReplaceInputSchema.parse({
        projectId: 'project-1',
        expectedRevision: 1,
        folders: [{ path: '/tmp/a', role: 'secondary' }],
      }),
    ).toThrow('Primary');
    expect(
      effectiveWorkspaceSetSchema.parse({
        source: 'none',
        projectId: 'project-1',
        primaryRootId: null,
        roots: [],
        digest: 'a'.repeat(64),
      }),
    ).toMatchObject({ source: 'none', roots: [] });
  });

  it('preserves rooted file identity and upgrades legacy Primary records', () => {
    expect(fileChangeSchema.parse({ path: 'src/index.ts', kind: 'update' })).toMatchObject({
      rootId: 'legacy-primary',
      rootLabel: 'Workspace',
      path: 'src/index.ts',
    });
    expect(
      fileEditFrameSchema.parse({
        taskId: 'task-1',
        turnId: 'turn-1',
        rootId: 'root-b',
        rootLabel: 'test2',
        path: 'src/index.ts',
        text: 'changed',
        complete: true,
        source: 'disk',
        baseline: null,
      }),
    ).toMatchObject({ rootId: 'root-b', rootLabel: 'test2' });
    expect(filePathPayloadSchema.parse({ taskId: 'task-1', path: 'src/index.ts' })).toMatchObject({
      rootId: 'legacy-primary',
    });
    expect(
      fileSaveInputSchema.parse({
        taskId: 'task-1',
        rootId: 'root-b',
        path: 'src/index.ts',
        text: 'changed',
        baseDigest: 'a'.repeat(64),
      }),
    ).toMatchObject({ rootId: 'root-b' });
  });

  it('bounds Project instruction by UTF-8 bytes and upgrades legacy usage with zero Project tokens', () => {
    expect(
      projectInstructionSetInputSchema.parse({
        projectId: 'project-1',
        expectedRevision: 1,
        instruction: 'a'.repeat(16_384),
      }).instruction,
    ).toHaveLength(16_384);
    expect(() =>
      projectInstructionSetInputSchema.parse({
        projectId: 'project-1',
        expectedRevision: 1,
        instruction: 'あ'.repeat(5_462),
      }),
    ).toThrow();
    expect(
      contextUsageSchema.parse({ usedTokens: 2, hardCapTokens: 32_000, fragments: [] }),
    ).toMatchObject({ projectTokens: 0 });
  });

  it('defaults a pre-v55 persisted TaskSummary projectId to null during operation replay', () => {
    expect(
      contracts.taskSummarySchema.parse({
        id: 'task-1',
        title: 'Legacy replay',
        pinned: false,
        archived: false,
        goal: null,
        workspacePath: null,
        localOnly: false,
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:00:00.000Z',
      }).projectId,
    ).toBeNull();
  });

  it('rejects cyclic Team Blueprint parent relationships', () => {
    const role = {
      title: 'Role',
      responsibility: 'Investigate',
      scope: [],
      nonGoals: [],
      doneCriteria: [],
      required: true,
      canDelegate: false,
    };
    expect(() =>
      teamBlueprintSchema.parse({
        version: 1,
        kind: 'team',
        policy: teamPolicy,
        leaderInstructions: 'Lead the team',
        roles: [
          { ...role, key: 'a', parentKey: 'b' },
          { ...role, key: 'b', parentKey: 'a' },
        ],
      }),
    ).toThrow(/循環/);
  });

  it('rejects Skill Draft paths that escape the managed package', () => {
    const input = {
      kind: 'chat',
      skillId: 'reviewer',
      files: [{ path: 'SKILL.md', content: 'safe' }],
    } as const;
    expect(skillDraftCreateInputSchema.parse(input)).toEqual(input);
    for (const path of ['../SKILL.md', '/tmp/SKILL.md', 'team/../../SKILL.md', 'team\\SKILL.md'])
      expect(() =>
        skillDraftCreateInputSchema.parse({
          ...input,
          files: [{ path, content: 'unsafe' }],
        }),
      ).toThrow();
  });

  it('validates optimistic Team Policy updates', () => {
    expect(
      teamPolicyUpdateInputSchema.parse({
        taskId: 'task-1',
        policy: teamPolicy,
        expectedRevision: 3,
      }),
    ).toEqual({ taskId: 'task-1', policy: teamPolicy, expectedRevision: 3 });
    expect(() =>
      teamPolicyUpdateInputSchema.parse({
        taskId: 'task-1',
        policy: { ...teamPolicy, maxConcurrentExecutions: 9 },
        expectedRevision: 3,
      }),
    ).toThrow();
    expect(() =>
      teamPolicyUpdateInputSchema.parse({
        taskId: 'task-1',
        policy: teamPolicy,
        expectedRevision: -1,
      }),
    ).toThrow();
  });

  it('validates the global Team model research setting without coercion', () => {
    expect(teamModelResearchSettingsSchema.parse({ researchBeforeHiring: true })).toEqual({
      researchBeforeHiring: true,
    });
    expect(() => teamModelResearchSettingsSchema.parse({ researchBeforeHiring: 'true' })).toThrow();
  });

  it('requires an explicit boolean for Codex user-config opt-in', () => {
    expect(codexUserConfigSettingsSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(() => codexUserConfigSettingsSchema.parse({})).toThrow();
    expect(() => codexUserConfigSettingsSchema.parse({ enabled: 'false' })).toThrow();
  });

  it('requires at least one unique model when Team models are restricted', () => {
    const identity = {
      connectionId: 'builtin:codex-cli',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
    };
    expect(
      teamModelRestrictionSchema.parse({ mode: 'selected', allowedModels: [identity] }),
    ).toEqual({ mode: 'selected', allowedModels: [identity] });
    expect(() =>
      teamModelRestrictionSchema.parse({ mode: 'selected', allowedModels: [] }),
    ).toThrow();
    expect(() =>
      teamModelRestrictionSchema.parse({
        mode: 'selected',
        allowedModels: [identity, identity],
      }),
    ).toThrow();
    expect(teamModelRestrictionSchema.parse({ mode: 'all', allowedModels: [] })).toEqual({
      mode: 'all',
      allowedModels: [],
    });
  });

  it('validates a declarative OpenAI-compatible Provider Profile', () => {
    expect(
      providerProfileSchema.parse({
        id: 'example',
        displayName: 'Example API',
        baseUrl: 'https://api.example.com/v1',
        baseUrlConfigurable: false,
        protocol: 'chat_completions',
        modelsPath: '/models',
        curatedModels: [],
        verificationModel: null,
        authentication: { headerName: 'Authorization', scheme: 'Bearer' },
        requiredCredentialFields: ['api_key'],
        errorOverrides: [{ status: 429, category: 'rate_limited', retryable: true }],
        sourceReference: 'https://docs.example.com/openai-compatibility',
        reviewedAt: '2026-07-28T00:00:00.000Z',
      }),
    ).toMatchObject({ id: 'example', protocol: 'chat_completions' });
  });

  it('allows an OpenAI-compatible Profile Connection to omit an optional API key', () => {
    expect(
      providerProfileConnectionCreateInputSchema.parse({
        profileId: 'ollama',
        displayName: 'Local Ollama',
      }),
    ).toEqual({
      profileId: 'ollama',
      displayName: 'Local Ollama',
    });
  });

  it('keeps requested selection separate from observed execution resolution', () => {
    expect(
      modelSelectionSchema.parse({
        connectionId: 'builtin:claude-cli',
        requestedProvider: 'anthropic',
        requestedModel: 'claude-opus-5',
      }),
    ).toMatchObject({ connectionId: 'builtin:claude-cli' });
    expect(
      executionResolutionSchema.parse({
        resolvedProvider: null,
        resolvedModel: 'claude-opus-5-20260715',
      }),
    ).toMatchObject({ resolvedProvider: null });
    expect(() =>
      modelSelectionSchema.parse({
        connectionId: 'builtin:codex-cli',
        requestedProvider: null,
        requestedModel: 'gpt-5.6-sol',
      }),
    ).toThrow();
  });

  it('validates Provider Connections independently from legacy Chat runtime kinds', () => {
    expect(
      providerConnectionSchema.parse({
        id: 'builtin:claude-cli',
        providerId: 'anthropic',
        runtimeKind: 'builtin_cli',
        displayName: 'Claude CLI',
        enabled: true,
        secretReference: null,
        verification: {
          status: 'not_required',
          verifiedAt: null,
          expiresAt: null,
          message: null,
        },
        rateLimit: {
          mode: 'bypass',
          maxConcurrentRequests: null,
          requestsPerMinute: null,
          tokensPerMinute: null,
          lastObservedRateLimitHeaders: null,
        },
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:00.000Z',
      }),
    ).toMatchObject({ runtimeKind: 'builtin_cli' });
    expect(() =>
      providerConnectionSchema.parse({
        id: 'bad connection id',
        providerId: 'Anthropic',
        runtimeKind: 'claude',
        displayName: '',
        enabled: true,
        secretReference: null,
        verification: {
          status: 'unverified',
          verifiedAt: null,
          expiresAt: null,
          message: null,
        },
        rateLimit: {
          mode: 'auto',
          maxConcurrentRequests: 2,
          requestsPerMinute: null,
          tokensPerMinute: null,
          lastObservedRateLimitHeaders: null,
        },
        createdAt: 'invalid',
        updatedAt: 'invalid',
      }),
    ).toThrow();
  });

  it('requires a positive lower-only Provider rate-limit patch', () => {
    expect(
      providerConnectionRateLimitLowerInputSchema.parse({
        connectionId: 'connection:openai-primary',
        maxConcurrentRequests: 1,
      }),
    ).toEqual({
      connectionId: 'connection:openai-primary',
      maxConcurrentRequests: 1,
    });
    expect(() =>
      providerConnectionRateLimitLowerInputSchema.parse({
        connectionId: 'connection:openai-primary',
      }),
    ).toThrow();
    expect(() =>
      providerConnectionRateLimitLowerInputSchema.parse({
        connectionId: 'connection:openai-primary',
        maxConcurrentRequests: 0,
      }),
    ).toThrow();
  });

  it('validates the bounded Team promotion result', () => {
    expect(
      teamSummarySchema.parse({
        id: 'team-1',
        taskId: 'task-1',
        state: 'draft',
        leaderAgentId: 'agent-1',
        budget: {},
        policy: teamPolicy,
        revision: 0,
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z',
      }),
    ).toMatchObject({ taskId: 'task-1', state: 'draft', leaderAgentId: 'agent-1' });
    expect(() =>
      teamSummarySchema.parse({
        id: 'team-1',
        taskId: 'task-1',
        state: 'running',
        leaderAgentId: 'agent-1',
        budget: {},
        policy: teamPolicy,
        revision: 0,
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z',
      }),
    ).toThrow();
  });

  const teamUsage = { costCents: 0, tokens: 0, timeMs: 0, toolCalls: 0 };
  const worker = {
    id: 'worker-1',
    teamId: 'team-1',
    threadId: 'thread-1',
    taskId: 'task-1',
    kind: 'worker',
    role: 'implementer',
    state: 'ready',
    objective: 'Ship the feature',
    writeCapable: true,
    currentActivity: null,
    engine: 'codex',
    connectionId: null,
    requestedProvider: null,
    requestedModel: null,
    parentAgentId: 'leader-1',
    depth: 1,
    canDelegate: false,
    managerPolicy: null,
    liveOutput: '',
    reasoningActive: false,
    usage: teamUsage,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
  } as const;
  const teamMessage = {
    id: 'message-1',
    teamId: 'team-1',
    sourceAgentId: 'worker-1',
    targetAgentId: 'leader-1',
    sourceKind: 'worker',
    targetKind: 'leader',
    seq: 1,
    state: 'delivered',
    content: 'status update',
    executionId: null,
    attemptId: null,
    deliveryState: 'acked',
    attempt: 1,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
  } as const;
  const team = {
    id: 'team-1',
    taskId: 'task-1',
    state: 'active',
    leaderAgentId: 'leader-1',
    budget: {},
    policy: teamPolicy,
    revision: 1,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
  } as const;
  const budget = {
    scope: 'team',
    kind: 'costCents',
    cap: 1000,
    committed: 100,
    reserved: 0,
  } as const;
  const execution = {
    id: 'execution-1',
    teamId: 'team-1',
    assigneeAgentId: 'worker-1',
    createdByAgentId: 'leader-1',
    state: 'queued',
    instructionPreview: 'status update',
    instructionRevision: 1,
    queueOrdinal: 1,
    queueReason: 'global_concurrency',
    connectionId: 'builtin:claude-cli',
    requestedModel: 'claude-opus-5',
    attemptStartReason: null,
    lastProgressAt: null,
    terminalReason: null,
    missionId: null,
    missionStepOrdinal: null,
    missionStepCount: null,
    assignedAt: '2026-07-23T00:00:00.000Z',
    queuedAt: '2026-07-23T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    updatedAt: '2026-07-23T00:00:00.000Z',
  } as const;
  const teamActivity = {
    id: 'activity-1',
    teamId: 'team-1',
    seq: 1,
    type: 'worker_hired',
    actorAgentId: 'leader-1',
    actorRole: 'Leader',
    subjectAgentId: 'worker-1',
    subjectRole: 'implementer',
    executionId: null,
    attemptId: null,
    status: null,
    queueReason: null,
    attemptOrdinal: null,
    terminalReason: null,
    connectionId: null,
    requestedProvider: null,
    requestedModel: null,
    modelSelectionReason: null,
    recordedAt: '2026-07-23T00:00:00.000Z',
  } as const;

  it('validates worker summaries and rejects unknown worker states or extra fields', () => {
    expect(workerSummarySchema.parse(worker)).toMatchObject({ id: 'worker-1', state: 'ready' });
    expect(() => workerSummarySchema.parse({ ...worker, state: 'blocked' })).toThrow();
    expect(() => workerSummarySchema.parse({ ...worker, unknown: true })).toThrow();
  });

  it('validates team message summaries including a nullable delivery state', () => {
    expect(teamMessageSummarySchema.parse(teamMessage)).toMatchObject({ state: 'delivered' });
    expect(
      teamMessageSummarySchema.parse({ ...teamMessage, deliveryState: null }).deliveryState,
    ).toBeNull();
    expect(() =>
      teamMessageSummarySchema.parse({ ...teamMessage, deliveryState: 'queued' }),
    ).toThrow();
    expect(() => teamMessageSummarySchema.parse({ ...teamMessage, unknown: true })).toThrow();
  });

  it('validates team budget status scopes and rejects negative amounts', () => {
    expect(teamBudgetStatusSchema.parse(budget)).toMatchObject({ scope: 'team' });
    expect(() => teamBudgetStatusSchema.parse({ ...budget, scope: 'worker-pool' })).toThrow();
    expect(() => teamBudgetStatusSchema.parse({ ...budget, cap: -1 })).toThrow();
  });

  it('validates bounded execution summaries for the Team activity surface', () => {
    expect(teamExecutionSummarySchema.parse(execution)).toMatchObject({
      state: 'queued',
      queueReason: 'global_concurrency',
    });
    expect(() =>
      teamExecutionSummarySchema.parse({ ...execution, instructionPreview: 'x'.repeat(501) }),
    ).toThrow();
    expect(() =>
      teamExecutionSummarySchema.parse({ ...execution, queueReason: 'provider_guess' }),
    ).toThrow();
  });

  it('seals Team isolation root bindings and completion state', () => {
    expect(
      teamResumeExecutionIntegrationInputSchema.parse({
        taskId: 'task-1',
        executionId: 'execution-1',
      }),
    ).toEqual({ taskId: 'task-1', executionId: 'execution-1' });
    const isolation = {
      phase: 'running',
      resumeKind: null,
      repositories: [
        {
          ordinal: 1,
          repoPath: '/repo',
          worktreePath: '/worktree',
          baseHead: 'a'.repeat(40),
          workerHead: null,
          integratedHead: null,
          state: 'active',
          changedFiles: [],
        },
      ],
      roots: [
        {
          rootId: 'root-1',
          rootLabel: 'repo',
          role: 'primary',
          repositoryOrdinal: 1,
          sourcePath: '/repo',
          isolatedPath: '/worktree',
          identity: 'b'.repeat(64),
          mutationKey: 'c'.repeat(64),
        },
      ],
      reason: null,
    } as const;
    expect(teamExecutionIsolationSchema.parse(isolation)).toMatchObject({ phase: 'running' });
    expect(
      teamExecutionIsolationSchema.parse({
        ...isolation,
        phase: 'waiting_integration',
        repositories: [
          {
            ...isolation.repositories[0],
            workerHead: 'd'.repeat(40),
            state: 'ready',
          },
        ],
      }),
    ).toMatchObject({ phase: 'waiting_integration', resumeKind: null });
    expect(
      teamExecutionIsolationSchema.parse({
        ...isolation,
        phase: 'waiting_resume',
        resumeKind: 'integration',
        reason: 'resume finalization',
      }),
    ).toMatchObject({ phase: 'waiting_resume', repositories: [{ state: 'active' }] });
    expect(
      teamExecutionIsolationSchema.safeParse({
        ...isolation,
        roots: [isolation.roots[0], { ...isolation.roots[0], role: 'secondary' }],
      }).success,
    ).toBe(false);
    expect(
      teamExecutionIsolationSchema.safeParse({
        ...isolation,
        phase: 'completed',
        repositories: [
          {
            ...isolation.repositories[0],
            workerHead: 'd'.repeat(40),
            state: 'ready',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('bounds durable Missions to 2 through 12 ordered steps', () => {
    const step = {
      workerId: 'worker-1',
      objective: 'Inspect the workspace.',
      doneCriteria: ['Report findings.'],
      access: 'read-only',
    } as const;
    const input = {
      taskId: 'task-1',
      objective: 'Complete a durable change.',
      doneCriteria: ['All steps complete.'],
      steps: [step, { ...step, objective: 'Verify the change.' }],
    };
    expect(teamAssignMissionInputSchema.parse(input).steps).toHaveLength(2);
    expect(() => teamAssignMissionInputSchema.parse({ ...input, steps: [step] })).toThrow();
    expect(() =>
      teamAssignMissionInputSchema.parse({
        ...input,
        steps: Array.from({ length: 13 }, () => step),
      }),
    ).toThrow();
    expect(
      teamMissionSummarySchema.parse({
        id: 'mission-1',
        teamId: 'team-1',
        createdByAgentId: 'leader-1',
        state: 'waiting_resume',
        objective: input.objective,
        doneCriteria: input.doneCriteria,
        currentStepOrdinal: 1,
        steps: input.steps.map((missionStep, index) => ({
          ordinal: index + 1,
          executionId: `execution-${index + 1}`,
          workerId: missionStep.workerId,
          objective: missionStep.objective,
          doneCriteria: missionStep.doneCriteria,
          access: missionStep.access,
          state: index === 0 ? 'waiting_resume' : 'assigned',
          checkpoint: null,
          worktree:
            index === 0
              ? {
                  path: '/tmp/team-worktrees/execution-1',
                  baseHead: 'a'.repeat(40),
                  state: 'quarantined',
                  workerHead: 'b'.repeat(40),
                  integratedHead: null,
                  changedFiles: ['src/change.ts'],
                  reason: 'Workspace changed before integration',
                }
              : null,
        })),
        createdAt: '2026-07-28T01:00:00.000Z',
        updatedAt: '2026-07-28T01:01:00.000Z',
        completedAt: null,
      }),
    ).toMatchObject({
      state: 'waiting_resume',
      currentStepOrdinal: 1,
      steps: [{ worktree: { state: 'quarantined' } }, { worktree: null }],
    });
  });

  it('validates normalized durable Team activity summaries', () => {
    expect(teamActivitySummarySchema.parse(teamActivity)).toMatchObject({
      type: 'worker_hired',
      subjectRole: 'implementer',
    });
    expect(() =>
      teamActivitySummarySchema.parse({ ...teamActivity, queueReason: 'provider_guess' }),
    ).toThrow();
  });

  it('validates a team detail aggregate of workers, messages, executions, activities, and budgets', () => {
    const detail = {
      team,
      workers: [worker],
      messages: [teamMessage],
      executions: [execution],
      missions: [],
      activities: [teamActivity],
      budgets: [budget],
    };
    expect(teamDetailSchema.parse(detail)).toMatchObject({ team: { id: 'team-1' } });
    expect(() => teamDetailSchema.parse({ ...detail, unknown: true })).toThrow();
  });

  it('validates worker completion boundaries for summary length, artifacts, and digests', () => {
    const completion = {
      status: 'succeeded',
      summary: 'Implemented the feature end to end.',
      artifacts: [{ kind: 'file', reference: 'src/index.ts', digest: 'a'.repeat(64) }],
      verification: [{ name: 'unit tests', outcome: 'pass' }],
      risks: [],
    };
    expect(workerCompletionSchema.parse(completion)).toMatchObject({ status: 'succeeded' });
    expect(() => workerCompletionSchema.parse({ ...completion, summary: '' })).toThrow();
    expect(() =>
      workerCompletionSchema.parse({ ...completion, summary: 'x'.repeat(4_001) }),
    ).toThrow();
    expect(
      workerCompletionSchema.parse({ ...completion, summary: 'x'.repeat(4_000) }).summary.length,
    ).toBe(4_000);
    expect(() =>
      workerCompletionSchema.parse({
        ...completion,
        artifacts: [{ kind: 'file', reference: 'r', digest: 'not-a-digest' }],
      }),
    ).toThrow();
    expect(() =>
      workerCompletionSchema.parse({
        ...completion,
        artifacts: Array.from({ length: 21 }, () => ({ kind: 'note', reference: 'r' })),
      }),
    ).toThrow();
    expect(
      workerCompletionSchema.parse({
        ...completion,
        artifacts: Array.from({ length: 20 }, () => ({ kind: 'note', reference: 'r' })),
      }).artifacts,
    ).toHaveLength(20);
    expect(() =>
      workerCompletionSchema.parse({
        ...completion,
        verification: [{ name: 'x', outcome: 'inconclusive' }],
      }),
    ).toThrow();
    expect(() => workerCompletionSchema.parse({ ...completion, unknown: true })).toThrow();
  });

  it('validates team hire-worker and send-message inputs and rejects out-of-range values', () => {
    const hire = {
      taskId: 'task-1',
      role: 'reviewer',
      objective: 'Review the diff for correctness.',
      contextInheritancePolicy: 'summary',
      writeCapable: false,
    };
    expect(teamHireWorkerInputSchema.parse(hire)).toMatchObject({ role: 'reviewer' });
    expect(() => teamHireWorkerInputSchema.parse({ ...hire, role: 'x'.repeat(101) })).toThrow();
    expect(() =>
      teamHireWorkerInputSchema.parse({ ...hire, contextInheritancePolicy: 'everything' }),
    ).toThrow();
    expect(() => teamHireWorkerInputSchema.parse({ ...hire, unknown: true })).toThrow();

    const send = { taskId: 'task-1', targetAgentId: 'worker-1', content: 'hello' };
    expect(teamSendMessageInputSchema.parse(send)).toMatchObject({ targetAgentId: 'worker-1' });
    expect(() => teamSendMessageInputSchema.parse({ ...send, content: '' })).toThrow();
    expect(() =>
      teamSendMessageInputSchema.parse({ ...send, content: 'x'.repeat(20_001) }),
    ).toThrow();
    expect(() => teamSendMessageInputSchema.parse({ ...send, unknown: true })).toThrow();
  });

  it('validates the team worker reference and rejects extra fields', () => {
    const ref = { taskId: 'task-1', agentId: 'worker-1' };
    expect(teamWorkerRefSchema.parse(ref)).toEqual(ref);
    expect(() => teamWorkerRefSchema.parse({ ...ref, unknown: true })).toThrow();
  });

  it('validates the team event shape and rejects unknown event types', () => {
    const detail = {
      team,
      workers: [worker],
      messages: [teamMessage],
      executions: [execution],
      missions: [],
      activities: [teamActivity],
      budgets: [budget],
    };
    const event = { type: 'updated', seq: 1, detail };
    expect(teamEventSchema.parse(event)).toMatchObject({ type: 'updated' });
    expect(
      teamSubscriptionSnapshotSchema.parse({ type: 'snapshot', seq: 0, detail: null }),
    ).toEqual({ type: 'snapshot', seq: 0, detail: null });
    expect(
      teamSubscriptionInputSchema.parse({ taskId: 'task-1', subscriptionId: 'subscription-1' }),
    ).toEqual({ taskId: 'task-1', subscriptionId: 'subscription-1' });
    expect(() =>
      teamSubscriptionInputSchema.parse({ taskId: 'task-1', subscriptionId: '' }),
    ).toThrow();
    expect(() => teamEventSchema.parse({ ...event, type: 'deleted' })).toThrow();
    expect(() => teamEventSchema.parse({ ...event, unknown: true })).toThrow();
  });

  it('rejects unknown command fields', () => {
    expect(() =>
      commandEnvelopeSchema(taskRenameInputSchema).parse({
        requestId: 'r',
        operationId: 'o',
        payload: { taskId: 't', title: 'x' },
        unknown: true,
      }),
    ).toThrow();
  });

  it('rejects malformed turn events', () => {
    expect(() =>
      turnEventSchema.parse({
        type: 'message.delta',
        taskId: 't',
        turnId: 'u',
        seq: 0,
        messageId: 'm',
        delta: '',
      }),
    ).toThrow();
  });

  it('accepts task-scoped events and snapshots with context usage', () => {
    expect(
      turnEventSchema.parse({
        type: 'queue.changed',
        taskId: 't',
        seq: 3,
        queued: [{ ordinal: 1, text: 'next' }],
      }),
    ).toMatchObject({ type: 'queue.changed', seq: 3 });
    expect(
      turnEventSchema.parse({
        type: 'context.usage',
        taskId: 't',
        seq: 4,
        usage: {
          usedTokens: 7,
          hardCapTokens: 32_000,
          projectTokens: 0,
          fragments: [{ source: 'history', tokens: 7 }],
        },
      }),
    ).toMatchObject({ type: 'context.usage', seq: 4 });
    expect(
      turnEventSchema.parse({
        type: 'delivery.acknowledged',
        taskId: 't',
        turnId: 'u',
        seq: 5,
        deliveryId: 'a'.repeat(64),
        completionId: 'completion-1',
        fragmentId: 'completion-1',
      }),
    ).toMatchObject({ type: 'delivery.acknowledged', seq: 5 });
    expect(
      turnSnapshotSchema.parse({
        lastSeq: 3,
        activeTurn: {
          turnId: 'turn',
          stage: 'executing',
          startedAtEpochMs: 1,
          streamedText: 'partial',
          messageId: 'message',
        },
        queued: [{ ordinal: 1, text: 'next' }],
        contextUsage: {
          usedTokens: 7,
          hardCapTokens: 32_000,
          projectTokens: 0,
          fragments: [
            { source: 'history', tokens: 6 },
            { source: 'background', tokens: 1 },
          ],
        },
      }).lastSeq,
    ).toBe(3);
  });

  it('validates runtime settings and the runtime error codes', () => {
    expect(
      runtimeSettingsSchema.parse({
        kind: 'codex',
        codexAvailable: true,
        codexReadiness: 'ready',
        claudeAvailable: false,
        claudeReadiness: 'unavailable',
        model: 'gpt-5.6-terra',
        models: [
          {
            id: 'gpt-5.6-terra',
            displayName: 'GPT-5.6-Terra',
            description: 'Balanced model',
          },
        ],
        effort: 'medium',
        codexEffort: 'high',
        modelFallbackNotice: null,
      }),
    ).toMatchObject({
      kind: 'codex',
      model: 'gpt-5.6-terra',
      effort: 'medium',
      codexEffort: 'high',
    });
    expect(() => claudeEffortSchema.parse('bogus')).toThrow();
    expect(
      runtimeSettingsSchema.parse({
        kind: 'codex',
        codexAvailable: true,
        codexReadiness: 'ready',
        claudeAvailable: false,
        claudeReadiness: 'unavailable',
        model: 'auto',
        models: [],
        effort: 'medium',
        codexEffort: '',
        modelFallbackNotice: {
          changes: [{ runtimeKind: 'codex', migratedCount: 1, resetCount: 2 }],
        },
      }).modelFallbackNotice,
    ).not.toBeNull();
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
      expect(claudeEffortSchema.parse(effort)).toBe(effort);
    expect(
      updateHealthSchema.parse({
        successfulChecks: 2,
        failedChecks: 3,
        consecutiveFailures: 3,
        lastSuccessAt: '2026-08-12T00:00:00.000Z',
        lastFailureAt: '2026-08-12T01:00:00.000Z',
        lastErrorCategory: 'decryption',
      }).lastErrorCategory,
    ).toBe('decryption');
    expect(() =>
      updateHealthSchema.parse({
        successfulChecks: 0,
        failedChecks: 1,
        consecutiveFailures: 1,
        lastSuccessAt: null,
        lastFailureAt: 'C:\\Users\\alice\\Squirrel-Update.log',
        lastErrorCategory: 'CryptUnprotectData failed',
      }),
    ).toThrow();
    for (const code of ['STEER_UNSUPPORTED', 'USER_CANCELED', 'RUNTIME_RATE_LIMIT'] as const)
      expect(
        publicErrorSchema.parse({
          code,
          userMessage: 'public error',
          retryable: false,
        }).code,
      ).toBe(code);
  });

  it('validates task-scoped permission preset settings', () => {
    expect(permissionSettingsSchema.parse({ preset: 'auto', policyEpoch: 3 })).toEqual({
      preset: 'auto',
      policyEpoch: 3,
    });
    expect(() => permissionSettingsSchema.parse({ preset: 'root', policyEpoch: -1 })).toThrow();
    expect(
      permissionSetInputSchema.parse({
        taskId: 'task-1',
        preset: 'full',
        expectedPolicyEpoch: 3,
      }),
    ).toMatchObject({ preset: 'full', expectedPolicyEpoch: 3 });
    expect(() => permissionSetInputSchema.parse({ taskId: 'task-1', preset: 'full' })).toThrow();
  });

  it('validates immutable Tool Catalog metadata at the runtime boundary', () => {
    const digest = 'a'.repeat(64);
    const snapshot = {
      revision: 2,
      providerId: 'codex',
      workspaceId: 'workspace-1',
      entries: [
        {
          providerName: 'read_file',
          toolId: 'builtin:workspace:read-file@1',
          version: '1',
          kind: 'fileRead',
          schemaVersion: 1,
          inputSchema: { type: 'object' },
          inputSchemaDigest: digest,
          outputSchemaDigest: digest,
          schemaDigest: digest,
          sideEffect: 'read',
          risk: 'low',
          requiredCapabilities: ['workspace.read'],
          executionTarget: 'main',
          implementationKind: 'built-in',
          description: 'Read one Workspace file',
          parallelism: 'parallel',
          maxOutputBytes: 1_048_576,
          supportsCancellation: false,
          supportsBackground: false,
        },
      ],
      digest,
    };
    expect(toolCatalogSnapshotSchema.parse(snapshot)).toMatchObject({ providerId: 'codex' });
    for (const invalid of [
      { ...snapshot, entries: [{ ...snapshot.entries[0], risk: 'root' }] },
      { ...snapshot, entries: [{ ...snapshot.entries[0], sideEffect: 'unknown' }] },
      { ...snapshot, entries: [{ ...snapshot.entries[0], schemaVersion: 0 }] },
      { ...snapshot, entries: [{ ...snapshot.entries[0], parallelism: 'unbounded' }] },
      { ...snapshot, entries: [{ ...snapshot.entries[0], maxOutputBytes: 0 }] },
      { ...snapshot, entries: [{ ...snapshot.entries[0], requiredCapabilities: ['root'] }] },
      { ...snapshot, entries: [{ ...snapshot.entries[0], version: '2' }] },
      {
        ...snapshot,
        entries: [
          {
            ...snapshot.entries[0],
            implementationKind: 'built-in',
            executionTarget: 'mcp-gateway',
          },
        ],
      },
      { ...snapshot, providerId: 'Codex\nspoof' },
    ])
      expect(() => toolCatalogSnapshotSchema.parse(invalid)).toThrow();
  });

  it('validates the three user approval decisions and rejects unknown values', () => {
    for (const decision of ['allow_once', 'allow_task', 'deny'])
      expect(approvalContracts.approvalDecisionSchema.parse(decision)).toBe(decision);
    expect(() => approvalContracts.approvalDecisionSchema.parse('allow_forever')).toThrow();
  });

  it('validates the sanitized pending Approval DTO', () => {
    expect(approvalContracts.approvalSummarySchema.parse(pendingApproval)).toEqual(pendingApproval);
  });

  it('requires a decision only for resolved approvals', () => {
    const resolved = {
      ...pendingApproval,
      state: 'resolved',
      decision: 'deny',
      revision: 1,
      decidedAt: '2026-07-22T12:01:00.000Z',
    };
    expect(approvalContracts.approvalSummarySchema.parse(resolved)).toEqual(resolved);
    expect(() =>
      approvalContracts.approvalSummarySchema.parse({
        ...pendingApproval,
        decision: 'allow_once',
      }),
    ).toThrow();
    expect(() =>
      approvalContracts.approvalSummarySchema.parse({
        ...resolved,
        decision: null,
      }),
    ).toThrow();
  });

  it('keeps approval resolution strict and does not accept Renderer-supplied authority facts', () => {
    const resolve = {
      taskId: 'task-1',
      approvalId: 'approval-1',
      decision: 'allow_once',
      expectedRevision: 0,
      expectedPolicyEpoch: 3,
      challenge: 'approval-challenge-0001',
    };
    expect(approvalContracts.approvalResolveInputSchema.parse(resolve)).toEqual(resolve);
    expect(
      approvalContracts.approvalResolveInputSchema.parse({ ...resolve, userInputSelection: 1 }),
    ).toEqual({ ...resolve, userInputSelection: 1 });
    for (const userInputSelection of [-1, 3, 1.5])
      expect(() =>
        approvalContracts.approvalResolveInputSchema.parse({
          ...resolve,
          userInputSelection,
        }),
      ).toThrow();
    for (const forged of [
      { ...resolve, capability: 'shell.execute' },
      { ...resolve, resource: { kind: 'all' } },
      { ...resolve, executionSpecDigest: '0'.repeat(64) },
      { ...resolve, unknown: true },
    ])
      expect(() => approvalContracts.approvalResolveInputSchema.parse(forged)).toThrow();
  });

  it('validates approval lifecycle Turn events', () => {
    expect(
      turnEventSchema.parse({
        type: 'approval.requested',
        taskId: 'task-1',
        turnId: 'turn-1',
        seq: 5,
        approvalId: 'approval-1',
        approval: pendingApproval,
      }),
    ).toMatchObject({ type: 'approval.requested', approval: { state: 'pending' } });
    expect(
      turnEventSchema.parse({
        type: 'approval.resolved',
        taskId: 'task-1',
        turnId: 'turn-1',
        seq: 6,
        approvalId: 'approval-1',
        decision: 'deny',
        approval: {
          ...pendingApproval,
          state: 'resolved',
          decision: 'deny',
          revision: 1,
          decidedAt: '2026-07-22T12:01:00.000Z',
        },
      }),
    ).toMatchObject({ type: 'approval.resolved', approval: { decision: 'deny' } });
  });

  it('validates durable command lifecycle and bounded sequenced output events', () => {
    const command = {
      id: 'command-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'call-1',
      specDigest: 'a'.repeat(64),
      executable: '/usr/bin/printf',
      argv: ['ok'],
      cwd: '/workspace',
      envDelta: { PATH: '/usr/bin:/bin' },
      purpose: '変更の整合性を確認します',
      risk: 'high',
      state: 'running',
      pid: 123,
      exitCode: null,
      signal: null,
      outputBytes: 0,
      truncated: false,
      createdAt: '2026-07-23T00:00:00.000Z',
      startedAt: '2026-07-23T00:00:01.000Z',
      finishedAt: null,
    };
    expect(
      turnEventSchema.parse({
        type: 'command.started',
        taskId: 'task-1',
        turnId: 'turn-1',
        seq: 7,
        command,
      }),
    ).toMatchObject({ type: 'command.started', command: { state: 'running' } });
    expect(
      turnEventSchema.parse({
        type: 'command.output',
        taskId: 'task-1',
        turnId: 'turn-1',
        seq: 8,
        commandId: 'command-1',
        outputSeq: 1,
        stream: 'stderr',
        text: 'safe output',
        byteLength: 11,
      }),
    ).toMatchObject({ type: 'command.output', outputSeq: 1 });
  });

  it('binds Auto audit events to immutable reviewer and effective-decision facts', () => {
    const event = turnEventSchema.parse({
      type: 'permission.auto_decided',
      taskId: 'task-1',
      turnId: 'turn-1',
      seq: 9,
      autoDecision: {
        id: 'auto-1',
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-1',
        reviewRequestId: 'review-1',
        capability: 'workspace.read',
        source: 'narrow_allow',
        decision: 'allow',
        outcome: 'preset_auto_safe',
        reason: 'preset_auto_safe',
        risk: 'low',
        model: 'policy-engine',
        templateVersion: 'preset-auto-v1',
        requestFingerprint: 'a'.repeat(64),
        executionSpecDigest: 'b'.repeat(64),
        inputDigest: 'c'.repeat(64),
        policyEpoch: 3,
        createdAt: '2026-07-23T00:00:00.000Z',
      },
    });
    expect(event).toMatchObject({
      type: 'permission.auto_decided',
      autoDecision: { decision: 'allow', inputDigest: 'c'.repeat(64) },
    });
    if (event.type !== 'permission.auto_decided') throw new Error('Expected Auto decision event');
    expect(() =>
      turnEventSchema.parse({
        ...event,
        autoDecision: { ...event.autoDecision, inputDigest: 'not-a-digest' },
      }),
    ).toThrow();
  });

  it('represents waiting approval in reconnect snapshots without widening Runtime stages', () => {
    const snapshot = {
      lastSeq: 5,
      activeTurn: {
        turnId: 'turn-1',
        stage: 'waiting_approval',
        startedAtEpochMs: 1,
        streamedText: '',
        messageId: null,
      },
      queued: [],
      contextUsage: { usedTokens: 0, hardCapTokens: 32_000, projectTokens: 0, fragments: [] },
    };
    expect(turnSnapshotSchema.parse(snapshot)).toMatchObject({
      activeTurn: { turnId: 'turn-1', stage: 'waiting_approval' },
    });
  });

  it('keeps legacy long Goals readable while rejecting new Goals above the Codex limit', () => {
    const legacyObjective = '旧'.repeat(4_001);
    expect(
      contracts.goalSummarySchema.parse({
        objective: legacyObjective,
        status: 'paused',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        startedAt: '2026-08-07T00:00:00.000Z',
        updatedAt: '2026-08-07T00:00:00.000Z',
      }).objective,
    ).toBe(legacyObjective);
    expect(() =>
      contracts.goalStartInputSchema.parse({
        taskId: 'task-1',
        objective: legacyObjective,
        skills: [],
      }),
    ).toThrow();
  });
});
