import { execFile, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { electronTestExecutablePath } from './electron-test-runtime';
import type { AgentRecord, TeamSnapshot } from './persistence';
import { SqlitePersistenceClient, TeamConflictError } from './persistence';
import {
  TeamCoordinator,
  captureGitWorkspaceFingerprint,
  executeWithWatchdog,
  priorConversationForAgent,
  type TeamRuntimeConversationItem,
  type TeamWorkerRuntime,
  type WorkerRuntimeResult,
} from './team-coordinator';
import type { TeamEnvelope } from '@sprint-coder/domain';
import { TeamExecutionScheduler } from './team-execution-scheduler';
import { TeamIntegrationScheduler, type TeamIntegrationJob } from './team-integration-scheduler';
import { WorkerWorktreeManager } from './worker-worktree';
import type { RuntimeWorkspaceSet } from '../runtime-host/protocol';

const cleanup: string[] = [];
const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1';
const execFileAsync = promisify(execFile);

function removeTemporaryDirectory(
  directory: string,
  platform = process.platform,
  remove: typeof rmSync = rmSync,
): void {
  try {
    remove(directory, {
      recursive: true,
      force: true,
      maxRetries: platform === 'win32' ? 5 : 0,
      retryDelay: 100,
    });
  } catch (error) {
    // Git can retain Windows file handles beyond Node's retry window. The runner is ephemeral, so
    // an exhausted cleanup must not replace a successful integration assertion with an EPERM.
    if (platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return;
    throw error;
  }
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of cleanup.splice(0)) removeTemporaryDirectory(directory);
});

describe('removeTemporaryDirectory', () => {
  it('treats an exhausted Windows EPERM as best-effort cleanup', () => {
    const locked = Object.assign(new Error('locked'), { code: 'EPERM' });
    expect(() =>
      removeTemporaryDirectory('locked-directory', 'win32', () => {
        throw locked;
      }),
    ).not.toThrow();
  });

  it('rethrows cleanup errors other than a Windows EPERM', () => {
    const unexpected = Object.assign(new Error('unexpected'), { code: 'EIO' });
    expect(() =>
      removeTemporaryDirectory('broken-directory', 'win32', () => {
        throw unexpected;
      }),
    ).toThrow(unexpected);
  });
});

function createPersistence(): SqlitePersistenceClient {
  const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-team-coordinator-'));
  cleanup.push(directory);
  return new SqlitePersistenceClient(join(directory, 'test.sqlite3'));
}

function configureGitWorkspace(
  persistence: SqlitePersistenceClient,
  taskId: string,
): { workspace: string; worktreesRoot: string; manager: WorkerWorktreeManager } {
  const workspace = mkdtempSync(join(tmpdir(), 'sprint-coder-team-workspace-'));
  const worktreesRoot = mkdtempSync(join(tmpdir(), 'sprint-coder-team-worktrees-'));
  cleanup.push(workspace, worktreesRoot);
  expect(spawnSync('git', ['init', '-q', workspace]).status).toBe(0);
  writeFileSync(join(workspace, 'README.md'), 'base\n');
  expect(spawnSync('git', ['-C', workspace, 'add', 'README.md']).status).toBe(0);
  expect(
    spawnSync('git', [
      '-C',
      workspace,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '-m',
      'base',
    ]).status,
  ).toBe(0);
  persistence.setWorkspace(taskId, workspace);
  return {
    workspace,
    worktreesRoot,
    manager: new WorkerWorktreeManager({ worktreesRoot }),
  };
}

function coordinatorWithWorktrees(
  persistence: SqlitePersistenceClient,
  runtime: TeamWorkerRuntime,
  manager: WorkerWorktreeManager,
  integrationScheduler?: TeamIntegrationScheduler,
): TeamCoordinator {
  return new TeamCoordinator(
    persistence,
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    manager,
    undefined,
    integrationScheduler,
  );
}

class TestWorkerRuntime implements TeamWorkerRuntime {
  activeStarts = 0;
  maxActiveStarts = 0;
  readonly stopped: string[] = [];
  spoofClaims = false;
  completionStatus: 'succeeded' | 'failed' | 'partial' = 'succeeded';

  async start(_worker: AgentRecord): Promise<{ pid: null }> {
    this.activeStarts += 1;
    this.maxActiveStarts = Math.max(this.maxActiveStarts, this.activeStarts);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.activeStarts -= 1;
    return { pid: null };
  }

  async execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
  }): Promise<WorkerRuntimeResult> {
    return {
      claims: {
        deliveryId: input.envelope.deliveryId,
        sourceAgentId: input.envelope.sourceAgentId,
        targetAgentId: this.spoofClaims ? 'spoofed-worker' : input.envelope.targetAgentId,
      },
      completion: {
        status: this.completionStatus,
        summary: `${input.worker.role}: ${input.content}`,
        artifacts: [],
        verification: [{ name: 'test-runtime', outcome: 'pass' }],
        risks: [],
      },
      usage: { costCents: 1, tokens: 2, timeMs: 3, toolCalls: 4 },
    };
  }

  async stop(agentId: string): Promise<void> {
    this.stopped.push(agentId);
  }
}

class WorktreeWritingRuntime extends TestWorkerRuntime {
  readonly workspacePaths: Array<string | null | undefined> = [];

  override async execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
    workspacePath?: string | null;
  }): Promise<WorkerRuntimeResult> {
    this.workspacePaths.push(input.workspacePath);
    if (input.worker.writeCapable) {
      if (input.workspacePath === undefined || input.workspacePath === null)
        throw new Error('write step did not receive an isolated worktree');
      writeFileSync(join(input.workspacePath, 'worker-output.txt'), 'isolated\n');
    }
    return super.execute(input);
  }
}

class MultiRootWritingRuntime extends TestWorkerRuntime {
  readonly workspaceSets: RuntimeWorkspaceSet[] = [];
  readonly allWorkspaceSets: RuntimeWorkspaceSet[] = [];

  override async execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
    workspaceSet?: RuntimeWorkspaceSet;
  }): Promise<WorkerRuntimeResult> {
    if (input.workspaceSet !== undefined) this.allWorkspaceSets.push(input.workspaceSet);
    if (input.worker.writeCapable) {
      if (input.workspaceSet === undefined)
        throw new Error('write step did not receive an isolated root set');
      this.workspaceSets.push(input.workspaceSet);
      for (const root of input.workspaceSet.roots)
        writeFileSync(join(root.path, 'worker-output.txt'), `${root.label}\n`);
    }
    return super.execute(input);
  }
}

class PrimaryRootWritingRuntime extends MultiRootWritingRuntime {
  override async execute(input: Parameters<MultiRootWritingRuntime['execute']>[0]) {
    if (input.workspaceSet !== undefined) this.allWorkspaceSets.push(input.workspaceSet);
    if (input.worker.writeCapable) {
      if (input.workspaceSet === undefined)
        throw new Error('write step did not receive an isolated root set');
      this.workspaceSets.push(input.workspaceSet);
      const primary = input.workspaceSet.roots.find(({ role }) => role === 'primary');
      if (primary === undefined) throw new Error('isolated root set has no Primary');
      writeFileSync(join(primary.path, 'worker-output.txt'), `${primary.label}\n`);
    }
    return TestWorkerRuntime.prototype.execute.call(this, input);
  }
}

class ConflictingWorktreeRuntime extends TestWorkerRuntime {
  constructor(private readonly primaryWorkspace: string) {
    super();
  }

  override async execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
    workspacePath?: string | null;
  }): Promise<WorkerRuntimeResult> {
    if (input.workspacePath === undefined || input.workspacePath === null)
      throw new Error('write step did not receive an isolated worktree');
    writeFileSync(join(input.workspacePath, 'worker-only.txt'), 'preserve worker result\n');
    writeFileSync(join(this.primaryWorkspace, 'outside.txt'), 'external change\n');
    return super.execute(input);
  }
}

class CrashAfterIntegrationManager extends WorkerWorktreeManager {
  private failAfterIntegration = true;

  override async integrate(input: Parameters<WorkerWorktreeManager['integrate']>[0]) {
    const result = await super.integrate(input);
    if (this.failAfterIntegration) {
      this.failAfterIntegration = false;
      throw new Error('simulated app crash after Git integration');
    }
    return result;
  }
}

class FailRepositoryOnceManager extends WorkerWorktreeManager {
  private integrationAttempt = 0;

  constructor(
    options: ConstructorParameters<typeof WorkerWorktreeManager>[0],
    private readonly failingAttempt: number,
  ) {
    super(options);
  }

  override async integrate(input: Parameters<WorkerWorktreeManager['integrate']>[0]) {
    this.integrationAttempt += 1;
    if (this.integrationAttempt === this.failingAttempt) {
      throw new Error('simulated primary integration conflict');
    }
    return super.integrate(input);
  }
}

class TrackingIntegrationManager extends WorkerWorktreeManager {
  activeIntegrations = 0;
  maxActiveIntegrations = 0;
  readonly integratedRepositories: string[] = [];

  override async integrate(input: Parameters<WorkerWorktreeManager['integrate']>[0]) {
    this.activeIntegrations += 1;
    this.maxActiveIntegrations = Math.max(this.maxActiveIntegrations, this.activeIntegrations);
    this.integratedRepositories.push(realpathSync(input.repoPath));
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return await super.integrate(input);
    } finally {
      this.activeIntegrations -= 1;
    }
  }
}

class PausedIntegrationScheduler extends TeamIntegrationScheduler {
  readonly jobs: TeamIntegrationJob[] = [];

  override async submit(job: TeamIntegrationJob): Promise<void> {
    this.jobs.push(job);
    await new Promise<void>(() => undefined);
  }
}

class PausedCleanupManager extends WorkerWorktreeManager {
  override async cleanup(): Promise<never> {
    return new Promise<never>(() => undefined);
  }
}

class CrashAfterFirstWorktreeManager extends WorkerWorktreeManager {
  private crashed = false;

  override async ensureCreated(input: Parameters<WorkerWorktreeManager['ensureCreated']>[0]) {
    const result = await super.ensureCreated(input);
    if (!this.crashed) {
      this.crashed = true;
      throw new Error('simulated crash after first worktree creation');
    }
    return result;
  }
}

class BlockingWorkerRuntime extends TestWorkerRuntime {
  activeExecutions = 0;
  maxActiveExecutions = 0;
  readonly releases: Array<() => void> = [];
  readonly contents: string[] = [];

  override async execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
  }): Promise<WorkerRuntimeResult> {
    this.contents.push(input.content);
    this.activeExecutions += 1;
    this.maxActiveExecutions = Math.max(this.maxActiveExecutions, this.activeExecutions);
    await new Promise<void>((resolve) => this.releases.push(resolve));
    this.activeExecutions -= 1;
    return {
      claims: {
        deliveryId: input.envelope.deliveryId,
        sourceAgentId: input.envelope.sourceAgentId,
        targetAgentId: input.envelope.targetAgentId,
      },
      completion: {
        status: 'succeeded',
        summary: `${input.worker.role}: ${input.content}`,
        artifacts: [],
        verification: [{ name: 'blocking-runtime', outcome: 'pass' }],
        risks: [],
      },
      usage: { costCents: 1, tokens: 2, timeMs: 3, toolCalls: 4 },
    };
  }
}

class BlockingDistinctFileRuntime extends BlockingWorkerRuntime {
  readonly worktreePaths: string[] = [];

  override async execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
    workspacePath?: string | null;
  }): Promise<WorkerRuntimeResult> {
    if (input.workspacePath === undefined || input.workspacePath === null)
      throw new Error('write step did not receive an isolated worktree');
    this.worktreePaths.push(input.workspacePath);
    writeFileSync(join(input.workspacePath, `${input.content}.txt`), `${input.content}\n`);
    return super.execute(input);
  }
}

class BlockingSameFileRuntime extends BlockingWorkerRuntime {
  override async execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
    workspacePath?: string | null;
  }): Promise<WorkerRuntimeResult> {
    if (input.workspacePath === undefined || input.workspacePath === null)
      throw new Error('write step did not receive an isolated worktree');
    writeFileSync(join(input.workspacePath, 'README.md'), `${input.content}\n`);
    return super.execute(input);
  }
}

class InterruptibleWorkerRuntime extends TestWorkerRuntime {
  readonly contents: Array<{ agentId: string; content: string }> = [];
  readonly priorConversations: Array<
    readonly { direction: 'received' | 'sent'; role: string; content: string }[]
  > = [];
  private readonly pending = new Map<
    string,
    {
      resolve(): void;
      reject(error: Error): void;
    }
  >();

  override async execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
    priorConversation?: readonly TeamRuntimeConversationItem[];
  }): Promise<WorkerRuntimeResult> {
    this.contents.push({ agentId: input.worker.id, content: input.content });
    this.priorConversations.push(input.priorConversation ?? []);
    await new Promise<void>((resolve, reject) => {
      this.pending.set(input.worker.id, { resolve, reject });
    }).finally(() => this.pending.delete(input.worker.id));
    return {
      claims: {
        deliveryId: input.envelope.deliveryId,
        sourceAgentId: input.envelope.sourceAgentId,
        targetAgentId: input.envelope.targetAgentId,
      },
      completion: {
        status: 'succeeded',
        summary: `${input.worker.role}: ${input.content}`,
        artifacts: [],
        verification: [{ name: 'interruptible-runtime', outcome: 'pass' }],
        risks: [],
      },
      usage: { costCents: 1, tokens: 2, timeMs: 3, toolCalls: 4 },
    };
  }

  complete(agentId: string): void {
    const pending = this.pending.get(agentId);
    if (pending === undefined) throw new Error('Agent does not have a running execution');
    pending.resolve();
  }

  override async stop(agentId: string): Promise<void> {
    this.pending.get(agentId)?.reject(new Error('Worker execution stopped'));
  }
}

class ConfirmedStopWorkerRuntime extends TestWorkerRuntime {
  activeExecutions = 0;
  maxActiveExecutions = 0;
  executeCount = 0;
  stopCount = 0;
  private readonly pending = new Map<string, { reject(error: Error): void }>();
  private readonly stopAcks: Array<() => void> = [];

  override async execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
  }): Promise<WorkerRuntimeResult> {
    this.executeCount += 1;
    this.activeExecutions += 1;
    this.maxActiveExecutions = Math.max(this.maxActiveExecutions, this.activeExecutions);
    await new Promise<void>((_resolve, reject) => {
      this.pending.set(input.worker.id, { reject });
    }).finally(() => {
      this.pending.delete(input.worker.id);
      this.activeExecutions -= 1;
    });
    throw new Error('unreachable');
  }

  override async stop(agentId: string): Promise<void> {
    this.stopCount += 1;
    await new Promise<void>((resolve) => {
      this.stopAcks.push(() => {
        this.pending.get(agentId)?.reject(new Error('confirmed stop'));
        resolve();
      });
    });
  }

  acknowledgeNextStop(): void {
    const acknowledge = this.stopAcks.shift();
    if (acknowledge === undefined) throw new Error('No pending stop confirmation');
    acknowledge();
  }

  pendingStopCount(): number {
    return this.stopAcks.length;
  }
}

class FailOnceWorkerRuntime extends TestWorkerRuntime {
  readonly contents: string[] = [];
  executeCount = 0;

  override async execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
  }): Promise<WorkerRuntimeResult> {
    this.executeCount += 1;
    this.contents.push(input.content);
    if (this.executeCount === 1) throw new Error('deliberate first-attempt failure');
    return super.execute(input);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('priorConversationForAgent', () => {
  it('includes only the addressed Agent conversation and preserves its order', () => {
    const snapshot = {
      agents: [
        { id: 'leader', role: 'Leader' },
        { id: 'worker-a', role: '調査' },
        { id: 'worker-b', role: '実装' },
      ],
      messages: [
        {
          seq: 1,
          sourceAgentId: 'leader',
          targetAgentId: 'worker-a',
          content: '最初の依頼',
        },
        {
          seq: 2,
          sourceAgentId: 'leader',
          targetAgentId: 'worker-b',
          content: '他Workerだけの秘密',
        },
        {
          seq: 3,
          sourceAgentId: 'worker-a',
          targetAgentId: 'leader',
          content: '作成済みの論点',
        },
        {
          seq: 4,
          sourceAgentId: 'leader',
          targetAgentId: 'worker-a',
          content: '現在の依頼',
        },
      ],
    } as unknown as TeamSnapshot;

    expect(priorConversationForAgent(snapshot, 'worker-a', 4)).toEqual([
      { direction: 'received', role: 'Leader', content: '最初の依頼' },
      { direction: 'sent', role: 'Leader', content: '作成済みの論点' },
    ]);
  });
});

describe('executeWithWatchdog', () => {
  it('distinguishes missing heartbeat from semantic progress timeout', async () => {
    vi.useFakeTimers();
    let stops = 0;
    let executionSignal: AbortSignal | undefined;
    const pending = executeWithWatchdog({
      execute: async (_observe, signal) => {
        executionSignal = signal;
        return new Promise<never>(() => undefined);
      },
      hardTimeoutMs: 30 * 60_000,
      stop: async () => {
        stops += 1;
      },
    });
    expect(executionSignal?.aborted).toBe(false);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'heartbeat_timeout' });

    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(executionSignal?.aborted).toBe(true);
    expect(stops).toBe(1);
  });

  it('expires after 15 minutes without meaningful progress even while heartbeats continue', async () => {
    vi.useFakeTimers();
    let stops = 0;
    const pending = executeWithWatchdog({
      execute: async (observe) => {
        setInterval(() => observe({ type: 'heartbeat', at: new Date().toISOString() }), 15_000);
        return new Promise<never>(() => undefined);
      },
      hardTimeoutMs: 30 * 60_000,
      stop: async () => {
        stops += 1;
      },
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'idle_timeout' });

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await rejected;
    expect(stops).toBe(1);
  });

  it('enforces the 30 minute hard limit despite continuous meaningful progress', async () => {
    vi.useFakeTimers();
    let stops = 0;
    const pending = executeWithWatchdog({
      execute: async (observe) => {
        setInterval(
          () =>
            observe({
              type: 'activity',
              phase: 'working',
              label: 'still working',
              at: new Date().toISOString(),
            }),
          30_000,
        );
        return new Promise<never>(() => undefined);
      },
      hardTimeoutMs: 30 * 60_000,
      stop: async () => {
        stops += 1;
      },
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'hard_timeout' });

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await rejected;
    expect(stops).toBe(1);
  });
});

describe('Mission workspace fingerprint', () => {
  it('detects tracked and untracked content changes after a checkpoint', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'sprint-coder-mission-fingerprint-'));
    cleanup.push(workspace);
    writeFileSync(join(workspace, 'tracked.txt'), 'initial\n');
    expect(spawnSync('git', ['-C', workspace, 'init']).status).toBe(0);
    expect(spawnSync('git', ['-C', workspace, 'add', '.']).status).toBe(0);
    expect(
      spawnSync('git', [
        '-C',
        workspace,
        '-c',
        'user.name=Sprint Coder Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'fixture',
      ]).status,
    ).toBe(0);
    const checkpoint = captureGitWorkspaceFingerprint(workspace);

    writeFileSync(join(workspace, 'tracked.txt'), 'changed\n');
    expect(captureGitWorkspaceFingerprint(workspace)).not.toEqual(checkpoint);
    writeFileSync(join(workspace, 'tracked.txt'), 'initial\n');
    writeFileSync(join(workspace, 'untracked.txt'), 'one\n');
    const firstUntracked = captureGitWorkspaceFingerprint(workspace);
    writeFileSync(join(workspace, 'untracked.txt'), 'two\n');
    expect(captureGitWorkspaceFingerprint(workspace)).not.toEqual(firstUntracked);
  });
});

if (runsWithElectronAbi)
  describe('TeamCoordinator', () => {
    it('never redelivers a timed-out Worker before its previous runtime stop is confirmed', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Confirmed timeout stop');
      const runtime = new ConfirmedStopWorkerRuntime();
      const coordinator = new TeamCoordinator(
        persistence,
        runtime,
        () => undefined,
        () => new Date(),
        20,
      );
      const worker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'timeout worker',
        objective: 'prove serial retry',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });
      const submission = await coordinator.assignTask({
        taskId: task.id,
        targetAgentId: worker.id,
        content: 'wait forever',
        doneCriteria: ['must time out'],
      });

      await waitFor(() => runtime.pendingStopCount() === 1);
      expect(runtime.executeCount).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(runtime.executeCount).toBe(1);

      runtime.acknowledgeNextStop();
      await waitFor(() => runtime.executeCount === 2);
      await waitFor(() => runtime.pendingStopCount() === 1);
      runtime.acknowledgeNextStop();
      await waitFor(() => persistence.getTeamExecution(submission.executionId).state === 'failed');

      expect(runtime.maxActiveExecutions).toBe(1);
      expect(runtime.stopCount).toBe(2);
      expect(persistence.listTeamAttempts(submission.executionId)).toMatchObject([
        { ordinal: 1, state: 'failed', startReason: 'initial' },
        { ordinal: 2, state: 'failed', startReason: 'automatic_retry' },
      ]);
      persistence.close();
    });

    it('runs Mission steps sequentially and checkpoints before starting the next step', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Sequential Mission');
      const runtime = new BlockingWorkerRuntime();
      const { manager } = configureGitWorkspace(persistence, task.id);
      const coordinator = coordinatorWithWorktrees(persistence, runtime, manager);
      const firstWorker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'reader',
        objective: 'inspect',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });
      const secondWorker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'writer',
        objective: 'implement',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });

      const assigned = await coordinator.assignMission({
        taskId: task.id,
        objective: 'inspect then implement',
        doneCriteria: ['both steps complete'],
        steps: [
          {
            workerId: firstWorker.id,
            objective: 'inspect the workspace',
            doneCriteria: ['inspection reported'],
            access: 'read-only',
          },
          {
            workerId: secondWorker.id,
            objective: 'implement the change',
            doneCriteria: ['change verified'],
            access: 'workspace-write',
          },
        ],
      });

      await waitFor(() => runtime.contents.length === 1);
      let mission = persistence.getTeamMission(assigned.id);
      expect(
        mission.steps.map(({ executionId }) => persistence.getTeamExecution(executionId).state),
      ).toEqual(['running', 'assigned']);

      runtime.releases.shift()?.();
      await waitFor(() => runtime.contents.length === 2);
      mission = persistence.getTeamMission(assigned.id);
      expect(mission.steps[0]?.checkpoint).toMatchObject({
        summary: expect.stringContaining('inspect the workspace'),
      });
      expect(persistence.getTeamExecution(mission.steps[0]!.executionId).state).toBe('completed');
      expect(persistence.getTeamExecution(mission.steps[1]!.executionId).state).toBe('running');

      runtime.releases.shift()?.();
      await waitFor(() => persistence.getTeamMission(assigned.id).state === 'completed', 5_000);
      mission = persistence.getTeamMission(assigned.id);
      expect(mission.steps.every(({ checkpoint }) => checkpoint !== null)).toBe(true);
      expect(
        mission.steps.map(({ executionId }) => persistence.listTeamAttempts(executionId)),
      ).toMatchObject([
        [{ ordinal: 1, state: 'completed', startReason: 'initial' }],
        [{ ordinal: 1, state: 'completed', startReason: 'initial' }],
      ]);
      expect(persistence.checkTeamIntegrity()).toEqual({
        sqlite: 'ok',
        inconsistencies: [],
      });
      persistence.close();
    });

    it('runs a write step in an isolated worktree and integrates one clean commit', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Isolated writable Mission');
      const runtime = new WorktreeWritingRuntime();
      const { workspace, manager } = configureGitWorkspace(persistence, task.id);
      const coordinator = coordinatorWithWorktrees(persistence, runtime, manager);
      const writer = await coordinator.hireWorker({
        taskId: task.id,
        role: 'writer',
        objective: 'write in isolation',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      const reader = await coordinator.hireWorker({
        taskId: task.id,
        role: 'reviewer',
        objective: 'verify integrated output',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });

      const assigned = await coordinator.assignMission({
        taskId: task.id,
        objective: 'write then verify',
        doneCriteria: ['integrated output is available'],
        steps: [
          {
            workerId: writer.id,
            objective: 'perform isolated write',
            doneCriteria: ['worker-output.txt exists'],
            access: 'workspace-write',
          },
          {
            workerId: reader.id,
            objective: 'verify integrated output',
            doneCriteria: ['integrated output inspected'],
            access: 'read-only',
          },
        ],
      });

      await waitFor(
        () =>
          ['completed', 'waiting_resume', 'failed', 'canceled'].includes(
            persistence.getTeamMission(assigned.id).state,
          ),
        5_000,
      );

      const mission = persistence.getTeamMission(assigned.id);
      const writeWorktree = persistence.getTeamMissionWorktree(mission.steps[0]!.executionId);
      const isolatedState = {
        missionState: mission.state,
        executionStates: mission.steps.map(
          ({ executionId }) => persistence.getTeamExecution(executionId).state,
        ),
        worktree: writeWorktree,
        checkpoint: mission.steps[0]?.checkpoint,
        currentFingerprint: captureGitWorkspaceFingerprint(workspace),
        runtimeWorkspacePaths: runtime.workspacePaths,
        secondAttempts: persistence.listTeamAttempts(mission.steps[1]!.executionId),
        secondTask: persistence.getTeamTask(
          persistence.getTeamExecutionDispatch(mission.steps[1]!.executionId).teamTaskId,
        ),
      };
      expect(mission.state, JSON.stringify(isolatedState, null, 2)).toBe('completed');
      expect(isolatedState.executionStates).toEqual(['completed', 'completed']);
      expect(runtime.workspacePaths[0]).not.toBe(workspace);
      expect(runtime.workspacePaths[1]).toBeUndefined();
      expect(readFileSync(join(workspace, 'worker-output.txt'), 'utf8')).toBe('isolated\n');
      expect(
        spawnSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' }).stdout,
      ).toBe('');
      expect(
        spawnSync('git', ['-C', workspace, 'log', '-1', '--pretty=%s'], {
          encoding: 'utf8',
        }).stdout,
      ).toContain(`Sprint Coder Mission ${assigned.id} step 1`);
      expect(writeWorktree).toMatchObject({
        state: 'cleaned',
        changedFiles: ['worker-output.txt'],
      });
      expect(existsSync(writeWorktree!.path)).toBe(false);
      expect(coordinator.get(task.id)?.missions[0]?.steps[0]?.worktree).toMatchObject({
        state: 'cleaned',
        changedFiles: ['worker-output.txt'],
      });
      persistence.close();
    });

    it('runs an explicitly workspace-write standalone assignment inside isolation', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Standalone writable execution');
      const runtime = new WorktreeWritingRuntime();
      const { workspace, manager } = configureGitWorkspace(persistence, task.id);
      const coordinator = coordinatorWithWorktrees(persistence, runtime, manager);
      const writer = await coordinator.hireWorker({
        taskId: task.id,
        role: 'writer',
        objective: 'write one bounded change',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });

      const submission = await coordinator.assignTask({
        taskId: task.id,
        targetAgentId: writer.id,
        content: 'write the output',
        doneCriteria: ['worker-output.txt is integrated'],
        accessMode: 'workspace-write',
      });
      await waitFor(
        () => persistence.getTeamExecution(submission.executionId).state === 'completed',
        15_000,
      );
      await waitFor(
        () =>
          persistence.getTeamExecutionIsolation(submission.executionId)?.repositories[0]?.state ===
          'cleaned',
      );
      expect(readFileSync(join(workspace, 'worker-output.txt'), 'utf8')).toBe('isolated\n');
      expect(persistence.getTeamExecutionIsolation(submission.executionId)).toMatchObject({
        phase: 'completed',
        repositories: [{ state: 'cleaned' }],
      });
      expect(persistence.getTeamMissionWorktree(submission.executionId)).toBeNull();
      persistence.close();
    });

    it('exposes standalone integration-only resume without rerunning the Worker', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Standalone integration resume');
      const runtime = new WorktreeWritingRuntime();
      const { workspace, worktreesRoot } = configureGitWorkspace(persistence, task.id);
      const manager = new FailRepositoryOnceManager({ worktreesRoot }, 1);
      const coordinator = coordinatorWithWorktrees(persistence, runtime, manager);
      const writer = await coordinator.hireWorker({
        taskId: task.id,
        role: 'writer',
        objective: 'write once and resume integration',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      const submission = await coordinator.assignTask({
        taskId: task.id,
        targetAgentId: writer.id,
        content: 'write the output once',
        doneCriteria: ['worker-output.txt is integrated'],
        accessMode: 'workspace-write',
      });

      await waitFor(
        () => persistence.getTeamExecution(submission.executionId).state === 'waiting_resume',
        15_000,
      );
      expect(persistence.getTeamExecutionIsolation(submission.executionId)).toMatchObject({
        phase: 'waiting_resume',
        resumeKind: 'integration',
      });
      expect(runtime.workspacePaths).toHaveLength(1);
      expect(persistence.listTeamAttempts(submission.executionId)).toHaveLength(1);

      await coordinator.resumeExecutionIntegration(task.id, submission.executionId);
      expect(persistence.getTeamExecution(submission.executionId).state).toBe('completed');
      expect(runtime.workspacePaths).toHaveLength(1);
      expect(persistence.listTeamAttempts(submission.executionId)).toHaveLength(1);
      expect(persistence.getTeamExecutionIsolationCompletion(submission.executionId)).toBeNull();
      expect(readFileSync(join(workspace, 'worker-output.txt'), 'utf8')).toBe('isolated\n');
      persistence.close();
    });

    it('restores a saved waiting integration after restart without rerunning the Worker', async () => {
      const databaseDirectory = mkdtempSync(join(tmpdir(), 'sprint-coder-integration-restart-'));
      cleanup.push(databaseDirectory);
      const databasePath = join(databaseDirectory, 'test.sqlite3');
      let persistence = new SqlitePersistenceClient(databasePath);
      const task = persistence.createTask('Waiting integration restart recovery');
      const runtime = new WorktreeWritingRuntime();
      const { workspace, worktreesRoot, manager } = configureGitWorkspace(persistence, task.id);
      const pausedScheduler = new PausedIntegrationScheduler();
      const coordinator = coordinatorWithWorktrees(persistence, runtime, manager, pausedScheduler);
      const writer = await coordinator.hireWorker({
        taskId: task.id,
        role: 'restart writer',
        objective: 'finish before restart',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      const submission = await coordinator.assignTask({
        taskId: task.id,
        targetAgentId: writer.id,
        content: 'write before restart',
        doneCriteria: ['saved result is integrated after restart'],
        accessMode: 'workspace-write',
      });

      await waitFor(
        () =>
          pausedScheduler.jobs.length === 1 &&
          persistence.getTeamExecutionIsolation(submission.executionId)?.phase ===
            'waiting_integration',
        15_000,
      );
      expect(
        persistence.getTeamExecutionIsolationCompletion(submission.executionId),
      ).not.toBeNull();
      expect(persistence.getTeamExecution(submission.executionId).state).toBe('running');
      expect(runtime.workspacePaths).toHaveLength(1);
      persistence.close();

      persistence = new SqlitePersistenceClient(databasePath);
      persistence.initializeMutationRecovery('integration-restart', '2026-08-08T10:00:00.000Z');
      expect(persistence.getTeamExecution(submission.executionId).state).toBe('waiting_resume');
      expect(persistence.getTeamExecutionIsolation(submission.executionId)?.phase).toBe(
        'waiting_integration',
      );
      expect(persistence.listTeamAttempts(submission.executionId)).toMatchObject([
        { state: 'running', ordinal: 1 },
      ]);
      const resumedCoordinator = coordinatorWithWorktrees(
        persistence,
        runtime,
        new WorkerWorktreeManager({ worktreesRoot }),
      );
      resumedCoordinator.recoverOnStartup();

      await waitFor(
        () => persistence.getTeamExecution(submission.executionId).state === 'completed',
        15_000,
      );
      expect(runtime.workspacePaths).toHaveLength(1);
      expect(persistence.listTeamAttempts(submission.executionId)).toMatchObject([
        { state: 'completed', ordinal: 1 },
      ]);
      expect(readFileSync(join(workspace, 'worker-output.txt'), 'utf8')).toBe('isolated\n');
      expect(spawnSync('git', ['-C', workspace, 'status', '--porcelain']).stdout.toString()).toBe(
        '',
      );
      await waitFor(
        () => persistence.getTeamExecutionIsolationCompletion(submission.executionId) === null,
        15_000,
      );
      expect(persistence.getTeamExecutionIsolationCompletion(submission.executionId)).toBeNull();
      persistence.close();
    });

    it('reclaims a clean integrated app-owned worktree after restart', async () => {
      const databaseDirectory = mkdtempSync(join(tmpdir(), 'sprint-coder-cleanup-restart-'));
      cleanup.push(databaseDirectory);
      const databasePath = join(databaseDirectory, 'test.sqlite3');
      let persistence = new SqlitePersistenceClient(databasePath);
      const task = persistence.createTask('Integrated cleanup restart recovery');
      const runtime = new WorktreeWritingRuntime();
      const { worktreesRoot } = configureGitWorkspace(persistence, task.id);
      const coordinator = coordinatorWithWorktrees(
        persistence,
        runtime,
        new PausedCleanupManager({ worktreesRoot }),
      );
      const writer = await coordinator.hireWorker({
        taskId: task.id,
        role: 'cleanup writer',
        objective: 'leave an integrated worktree for restart',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      const submission = await coordinator.assignTask({
        taskId: task.id,
        targetAgentId: writer.id,
        content: 'write before cleanup restart',
        doneCriteria: ['integrated output is retained'],
        accessMode: 'workspace-write',
      });
      await waitFor(
        () => persistence.getTeamExecutionIsolation(submission.executionId)?.phase === 'completed',
        15_000,
      );
      const worktreePath = persistence.getTeamExecutionIsolation(submission.executionId)!
        .repositories[0]!.worktreePath;
      expect(existsSync(worktreePath)).toBe(true);
      expect(
        persistence.getTeamExecutionIsolationCompletion(submission.executionId),
      ).not.toBeNull();
      persistence.close();

      persistence = new SqlitePersistenceClient(databasePath);
      persistence.initializeMutationRecovery('cleanup-restart', '2026-08-08T10:00:00.000Z');
      coordinatorWithWorktrees(
        persistence,
        runtime,
        new WorkerWorktreeManager({ worktreesRoot }),
      ).recoverOnStartup();
      await waitFor(
        () =>
          !existsSync(worktreePath) &&
          persistence
            .getTeamExecutionIsolation(submission.executionId)
            ?.repositories.every(({ state }) => state === 'cleaned') === true,
        15_000,
      );
      expect(persistence.getTeamExecutionIsolation(submission.executionId)).toMatchObject({
        phase: 'completed',
        repositories: [{ state: 'cleaned' }],
      });
      expect(persistence.getTeamExecutionIsolationCompletion(submission.executionId)).toBeNull();
      persistence.close();
    });

    it('keeps a dirty integrated worktree as restart evidence', async () => {
      const databaseDirectory = mkdtempSync(join(tmpdir(), 'sprint-coder-dirty-restart-'));
      cleanup.push(databaseDirectory);
      const databasePath = join(databaseDirectory, 'test.sqlite3');
      let persistence = new SqlitePersistenceClient(databasePath);
      const task = persistence.createTask('Dirty cleanup restart evidence');
      const runtime = new WorktreeWritingRuntime();
      const { worktreesRoot } = configureGitWorkspace(persistence, task.id);
      const coordinator = coordinatorWithWorktrees(
        persistence,
        runtime,
        new PausedCleanupManager({ worktreesRoot }),
      );
      const writer = await coordinator.hireWorker({
        taskId: task.id,
        role: 'evidence writer',
        objective: 'retain dirty evidence',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      const submission = await coordinator.assignTask({
        taskId: task.id,
        targetAgentId: writer.id,
        content: 'write before dirty restart',
        doneCriteria: ['dirty evidence remains'],
        accessMode: 'workspace-write',
      });
      await waitFor(
        () => persistence.getTeamExecutionIsolation(submission.executionId)?.phase === 'completed',
        15_000,
      );
      const worktreePath = persistence.getTeamExecutionIsolation(submission.executionId)!
        .repositories[0]!.worktreePath;
      writeFileSync(join(worktreePath, 'post-integration-evidence.txt'), 'do not delete\n');
      persistence.close();

      persistence = new SqlitePersistenceClient(databasePath);
      persistence.initializeMutationRecovery('dirty-restart', '2026-08-08T10:00:00.000Z');
      coordinatorWithWorktrees(
        persistence,
        runtime,
        new WorkerWorktreeManager({ worktreesRoot }),
      ).recoverOnStartup();
      await waitFor(
        () =>
          persistence.getTeamExecutionIsolation(submission.executionId)?.phase === 'quarantined',
        15_000,
      );
      expect(existsSync(worktreePath)).toBe(true);
      expect(readFileSync(join(worktreePath, 'post-integration-evidence.txt'), 'utf8')).toBe(
        'do not delete\n',
      );
      persistence.close();
    });

    it('runs three same-repository writers concurrently and integrates three FIFO commits', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Three parallel repository writers');
      const runtime = new BlockingDistinctFileRuntime();
      const { workspace, manager } = configureGitWorkspace(persistence, task.id);
      const integrate = vi.spyOn(manager, 'integrate');
      const coordinator = coordinatorWithWorktrees(persistence, runtime, manager);
      const workers = await Promise.all(
        ['alpha', 'bravo', 'charlie'].map((role) =>
          coordinator.hireWorker({
            taskId: task.id,
            role,
            objective: `write ${role}`,
            contextInheritancePolicy: 'none',
            writeCapable: true,
          }),
        ),
      );
      const submissions: Awaited<ReturnType<TeamCoordinator['assignTask']>>[] = [];
      for (const [index, worker] of workers.entries()) {
        const name = ['alpha', 'bravo', 'charlie'][index]!;
        submissions.push(
          await coordinator.assignTask({
            taskId: task.id,
            targetAgentId: worker.id,
            content: name,
            doneCriteria: [`${name}.txt is integrated`],
            accessMode: 'workspace-write',
          }),
        );
      }

      await waitFor(() => runtime.activeExecutions === 3 && runtime.releases.length === 3);
      expect(runtime.maxActiveExecutions).toBe(3);
      expect(new Set(runtime.worktreePaths).size).toBe(3);
      expect(
        submissions.map(
          ({ executionId }) => persistence.getTeamExecutionIsolation(executionId)?.phase,
        ),
      ).toEqual(['running', 'running', 'running']);

      for (let completed = 1; completed <= submissions.length; completed += 1) {
        runtime.releases.shift()?.();
        await waitFor(
          () =>
            submissions.filter(
              ({ executionId }) => persistence.getTeamExecution(executionId).state === 'completed',
            ).length === completed,
          15_000,
        );
      }

      expect(integrate).toHaveBeenCalledTimes(3);
      expect(
        spawnSync('git', ['-C', workspace, 'rev-list', '--count', 'HEAD']).stdout.toString(),
      ).toBe('4\n');
      for (const name of ['alpha', 'bravo', 'charlie'])
        expect(readFileSync(join(workspace, `${name}.txt`), 'utf8')).toBe(`${name}\n`);
      expect(spawnSync('git', ['-C', workspace, 'status', '--porcelain']).stdout.toString()).toBe(
        '',
      );
      await waitFor(
        () =>
          submissions.every(
            ({ executionId }) =>
              persistence.getTeamExecutionIsolation(executionId)?.repositories[0]?.state ===
              'cleaned',
          ),
        15_000,
      );
      expect(
        submissions.map(
          ({ executionId }) =>
            persistence.getTeamExecutionIsolation(executionId)?.repositories[0]?.state,
        ),
      ).toEqual(['cleaned', 'cleaned', 'cleaned']);
      persistence.close();
    });

    it('preserves a conflicting Worker worktree and pauses only that integration', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Conflicting parallel repository writers');
      const runtime = new BlockingSameFileRuntime();
      const { workspace, manager } = configureGitWorkspace(persistence, task.id);
      const coordinator = coordinatorWithWorktrees(persistence, runtime, manager);
      const workers = await Promise.all(
        ['first writer', 'second writer'].map((role) =>
          coordinator.hireWorker({
            taskId: task.id,
            role,
            objective: role,
            contextInheritancePolicy: 'none',
            writeCapable: true,
          }),
        ),
      );
      const submissions: Awaited<ReturnType<TeamCoordinator['assignTask']>>[] = [];
      for (const [index, worker] of workers.entries())
        submissions.push(
          await coordinator.assignTask({
            taskId: task.id,
            targetAgentId: worker.id,
            content: index === 0 ? 'first version' : 'second version',
            doneCriteria: ['README.md is integrated'],
            accessMode: 'workspace-write',
          }),
        );

      await waitFor(() => runtime.activeExecutions === 2 && runtime.releases.length === 2);
      runtime.releases.shift()?.();
      await waitFor(
        () =>
          submissions.some(
            ({ executionId }) => persistence.getTeamExecution(executionId).state === 'completed',
          ),
        15_000,
      );
      runtime.releases.shift()?.();
      await waitFor(
        () =>
          submissions.every(({ executionId }) =>
            ['completed', 'waiting_resume'].includes(
              persistence.getTeamExecution(executionId).state,
            ),
          ),
        15_000,
      );

      const waiting = submissions.find(
        ({ executionId }) => persistence.getTeamExecution(executionId).state === 'waiting_resume',
      );
      expect(waiting).toBeDefined();
      const waitingIsolation = persistence.getTeamExecutionIsolation(waiting!.executionId);
      expect(waitingIsolation).toMatchObject({
        phase: 'waiting_resume',
        resumeKind: 'integration',
        repositories: [{ state: 'ready' }],
      });
      expect(existsSync(waitingIsolation!.repositories[0]!.worktreePath)).toBe(true);
      expect(persistence.getTeamExecutionIsolationCompletion(waiting!.executionId)).not.toBeNull();
      expect(['first version\n', 'second version\n']).toContain(
        readFileSync(join(workspace, 'README.md'), 'utf8'),
      );
      expect(spawnSync('git', ['-C', workspace, 'status', '--porcelain']).stdout.toString()).toBe(
        '',
      );
      persistence.close();
    });

    it('runs concurrent writers whose distinct roots share one repository', async () => {
      const persistence = createPersistence();
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sprint-coder-team-concurrent-repo-')));
      const worktreesRoot = mkdtempSync(join(tmpdir(), 'sprint-coder-team-concurrent-worktrees-'));
      cleanup.push(repo, worktreesRoot);
      const firstRoot = join(repo, 'first');
      const secondRoot = join(repo, 'second');
      mkdirSync(firstRoot);
      mkdirSync(secondRoot);
      expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
      writeFileSync(join(firstRoot, 'README.md'), 'first\n');
      writeFileSync(join(secondRoot, 'README.md'), 'second\n');
      expect(spawnSync('git', ['-C', repo, 'add', '.']).status).toBe(0);
      expect(
        spawnSync('git', [
          '-C',
          repo,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '-q',
          '-m',
          'base',
        ]).status,
      ).toBe(0);
      const firstProject = persistence.createProject({
        name: 'First sibling root',
        folders: [
          {
            id: '50000000-0000-4000-8000-000000000001',
            path: firstRoot,
            canonicalPath: firstRoot,
            label: 'first',
            role: 'primary',
            workspaceKey: 'b'.repeat(64),
            rootIdentityDigest: 'c'.repeat(64),
          },
        ],
      });
      const secondProject = persistence.createProject({
        name: 'Second sibling root',
        folders: [
          {
            id: '50000000-0000-4000-8000-000000000002',
            path: secondRoot,
            canonicalPath: secondRoot,
            label: 'second',
            role: 'primary',
            workspaceKey: 'd'.repeat(64),
            rootIdentityDigest: 'e'.repeat(64),
          },
        ],
      });
      const firstTask = persistence.createTask('First concurrent writer', false, firstProject.id);
      const secondTask = persistence.createTask(
        'Second concurrent writer',
        false,
        secondProject.id,
      );
      const runtime = new BlockingWorkerRuntime();
      const manager = new TrackingIntegrationManager({ worktreesRoot });
      const coordinator = coordinatorWithWorktrees(persistence, runtime, manager);
      const firstWorker = await coordinator.hireWorker({
        taskId: firstTask.id,
        role: 'first writer',
        objective: 'run concurrently',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      const secondWorker = await coordinator.hireWorker({
        taskId: secondTask.id,
        role: 'second writer',
        objective: 'overlap the first writer',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      const first = await coordinator.assignTask({
        taskId: firstTask.id,
        targetAgentId: firstWorker.id,
        content: 'first write',
        doneCriteria: ['first completes'],
        accessMode: 'workspace-write',
      });
      await waitFor(() => runtime.releases.length === 1);
      const second = await coordinator.assignTask({
        taskId: secondTask.id,
        targetAgentId: secondWorker.id,
        content: 'second write',
        doneCriteria: ['second overlaps'],
        accessMode: 'workspace-write',
      });
      await waitFor(() => runtime.activeExecutions === 2 && runtime.releases.length === 2);
      expect(new Set(runtime.contents)).toEqual(new Set(['first write', 'second write']));
      expect(persistence.getTeamExecutionIsolation(first.executionId)).toMatchObject({
        phase: 'running',
      });
      expect(persistence.getTeamExecutionIsolation(second.executionId)).toMatchObject({
        phase: 'running',
      });

      for (const release of runtime.releases.splice(0)) release();
      await waitFor(
        () =>
          persistence.getTeamExecution(first.executionId).state === 'completed' &&
          persistence.getTeamExecution(second.executionId).state === 'completed',
      );
      expect(spawnSync('git', ['-C', repo, 'status', '--porcelain']).stdout.toString().trim()).toBe(
        '',
      );
      expect(manager.integratedRepositories).toHaveLength(2);
      expect(new Set(manager.integratedRepositories.map((path) => path.toLowerCase())).size).toBe(
        1,
      );
      expect(manager.maxActiveIntegrations).toBe(1);
      persistence.close();
    });

    it('terminalizes and quarantines a deterministic worktree after a crash in preparing', async () => {
      const persistence = createPersistence();
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sprint-coder-team-prepare-repo-')));
      const worktreesRoot = mkdtempSync(join(tmpdir(), 'sprint-coder-team-prepare-worktrees-'));
      cleanup.push(repo, worktreesRoot);
      expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
      writeFileSync(join(repo, 'README.md'), 'base\n');
      expect(spawnSync('git', ['-C', repo, 'add', 'README.md']).status).toBe(0);
      expect(
        spawnSync('git', [
          '-C',
          repo,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '-q',
          '-m',
          'base',
        ]).status,
      ).toBe(0);
      const project = persistence.createProject({
        name: 'Preparing recovery',
        folders: [
          {
            id: '40000000-0000-4000-8000-000000000001',
            path: repo,
            canonicalPath: repo,
            label: 'repo',
            role: 'primary',
            workspaceKey: '9'.repeat(64),
            rootIdentityDigest: 'a'.repeat(64),
          },
        ],
      });
      const task = persistence.createTask('Preparing recovery Mission', false, project.id);
      const runtime = new MultiRootWritingRuntime();
      const crashing = new CrashAfterFirstWorktreeManager({ worktreesRoot });
      const coordinator = coordinatorWithWorktrees(persistence, runtime, crashing);
      const writer = await coordinator.hireWorker({
        taskId: task.id,
        role: 'writer',
        objective: 'resume the preparing worktree',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      const mission = await coordinator.assignMission({
        taskId: task.id,
        objective: 'recover preparation',
        doneCriteria: ['worktree recovered'],
        steps: [
          {
            workerId: writer.id,
            objective: 'write after recovery',
            doneCriteria: ['output exists'],
            access: 'workspace-write',
          },
          {
            workerId: writer.id,
            objective: 'verify after recovery',
            doneCriteria: ['output verified'],
            access: 'read-only',
          },
        ],
      });

      await waitFor(() => persistence.getTeamMission(mission.id).state === 'failed');
      const executionId = mission.steps[0]!.executionId;
      const preparing = persistence.getTeamExecutionIsolation(executionId);
      expect(preparing).toMatchObject({
        phase: 'quarantined',
        reason: 'simulated crash after first worktree creation',
      });
      expect(existsSync(preparing!.repositories[0]!.worktreePath)).toBe(true);
      expect(runtime.workspaceSets).toHaveLength(0);
      expect(persistence.getTeamExecution(executionId).state).toBe('failed');
      const dispatch = persistence.getTeamExecutionDispatch(executionId);
      expect(persistence.getTeamTask(dispatch.teamTaskId).status).toBe('failed');
      expect(persistence.getTeamDelivery(dispatch.messageId)).toMatchObject({
        state: 'failed',
        lastError: 'simulated crash after first worktree creation',
      });
      persistence.close();
    });

    it('maps two repositories into isolated roots and integrates Secondary before Primary', async () => {
      const persistence = createPersistence();
      const primaryRepo = realpathSync(mkdtempSync(join(tmpdir(), 'sprint-coder-team-primary-')));
      const secondaryRepo = realpathSync(
        mkdtempSync(join(tmpdir(), 'sprint-coder-team-secondary-')),
      );
      const worktreesRoot = mkdtempSync(join(tmpdir(), 'sprint-coder-team-multi-worktrees-'));
      cleanup.push(primaryRepo, secondaryRepo, worktreesRoot);
      for (const [repo, label] of [
        [primaryRepo, 'primary'],
        [secondaryRepo, 'secondary'],
      ] as const) {
        expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
        writeFileSync(join(repo, 'README.md'), `${label}\n`);
        expect(spawnSync('git', ['-C', repo, 'add', 'README.md']).status).toBe(0);
        expect(
          spawnSync('git', [
            '-C',
            repo,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '-q',
            '-m',
            'base',
          ]).status,
        ).toBe(0);
      }
      const primaryRootId = '10000000-0000-4000-8000-000000000001';
      const secondaryRootId = '10000000-0000-4000-8000-000000000002';
      const project = persistence.createProject({
        name: 'Two repositories',
        folders: [
          {
            id: primaryRootId,
            path: primaryRepo,
            canonicalPath: primaryRepo,
            label: 'primary',
            role: 'primary',
            workspaceKey: '1'.repeat(64),
            rootIdentityDigest: 'a'.repeat(64),
          },
          {
            id: secondaryRootId,
            path: secondaryRepo,
            canonicalPath: secondaryRepo,
            label: 'secondary',
            role: 'secondary',
            workspaceKey: '2'.repeat(64),
            rootIdentityDigest: 'b'.repeat(64),
          },
        ],
      });
      const task = persistence.createTask('Multi-repository Mission', false, project.id);
      const runtime = new MultiRootWritingRuntime();
      const manager = new WorkerWorktreeManager({ worktreesRoot });
      const integrate = vi.spyOn(manager, 'integrate');
      const coordinator = coordinatorWithWorktrees(persistence, runtime, manager);
      const writer = await coordinator.hireWorker({
        taskId: task.id,
        role: 'writer',
        objective: 'write both repositories',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      const reader = await coordinator.hireWorker({
        taskId: task.id,
        role: 'reader',
        objective: 'verify both repositories',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });
      const mission = await coordinator.assignMission({
        taskId: task.id,
        objective: 'write then verify both repositories',
        doneCriteria: ['both repositories integrated'],
        steps: [
          {
            workerId: writer.id,
            objective: 'write both roots',
            doneCriteria: ['both outputs exist'],
            access: 'workspace-write',
          },
          {
            workerId: reader.id,
            objective: 'verify both roots',
            doneCriteria: ['both outputs inspected'],
            access: 'read-only',
          },
        ],
      });

      await waitFor(
        () =>
          ['completed', 'waiting_resume', 'failed', 'canceled'].includes(
            persistence.getTeamMission(mission.id).state,
          ),
        20_000,
      );
      const executionId = mission.steps[0]!.executionId;
      const isolation = persistence.getTeamExecutionIsolation(executionId);
      const finalState = {
        mission: persistence.getTeamMission(mission.id),
        execution: persistence.getTeamExecution(executionId),
        attempts: persistence.listTeamAttempts(executionId),
        isolation,
      };
      expect(finalState.mission.state, JSON.stringify(finalState, null, 2)).toBe('completed');
      expect(runtime.workspaceSets).toHaveLength(1);
      expect(runtime.workspaceSets[0]).toMatchObject({
        primaryRootId,
        roots: [
          { rootId: primaryRootId, role: 'primary' },
          { rootId: secondaryRootId, role: 'secondary' },
        ],
      });
      expect(runtime.workspaceSets[0]!.roots.map(({ path }) => path)).not.toContain(primaryRepo);
      expect(runtime.workspaceSets[0]!.roots.map(({ path }) => path)).not.toContain(secondaryRepo);
      expect(runtime.allWorkspaceSets[1]?.roots.map(({ path }) => path)).toEqual([
        primaryRepo,
        secondaryRepo,
      ]);
      expect(readFileSync(join(primaryRepo, 'worker-output.txt'), 'utf8')).toBe('primary\n');
      expect(readFileSync(join(secondaryRepo, 'worker-output.txt'), 'utf8')).toBe('secondary\n');
      expect(integrate.mock.calls.map(([input]) => basename(input.repoPath))).toEqual([
        basename(secondaryRepo),
        basename(primaryRepo),
      ]);
      expect(isolation).toMatchObject({
        phase: 'completed',
        resumeKind: null,
        repositories: [{ state: 'cleaned' }, { state: 'cleaned' }],
        roots: [
          { rootId: primaryRootId, repositoryOrdinal: expect.any(Number) },
          { rootId: secondaryRootId, repositoryOrdinal: expect.any(Number) },
        ],
      });
      for (const repo of [primaryRepo, secondaryRepo]) {
        expect(
          spawnSync('git', ['-C', repo, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' })
            .stdout,
        ).toBe('2\n');
        expect(
          spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).stdout,
        ).toBe('');
      }
      persistence.close();
    });

    it('resumes only remaining repository integrations without rerunning the Worker', async () => {
      const databaseDirectory = mkdtempSync(join(tmpdir(), 'sprint-coder-team-resume-db-'));
      const databasePath = join(databaseDirectory, 'test.sqlite3');
      cleanup.push(databaseDirectory);
      let persistence = new SqlitePersistenceClient(databasePath);
      const primaryRepo = realpathSync(
        mkdtempSync(join(tmpdir(), 'sprint-coder-team-resume-primary-')),
      );
      const secondaryRepo = realpathSync(
        mkdtempSync(join(tmpdir(), 'sprint-coder-team-resume-secondary-')),
      );
      const worktreesRoot = mkdtempSync(join(tmpdir(), 'sprint-coder-team-resume-worktrees-'));
      cleanup.push(primaryRepo, secondaryRepo, worktreesRoot);
      for (const [repo, label] of [
        [primaryRepo, 'primary'],
        [secondaryRepo, 'secondary'],
      ] as const) {
        expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
        writeFileSync(join(repo, 'README.md'), `${label}\n`);
        expect(spawnSync('git', ['-C', repo, 'add', 'README.md']).status).toBe(0);
        expect(
          spawnSync('git', [
            '-C',
            repo,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '-q',
            '-m',
            'base',
          ]).status,
        ).toBe(0);
      }
      const project = persistence.createProject({
        name: 'Resumable repositories',
        folders: [
          {
            id: '30000000-0000-4000-8000-000000000001',
            path: primaryRepo,
            canonicalPath: primaryRepo,
            label: 'primary',
            role: 'primary',
            workspaceKey: '7'.repeat(64),
            rootIdentityDigest: 'e'.repeat(64),
          },
          {
            id: '30000000-0000-4000-8000-000000000002',
            path: secondaryRepo,
            canonicalPath: secondaryRepo,
            label: 'secondary',
            role: 'secondary',
            workspaceKey: '8'.repeat(64),
            rootIdentityDigest: 'f'.repeat(64),
          },
        ],
      });
      const task = persistence.createTask('Resumable multi-repository Mission', false, project.id);
      const runtime = new MultiRootWritingRuntime();
      const manager = new FailRepositoryOnceManager({ worktreesRoot }, 2);
      const integrate = vi.spyOn(manager, 'integrate');
      const coordinator = coordinatorWithWorktrees(persistence, runtime, manager);
      const writer = await coordinator.hireWorker({
        taskId: task.id,
        role: 'writer',
        objective: 'write both repositories once',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      const reader = await coordinator.hireWorker({
        taskId: task.id,
        role: 'reader',
        objective: 'verify integrated repositories',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });
      const mission = await coordinator.assignMission({
        taskId: task.id,
        objective: 'resume a partial integration',
        doneCriteria: ['both repositories integrated'],
        steps: [
          {
            workerId: writer.id,
            objective: 'write both roots',
            doneCriteria: ['both outputs exist'],
            access: 'workspace-write',
          },
          {
            workerId: reader.id,
            objective: 'verify both roots',
            doneCriteria: ['both outputs inspected'],
            access: 'read-only',
          },
        ],
      });

      await waitFor(
        () => persistence.getTeamMission(mission.id).state === 'waiting_resume',
        20_000,
      );
      const executionId = mission.steps[0]!.executionId;
      const partialIsolation = persistence.getTeamExecutionIsolation(executionId);
      expect(partialIsolation).toMatchObject({
        phase: 'waiting_resume',
        resumeKind: 'integration',
        repositories: [{ state: 'ready' }, { state: 'integrated' }],
        reason: 'simulated primary integration conflict',
      });
      expect(persistence.getTeamExecutionIsolationCompletion(executionId)).not.toBeNull();
      expect(runtime.workspaceSets).toHaveLength(1);
      expect(persistence.listTeamAttempts(executionId)).toHaveLength(1);
      expect(
        spawnSync('git', ['-C', primaryRepo, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' })
          .stdout,
      ).toBe('1\n');
      expect(
        spawnSync('git', ['-C', secondaryRepo, 'rev-list', '--count', 'HEAD'], {
          encoding: 'utf8',
        }).stdout,
      ).toBe('2\n');
      expect(integrate.mock.calls.map(([input]) => basename(input.repoPath))).toEqual([
        basename(secondaryRepo),
        basename(primaryRepo),
      ]);

      persistence.close();
      persistence = new SqlitePersistenceClient(databasePath);
      persistence.initializeMutationRecovery('resumed-instance', '2026-08-02T00:10:00.000Z');
      const resumedManager = new WorkerWorktreeManager({ worktreesRoot });
      const resumedIntegrate = vi.spyOn(resumedManager, 'integrate');
      const resumedRevalidate = vi.spyOn(resumedManager, 'revalidateIntegration');
      const resumedCoordinator = coordinatorWithWorktrees(persistence, runtime, resumedManager);
      persistence.recoverTeamsOnStartup('2026-08-02T00:10:01.000Z');
      writeFileSync(join(secondaryRepo, 'outside.txt'), 'changed after partial integration\n');
      expect(spawnSync('git', ['-C', secondaryRepo, 'add', 'outside.txt']).status).toBe(0);
      expect(
        spawnSync('git', [
          '-C',
          secondaryRepo,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '-q',
          '-m',
          'external change',
        ]).status,
      ).toBe(0);
      await resumedCoordinator.resumeMission(task.id, mission.id);
      await waitFor(() => persistence.getTeamMission(mission.id).state === 'completed', 20_000);
      expect(readFileSync(join(secondaryRepo, 'outside.txt'), 'utf8')).toBe(
        'changed after partial integration\n',
      );
      expect(runtime.workspaceSets).toHaveLength(1);
      expect(persistence.listTeamAttempts(executionId)).toHaveLength(1);
      expect(persistence.getTeamExecutionIsolationCompletion(executionId)).toBeNull();
      expect(resumedIntegrate.mock.calls.map(([input]) => basename(input.repoPath))).toEqual([
        basename(primaryRepo),
      ]);
      expect(resumedRevalidate.mock.calls.map(([input]) => basename(input.repoPath))).toEqual([
        basename(secondaryRepo),
      ]);
      expect(persistence.getTeamExecutionIsolation(executionId)).toMatchObject({
        phase: 'completed',
        resumeKind: null,
        repositories: [{ state: 'cleaned' }, { state: 'cleaned' }],
      });
      expect(
        spawnSync('git', ['-C', primaryRepo, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' })
          .stdout,
      ).toBe('2\n');
      expect(
        spawnSync('git', ['-C', secondaryRepo, 'rev-list', '--count', 'HEAD'], {
          encoding: 'utf8',
        }).stdout,
      ).toBe('3\n');
      persistence.close();
    });

    it('makes a failed multi-repository Worker terminal instead of offering a broken resume', async () => {
      const persistence = createPersistence();
      const primaryRepo = realpathSync(mkdtempSync(join(tmpdir(), 'sprint-coder-team-primary-')));
      const secondaryRepo = realpathSync(
        mkdtempSync(join(tmpdir(), 'sprint-coder-team-secondary-')),
      );
      const worktreesRoot = mkdtempSync(join(tmpdir(), 'sprint-coder-team-worktrees-'));
      cleanup.push(primaryRepo, secondaryRepo, worktreesRoot);
      for (const repo of [primaryRepo, secondaryRepo]) {
        expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
        writeFileSync(join(repo, 'README.md'), 'base\n');
        expect(spawnSync('git', ['-C', repo, 'add', 'README.md']).status).toBe(0);
        expect(
          spawnSync('git', [
            '-C',
            repo,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '-q',
            '-m',
            'base',
          ]).status,
        ).toBe(0);
      }
      const project = persistence.createProject({
        name: 'Failed multi-repository execution',
        folders: [
          {
            id: '32000000-0000-4000-8000-000000000001',
            path: primaryRepo,
            canonicalPath: primaryRepo,
            label: 'primary',
            role: 'primary',
            workspaceKey: '3'.repeat(64),
            rootIdentityDigest: '4'.repeat(64),
          },
          {
            id: '32000000-0000-4000-8000-000000000002',
            path: secondaryRepo,
            canonicalPath: secondaryRepo,
            label: 'secondary',
            role: 'secondary',
            workspaceKey: '5'.repeat(64),
            rootIdentityDigest: '6'.repeat(64),
          },
        ],
      });
      const task = persistence.createTask('Failed multi-repository Task', false, project.id);
      const runtime = new MultiRootWritingRuntime();
      runtime.completionStatus = 'failed';
      const coordinator = coordinatorWithWorktrees(
        persistence,
        runtime,
        new WorkerWorktreeManager({ worktreesRoot }),
      );
      const writer = await coordinator.hireWorker({
        taskId: task.id,
        role: 'writer',
        objective: 'report a failed repository write',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      const submission = await coordinator.assignTask({
        taskId: task.id,
        targetAgentId: writer.id,
        content: 'attempt both repository writes',
        doneCriteria: ['result succeeds'],
        accessMode: 'workspace-write',
      });

      await waitFor(
        () => persistence.getTeamExecution(submission.executionId).state === 'failed',
        15_000,
      );
      expect(persistence.getTeamExecutionIsolation(submission.executionId)).toMatchObject({
        phase: 'quarantined',
        resumeKind: null,
        repositories: [{ state: 'quarantined' }, { state: 'quarantined' }],
      });
      expect(persistence.getTeamExecutionIsolationCompletion(submission.executionId)).toBeNull();
      expect(persistence.listTeamAttempts(submission.executionId)).toMatchObject([
        { state: 'failed', terminalReason: 'worker_reported_failure' },
      ]);
      await expect(
        coordinator.resumeExecutionIntegration(task.id, submission.executionId),
      ).rejects.toThrow('Team execution is not waiting to resume');
      expect(existsSync(join(primaryRepo, 'worker-output.txt'))).toBe(false);
      expect(existsSync(join(secondaryRepo, 'worker-output.txt'))).toBe(false);
      persistence.close();
    }, 30_000);

    it('revalidates a no-change repository before resuming partial integration', async () => {
      const persistence = createPersistence();
      const primaryRepo = realpathSync(mkdtempSync(join(tmpdir(), 'sprint-coder-team-primary-')));
      const secondaryRepo = realpathSync(
        mkdtempSync(join(tmpdir(), 'sprint-coder-team-secondary-')),
      );
      const worktreesRoot = mkdtempSync(join(tmpdir(), 'sprint-coder-team-worktrees-'));
      cleanup.push(primaryRepo, secondaryRepo, worktreesRoot);
      for (const repo of [primaryRepo, secondaryRepo]) {
        expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
        writeFileSync(join(repo, 'README.md'), 'base\n');
        expect(spawnSync('git', ['-C', repo, 'add', 'README.md']).status).toBe(0);
        expect(
          spawnSync('git', [
            '-C',
            repo,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '-q',
            '-m',
            'base',
          ]).status,
        ).toBe(0);
      }
      const project = persistence.createProject({
        name: 'No-change repository resume',
        folders: [
          {
            id: '31000000-0000-4000-8000-000000000001',
            path: primaryRepo,
            canonicalPath: primaryRepo,
            label: 'primary',
            role: 'primary',
            workspaceKey: '9'.repeat(64),
            rootIdentityDigest: '1'.repeat(64),
          },
          {
            id: '31000000-0000-4000-8000-000000000002',
            path: secondaryRepo,
            canonicalPath: secondaryRepo,
            label: 'secondary',
            role: 'secondary',
            workspaceKey: 'a'.repeat(64),
            rootIdentityDigest: '2'.repeat(64),
          },
        ],
      });
      const task = persistence.createTask('No-change repository Mission', false, project.id);
      const runtime = new PrimaryRootWritingRuntime();
      const manager = new FailRepositoryOnceManager({ worktreesRoot }, 2);
      const coordinator = coordinatorWithWorktrees(persistence, runtime, manager);
      const writer = await coordinator.hireWorker({
        taskId: task.id,
        role: 'writer',
        objective: 'write only Primary',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      const reader = await coordinator.hireWorker({
        taskId: task.id,
        role: 'reader',
        objective: 'verify the integrated repositories',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });
      const mission = await coordinator.assignMission({
        taskId: task.id,
        objective: 'resume while Secondary has no Worker changes',
        doneCriteria: ['Primary integrated'],
        steps: [
          {
            workerId: writer.id,
            objective: 'write Primary',
            doneCriteria: ['Primary output exists'],
            access: 'workspace-write',
          },
          {
            workerId: reader.id,
            objective: 'verify both repositories',
            doneCriteria: ['both repositories inspected'],
            access: 'read-only',
          },
        ],
      });

      await waitFor(
        () => persistence.getTeamMission(mission.id).state === 'waiting_resume',
        20_000,
      );
      const executionId = mission.steps[0]!.executionId;
      expect(persistence.getTeamExecutionIsolation(executionId)).toMatchObject({
        phase: 'waiting_resume',
        repositories: [{ state: 'ready' }, { state: 'integrated', workerHead: expect.any(String) }],
      });
      expect(runtime.workspaceSets).toHaveLength(1);
      expect(persistence.listTeamAttempts(executionId)).toHaveLength(1);

      writeFileSync(join(secondaryRepo, 'outside.txt'), 'unsealed after partial integration\n');
      await expect(coordinator.resumeMission(task.id, mission.id)).rejects.toThrow(
        'Workspace has changes outside the isolated Worker worktree',
      );
      expect(persistence.getTeamMission(mission.id).state).toBe('waiting_resume');
      expect(runtime.workspaceSets).toHaveLength(1);
      expect(persistence.listTeamAttempts(executionId)).toHaveLength(1);
      expect(existsSync(join(primaryRepo, 'worker-output.txt'))).toBe(false);
      persistence.close();
    }, 30_000);

    it('maps sibling Project folders in one repository into one isolated worktree', async () => {
      const persistence = createPersistence();
      const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sprint-coder-team-shared-repo-')));
      const worktreesRoot = mkdtempSync(join(tmpdir(), 'sprint-coder-team-shared-worktrees-'));
      cleanup.push(repo, worktreesRoot);
      const firstRoot = join(repo, 'test1');
      const secondRoot = join(repo, 'test2');
      mkdirSync(firstRoot);
      mkdirSync(secondRoot);
      expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
      writeFileSync(join(firstRoot, 'README.md'), 'one\n');
      writeFileSync(join(secondRoot, 'README.md'), 'two\n');
      expect(spawnSync('git', ['-C', repo, 'add', '.']).status).toBe(0);
      expect(
        spawnSync('git', [
          '-C',
          repo,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '-q',
          '-m',
          'base',
        ]).status,
      ).toBe(0);
      const project = persistence.createProject({
        name: 'Sibling folders',
        folders: [
          {
            id: '20000000-0000-4000-8000-000000000001',
            path: firstRoot,
            canonicalPath: firstRoot,
            label: 'test1',
            role: 'primary',
            workspaceKey: '5'.repeat(64),
            rootIdentityDigest: 'c'.repeat(64),
          },
          {
            id: '20000000-0000-4000-8000-000000000002',
            path: secondRoot,
            canonicalPath: secondRoot,
            label: 'test2',
            role: 'secondary',
            workspaceKey: '6'.repeat(64),
            rootIdentityDigest: 'd'.repeat(64),
          },
        ],
      });
      const task = persistence.createTask('Shared repository Mission', false, project.id);
      const runtime = new MultiRootWritingRuntime();
      const manager = new WorkerWorktreeManager({ worktreesRoot });
      const integrate = vi.spyOn(manager, 'integrate');
      const coordinator = coordinatorWithWorktrees(persistence, runtime, manager);
      const writer = await coordinator.hireWorker({
        taskId: task.id,
        role: 'writer',
        objective: 'write both folders',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      const reader = await coordinator.hireWorker({
        taskId: task.id,
        role: 'reader',
        objective: 'verify both folders',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });
      const mission = await coordinator.assignMission({
        taskId: task.id,
        objective: 'write then verify sibling folders',
        doneCriteria: ['both folders integrated'],
        steps: [
          {
            workerId: writer.id,
            objective: 'write both folders',
            doneCriteria: ['both outputs exist'],
            access: 'workspace-write',
          },
          {
            workerId: reader.id,
            objective: 'verify both folders',
            doneCriteria: ['both outputs inspected'],
            access: 'read-only',
          },
        ],
      });

      await waitFor(() => persistence.getTeamMission(mission.id).state === 'completed', 20_000);
      const isolation = persistence.getTeamExecutionIsolation(mission.steps[0]!.executionId);
      expect(isolation?.repositories).toHaveLength(1);
      expect(isolation?.roots.map(({ repositoryOrdinal }) => repositoryOrdinal)).toEqual([1, 1]);
      expect(runtime.workspaceSets[0]?.roots.map(({ path }) => path)).toEqual([
        expect.stringContaining(`${sep}test1`),
        expect.stringContaining(`${sep}test2`),
      ]);
      expect(integrate).toHaveBeenCalledTimes(1);
      expect(readFileSync(join(firstRoot, 'worker-output.txt'), 'utf8')).toBe('test1\n');
      expect(readFileSync(join(secondRoot, 'worker-output.txt'), 'utf8')).toBe('test2\n');
      persistence.close();
    });

    it('quarantines a failed write result and integrates it only after manual resume', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Failed writable Mission');
      const runtime = new WorktreeWritingRuntime();
      runtime.completionStatus = 'failed';
      const { workspace, manager } = configureGitWorkspace(persistence, task.id);
      const coordinator = coordinatorWithWorktrees(persistence, runtime, manager);
      const writer = await coordinator.hireWorker({
        taskId: task.id,
        role: 'writer',
        objective: 'preserve failed partial work',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      const mission = await coordinator.assignMission({
        taskId: task.id,
        objective: 'write safely',
        doneCriteria: ['output integrated after successful resume'],
        steps: [
          {
            workerId: writer.id,
            objective: 'perform isolated write',
            doneCriteria: ['worker-output.txt exists'],
            access: 'workspace-write',
          },
          {
            workerId: writer.id,
            objective: 'verify integrated write',
            doneCriteria: ['worker-output.txt is integrated'],
            access: 'read-only',
          },
        ],
      });

      await waitFor(() => persistence.getTeamMission(mission.id).state === 'waiting_resume');

      const executionId = mission.steps[0]!.executionId;
      const quarantined = persistence.getTeamMissionWorktree(executionId);
      expect(persistence.getTeamExecution(executionId).state).toBe('waiting_resume');
      expect(persistence.listTeamAttempts(executionId)).toMatchObject([
        {
          ordinal: 1,
          state: 'failed',
          terminalReason: 'worker_reported_failure',
        },
      ]);
      expect(quarantined).toMatchObject({
        state: 'quarantined',
        changedFiles: ['worker-output.txt'],
        reason: expect.stringContaining('Worker reported failure before integration'),
      });
      expect(readFileSync(join(quarantined!.path, 'worker-output.txt'), 'utf8')).toBe('isolated\n');
      expect(existsSync(join(workspace, 'worker-output.txt'))).toBe(false);
      expect(
        spawnSync('git', ['-C', workspace, 'log', '-1', '--pretty=%s'], {
          encoding: 'utf8',
        }).stdout,
      ).toBe('base\n');

      runtime.completionStatus = 'succeeded';
      await coordinator.resumeMission(task.id, mission.id);
      await waitFor(() => persistence.getTeamMission(mission.id).state === 'completed', 5_000);

      expect(readFileSync(join(workspace, 'worker-output.txt'), 'utf8')).toBe('isolated\n');
      expect(persistence.listTeamAttempts(executionId)).toMatchObject([
        { ordinal: 1, state: 'failed', terminalReason: 'worker_reported_failure' },
        { ordinal: 2, state: 'completed', startReason: 'manual_resume' },
      ]);
      expect(persistence.getTeamMissionWorktree(executionId)).toMatchObject({
        state: 'cleaned',
        changedFiles: ['worker-output.txt'],
      });
      expect(
        spawnSync('git', ['-C', workspace, 'rev-list', '--count', 'HEAD'], {
          encoding: 'utf8',
        }).stdout.trim(),
      ).toBe('2');
      persistence.close();
    });

    it('preserves both sides and waits for resume when the primary workspace changes', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Conflicting writable Mission');
      const { workspace, manager } = configureGitWorkspace(persistence, task.id);
      const runtime = new ConflictingWorktreeRuntime(workspace);
      const coordinator = coordinatorWithWorktrees(persistence, runtime, manager);
      const writer = await coordinator.hireWorker({
        taskId: task.id,
        role: 'writer',
        objective: 'write in isolation',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      const mission = await coordinator.assignMission({
        taskId: task.id,
        objective: 'conflict safely',
        doneCriteria: ['no changes are lost'],
        steps: [
          {
            workerId: writer.id,
            objective: 'write while outside changes',
            doneCriteria: ['worker result preserved'],
            access: 'workspace-write',
          },
          {
            workerId: writer.id,
            objective: 'verify after resume',
            doneCriteria: ['conflict resolved'],
            access: 'read-only',
          },
        ],
      });

      await waitFor(() => persistence.getTeamMission(mission.id).state === 'waiting_resume');

      const worktree = persistence.getTeamMissionWorktree(mission.steps[0]!.executionId);
      expect(readFileSync(join(workspace, 'outside.txt'), 'utf8')).toBe('external change\n');
      expect(worktree).toMatchObject({
        state: 'quarantined',
        changedFiles: ['worker-only.txt'],
        reason: expect.stringContaining('Workspace has changes'),
      });
      expect(readFileSync(join(worktree!.path, 'worker-only.txt'), 'utf8')).toBe(
        'preserve worker result\n',
      );
      expect(
        spawnSync('git', ['-C', workspace, 'log', '-1', '--pretty=%s'], {
          encoding: 'utf8',
        }).stdout,
      ).toBe('base\n');
      persistence.close();
    });

    it('resumes idempotently when the app stops after Git integration but before checkpointing', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Crash-safe writable Mission');
      const { workspace, worktreesRoot, manager } = configureGitWorkspace(persistence, task.id);
      const firstRuntime = new WorktreeWritingRuntime();
      const crashingManager = new CrashAfterIntegrationManager({ worktreesRoot });
      const firstCoordinator = coordinatorWithWorktrees(persistence, firstRuntime, crashingManager);
      const writer = await firstCoordinator.hireWorker({
        taskId: task.id,
        role: 'writer',
        objective: 'write in isolation',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      const reader = await firstCoordinator.hireWorker({
        taskId: task.id,
        role: 'reviewer',
        objective: 'verify integrated output',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });
      const mission = await firstCoordinator.assignMission({
        taskId: task.id,
        objective: 'survive integration crash',
        doneCriteria: ['exactly one integrated change'],
        steps: [
          {
            workerId: writer.id,
            objective: 'perform isolated write',
            doneCriteria: ['worker-output.txt exists'],
            access: 'workspace-write',
          },
          {
            workerId: reader.id,
            objective: 'verify integrated output',
            doneCriteria: ['integrated output inspected'],
            access: 'read-only',
          },
        ],
      });
      await waitFor(() => persistence.getTeamMission(mission.id).state === 'waiting_resume');
      expect(readFileSync(join(workspace, 'worker-output.txt'), 'utf8')).toBe('isolated\n');
      expect(persistence.getTeamMissionWorktree(mission.steps[0]!.executionId)).toMatchObject({
        state: 'quarantined',
        integratedHead: null,
        reason: 'simulated app crash after Git integration',
      });

      const resumedRuntime = new WorktreeWritingRuntime();
      const resumedCoordinator = coordinatorWithWorktrees(persistence, resumedRuntime, manager);
      resumedCoordinator.recoverOnStartup();
      await resumedCoordinator.resumeMission(task.id, mission.id);
      await waitFor(() => persistence.getTeamMission(mission.id).state === 'completed', 5_000);

      expect(
        spawnSync('git', ['-C', workspace, 'rev-list', '--count', 'HEAD'], {
          encoding: 'utf8',
        }).stdout.trim(),
      ).toBe('2');
      expect(
        persistence
          .listTeamAttempts(mission.steps[0]!.executionId)
          .map(({ startReason, state }) => ({
            startReason,
            state,
          })),
      ).toEqual([
        { startReason: 'initial', state: 'failed' },
        { startReason: 'manual_resume', state: 'completed' },
      ]);
      expect(persistence.checkTeamIntegrity()).toEqual({ sqlite: 'ok', inconsistencies: [] });
      persistence.close();
    });

    it('keeps a failed write step for manual resume and creates a fresh manual Attempt', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Writable Mission resume');
      const runtime = new FailOnceWorkerRuntime();
      const { manager } = configureGitWorkspace(persistence, task.id);
      const coordinator = coordinatorWithWorktrees(persistence, runtime, manager);
      const worker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'writer',
        objective: 'implement safely',
        contextInheritancePolicy: 'none',
        writeCapable: true,
      });
      const mission = await coordinator.assignMission({
        taskId: task.id,
        objective: 'write then verify',
        doneCriteria: ['mission complete'],
        steps: [
          {
            workerId: worker.id,
            objective: 'make one bounded write',
            doneCriteria: ['write verified'],
            access: 'workspace-write',
          },
          {
            workerId: worker.id,
            objective: 'verify without writing',
            doneCriteria: ['verification reported'],
            access: 'read-only',
          },
        ],
      });

      await waitFor(() => persistence.getTeamMission(mission.id).state === 'waiting_resume');
      const firstExecutionId = mission.steps[0]!.executionId;
      expect(runtime.executeCount).toBe(1);
      expect(persistence.getTeamExecution(firstExecutionId).state).toBe('waiting_resume');
      expect(persistence.listTeamAttempts(firstExecutionId)).toMatchObject([
        { ordinal: 1, state: 'failed', startReason: 'initial' },
      ]);

      await coordinator.resumeMission(task.id, mission.id);
      await waitFor(() => persistence.getTeamMission(mission.id).state === 'completed');
      expect(runtime.executeCount).toBe(3);
      expect(runtime.contents[1]).toContain('前回の部分変更を最初に検査');
      expect(persistence.listTeamAttempts(firstExecutionId)).toMatchObject([
        { ordinal: 1, state: 'failed', startReason: 'initial' },
        { ordinal: 2, state: 'completed', startReason: 'manual_resume' },
      ]);
      expect(persistence.checkTeamIntegrity()).toEqual({
        sqlite: 'ok',
        inconsistencies: [],
      });
      persistence.close();
    });

    it('pauses the next Mission step when the workspace changed after its checkpoint', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Mission fingerprint recovery');
      const workspace = mkdtempSync(join(tmpdir(), 'sprint-coder-mission-recovery-'));
      cleanup.push(workspace);
      writeFileSync(join(workspace, 'tracked.txt'), 'checkpoint\n');
      expect(spawnSync('git', ['-C', workspace, 'init']).status).toBe(0);
      expect(spawnSync('git', ['-C', workspace, 'add', '.']).status).toBe(0);
      expect(
        spawnSync('git', [
          '-C',
          workspace,
          '-c',
          'user.name=Sprint Coder Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '-m',
          'checkpoint',
        ]).status,
      ).toBe(0);
      persistence.setWorkspace(task.id, workspace);
      const coordinator = new TeamCoordinator(persistence, new TestWorkerRuntime());
      const worker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'recovery worker',
        objective: 'resume safely',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });
      const team = persistence.getTeamByTask(task.id)!;
      const leader = persistence.getTaskLeader(task.id);
      const mission = persistence.createTeamMission({
        teamId: team.id,
        createdByAgentId: leader.id,
        objective: 'checkpoint recovery',
        doneCriteria: ['both steps complete'],
        steps: [
          {
            workerId: worker.id,
            objective: 'first',
            doneCriteria: ['first done'],
            access: 'read-only',
          },
          {
            workerId: worker.id,
            objective: 'second',
            doneCriteria: ['second done'],
            access: 'read-only',
          },
        ],
        now: new Date().toISOString(),
      });
      persistence.transitionTeamMission(mission.id, 'running', new Date().toISOString());
      const first = mission.steps[0]!;
      persistence.transitionTeamExecution({
        executionId: first.executionId,
        to: 'queued',
        now: new Date().toISOString(),
        queueReason: 'global_concurrency',
      });
      persistence.transitionTeamExecution({
        executionId: first.executionId,
        to: 'running',
        now: new Date().toISOString(),
      });
      const dispatch = persistence.getTeamExecutionDispatch(first.executionId);
      persistence.transitionTeamTask(dispatch.teamTaskId, 'running', new Date().toISOString());
      const attempt = persistence.createTeamAttempt(first.executionId, new Date().toISOString());
      persistence.transitionTeamAttempt({
        attemptId: attempt.id,
        to: 'running',
        now: new Date().toISOString(),
      });
      const fingerprint = captureGitWorkspaceFingerprint(workspace);
      persistence.completeTeamMissionStep({
        executionId: first.executionId,
        attemptId: attempt.id,
        teamTaskId: dispatch.teamTaskId,
        agentId: worker.id,
        report: {
          status: 'completed',
          summary: 'first complete',
          findings: [],
          changedFiles: [],
          artifacts: [],
          verification: [{ name: 'test', outcome: 'pass' }],
          risks: [],
          nextActions: [],
          doneEvidence: [{ criterion: 'first done', evidence: 'verified' }],
        },
        doneEvidence: [{ criterion: 'first done', evidence: 'verified' }],
        checkpoint: {
          summary: 'first complete',
          changedFiles: [],
          ...fingerprint,
          recordedAt: new Date().toISOString(),
        },
        now: new Date().toISOString(),
      });

      writeFileSync(join(workspace, 'tracked.txt'), 'externally changed\n');
      new TeamCoordinator(persistence, new TestWorkerRuntime()).recoverOnStartup();
      const secondExecutionId = mission.steps[1]!.executionId;
      expect(persistence.getTeamExecution(secondExecutionId).state).toBe('waiting_resume');
      expect(persistence.getTeamMission(mission.id).state).toBe('waiting_resume');
      expect(persistence.listTeamAttempts(secondExecutionId)).toHaveLength(0);
      persistence.close();
    });
    it('updates Team Policy with optimistic revision and publishes canonical detail', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Team Policy');
      const team = persistence.promoteTaskToTeam(task.id);
      const published: ReturnType<TeamCoordinator['get']>[] = [];
      const coordinator = new TeamCoordinator(
        persistence,
        new TestWorkerRuntime(),
        (_taskId, detail) => {
          published.push(detail);
        },
      );
      const policy = {
        ...team.policy,
        maxAgentDepth: 3,
        maxConcurrentExecutions: 5,
        allowWorkerDirectMessages: false,
        budgetMode: 'unlimited' as const,
      };

      const detail = await coordinator.updatePolicy({
        taskId: task.id,
        policy,
        expectedRevision: team.revision,
      });

      expect(detail.team).toMatchObject({ policy, revision: team.revision + 1 });
      expect(published.at(-1)?.team).toMatchObject({
        id: team.id,
        policy,
        revision: team.revision + 1,
      });
      await expect(
        coordinator.updatePolicy({
          taskId: task.id,
          policy: team.policy,
          expectedRevision: team.revision,
        }),
      ).rejects.toBeInstanceOf(TeamConflictError);
      persistence.close();
    });

    it('pins a Team Skill Blueprint and enforces role, hierarchy, and required roles', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Blueprint Team');
      const coordinator = new TeamCoordinator(
        persistence,
        new TestWorkerRuntime(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => ({
          selection: {
            kind: 'team',
            ref: {
              source: 'created',
              skillId: 'company-team',
              digest: 'a'.repeat(64),
            },
          },
          name: 'Company Team',
          packagePath: '/managed/revisions/company-team',
          blueprint: {
            version: 1,
            kind: 'team',
            policy: {
              maxAgentDepth: 4,
              maxConcurrentExecutions: 8,
              allowWorkerDirectMessages: true,
              budgetMode: 'bounded',
            },
            leaderInstructions: 'Managerを先に採用する',
            roles: [
              {
                key: 'engineering-manager',
                title: '開発部長',
                parentKey: 'leader',
                responsibility: '開発を統括する',
                scope: ['apps/'],
                nonGoals: [],
                doneCriteria: ['報告する'],
                required: true,
                canDelegate: true,
              },
              {
                key: 'implementer',
                title: '実装担当',
                parentKey: 'engineering-manager',
                responsibility: '実装する',
                scope: ['apps/'],
                nonGoals: [],
                doneCriteria: ['テストする'],
                required: true,
                canDelegate: false,
              },
            ],
          },
        }),
      );

      await expect(
        coordinator.hireWorker({
          taskId: task.id,
          role: '任意の役職',
          objective: '実装',
          contextInheritancePolicy: 'summary',
          writeCapable: false,
        }),
      ).rejects.toThrow('blueprintRoleKey');

      const manager = await coordinator.hireWorker(
        {
          taskId: task.id,
          role: '開発部長',
          objective: '統括',
          contextInheritancePolicy: 'summary',
          writeCapable: false,
          blueprintRoleKey: 'engineering-manager',
        },
        {
          maxDirectChildren: 3,
          maxDelegationLevels: 3,
          allowManagerChildren: false,
        },
      );
      expect(persistence.getTeamByTask(task.id)?.state).toBe('forming');

      const implementer = await coordinator.hireWorkerAs(
        {
          taskId: task.id,
          role: '実装担当',
          objective: '実装',
          contextInheritancePolicy: 'summary',
          writeCapable: true,
          blueprintRoleKey: 'implementer',
        },
        manager.id,
      );
      expect(persistence.getTeamByTask(task.id)?.state).toBe('active');
      expect(persistence.getTeamBlueprint(manager.teamId!)?.selection.ref.digest).toBe(
        'a'.repeat(64),
      );

      await coordinator.sendToWorker({
        taskId: task.id,
        targetAgentId: implementer.id,
        content: 'implement once',
      });
      await coordinator.sendToWorker({
        taskId: task.id,
        targetAgentId: manager.id,
        content: 'manage once',
      });
      expect(persistence.getTeamByTask(task.id)?.state).toBe('completed');

      const replacementManager = await coordinator.hireWorker(
        {
          taskId: task.id,
          role: '開発部長',
          objective: 'もう一度統括',
          contextInheritancePolicy: 'summary',
          writeCapable: false,
          blueprintRoleKey: 'engineering-manager',
        },
        {
          maxDirectChildren: 3,
          maxDelegationLevels: 3,
          allowManagerChildren: false,
        },
      );
      expect(persistence.getTeamByTask(task.id)?.state).toBe('forming');
      expect(replacementManager.state).toBe('ready');
      expect(coordinator.get(task.id)?.workers.find(({ id }) => id === manager.id)?.state).toBe(
        'stopped',
      );
      expect(coordinator.get(task.id)?.workers.find(({ id }) => id === implementer.id)?.state).toBe(
        'stopped',
      );
      const replacementImplementer = await coordinator.hireWorkerAs(
        {
          taskId: task.id,
          role: '実装担当',
          objective: 'もう一度実装',
          contextInheritancePolicy: 'summary',
          writeCapable: true,
          blueprintRoleKey: 'implementer',
        },
        replacementManager.id,
      );
      expect(replacementImplementer.state).toBe('ready');
      expect(persistence.getTeamByTask(task.id)?.state).toBe('active');
      persistence.close();
    });

    it('starts five Workers sequentially and returns each result to the Leader', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Team');
      const runtime = new TestWorkerRuntime();
      const events: number[] = [];
      const coordinator = new TeamCoordinator(persistence, runtime, (_taskId, detail) => {
        events.push(detail.workers.length);
      });

      const workers = await Promise.all(
        ['researcher', 'implementer', 'reviewer', 'verifier', 'documenter'].map((role) =>
          coordinator.hireWorker({
            taskId: task.id,
            role,
            objective: `${role} objective`,
            contextInheritancePolicy: 'summary',
            writeCapable: false,
          }),
        ),
      );
      expect(runtime.maxActiveStarts).toBe(1);
      expect(workers.map(({ state }) => state)).toEqual([
        'ready',
        'ready',
        'ready',
        'ready',
        'ready',
      ]);
      expect(workers.every(({ engine }) => engine === 'mock')).toBe(true);
      expect(
        persistence
          .getTeamBudgetStatus(workers[0]!.teamId)
          .find(({ scope, kind }) => scope === 'global' && kind === 'spawnSlots'),
      ).toMatchObject({ committed: 0, reserved: 0 });
      for (const worker of workers)
        await coordinator.sendToWorker({
          taskId: task.id,
          targetAgentId: worker.id,
          content: `request for ${worker.role}`,
        });

      const detail = coordinator.get(task.id);
      expect(detail?.team.state).toBe('completed');
      expect(
        detail?.workers.filter(({ kind }) => kind === 'worker').map(({ state }) => state),
      ).toEqual(['done', 'done', 'done', 'done', 'done']);
      expect(detail?.messages).toHaveLength(10);
      expect(
        detail?.messages.filter(
          ({ sourceKind, targetKind }) => sourceKind === 'worker' && targetKind === 'leader',
        ),
      ).toHaveLength(5);
      expect(events.length).toBeGreaterThanOrEqual(6);
      persistence.close();
    });

    it('allows an explicitly identified Manager to hire a child within persisted policy', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Manager delegation');
      const coordinator = new TeamCoordinator(persistence, new TestWorkerRuntime());
      const team = persistence.promoteTaskToTeam(task.id);

      const manager = await coordinator.hireWorkerAs(
        {
          taskId: task.id,
          role: '部長',
          objective: '実装部門を管理する',
          contextInheritancePolicy: 'summary',
          writeCapable: false,
        },
        team.leaderAgentId,
        {
          maxDirectChildren: 2,
          maxDelegationLevels: 2,
          allowManagerChildren: false,
        },
      );
      const child = await coordinator.hireWorkerAs(
        {
          taskId: task.id,
          role: '実装担当',
          objective: '機能を実装する',
          contextInheritancePolicy: 'selected_items',
          writeCapable: true,
        },
        manager.id,
      );
      const sibling = await coordinator.hireWorker({
        taskId: task.id,
        role: '別部門',
        objective: '別の作業をする',
        contextInheritancePolicy: 'summary',
        writeCapable: false,
      });

      expect(manager).toMatchObject({
        parentAgentId: team.leaderAgentId,
        depth: 1,
        canDelegate: true,
      });
      expect(child).toMatchObject({
        parentAgentId: manager.id,
        depth: 2,
        canDelegate: false,
      });
      await coordinator.sendAgentMessageAs(
        task.id,
        sibling.id,
        team.leaderAgentId,
        '別部門だけの非公開メッセージ',
      );
      const childView = coordinator.getForAgent(task.id, child.id);
      expect(childView?.workers.map(({ id }) => id)).toEqual(
        expect.arrayContaining([team.leaderAgentId, manager.id, child.id]),
      );
      expect(childView?.workers.map(({ id }) => id)).not.toContain(sibling.id);
      expect(childView?.messages).toEqual([]);
      expect(childView?.budgets).toEqual([]);
      expect(
        coordinator.getForAgent(task.id, manager.id)?.workers.map(({ id }) => id),
      ).not.toContain(sibling.id);
      await expect(
        coordinator.hireWorkerAs(
          {
            taskId: task.id,
            role: '偽Manager',
            objective: '許可なく再委譲する',
            contextInheritancePolicy: 'none',
            writeCapable: false,
          },
          child.id,
        ),
      ).rejects.toThrow('Only a Manager with canDelegate');
      const submission = await coordinator.assignTaskAs(
        {
          taskId: task.id,
          targetAgentId: child.id,
          content: 'Managerからの正式な依頼',
          doneCriteria: ['結果をManagerへ報告する'],
        },
        manager.id,
      );
      expect(persistence.getTeamExecution(submission.executionId)).toMatchObject({
        createdByAgentId: manager.id,
        assigneeAgentId: child.id,
      });
      await waitFor(
        () => persistence.getTeamExecution(submission.executionId).state === 'completed',
      );
      expect(coordinator.get(task.id)?.executions).toEqual([
        expect.objectContaining({
          id: submission.executionId,
          assigneeAgentId: child.id,
          createdByAgentId: manager.id,
          state: 'completed',
          instructionPreview: 'Managerからの正式な依頼',
          connectionId: null,
        }),
      ]);
      expect(coordinator.get(task.id)?.activities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'worker_hired',
            actorRole: '部長',
            subjectRole: '実装担当',
          }),
          expect.objectContaining({
            type: 'task_assigned',
            actorRole: '部長',
            subjectRole: '実装担当',
            executionId: submission.executionId,
          }),
          expect.objectContaining({
            type: 'execution_finished',
            subjectRole: '実装担当',
            status: 'completed',
          }),
        ]),
      );
      expect(coordinator.listWorkerReports(task.id, 0, manager.id)).toEqual([
        expect.objectContaining({
          sourceAgentId: child.id,
          targetAgentId: manager.id,
        }),
      ]);
      await coordinator.sendAgentMessageAs(
        task.id,
        child.id,
        manager.id,
        'これは通常連絡であり終端reportではない',
      );
      const terminalReportSeq = coordinator.listWorkerReports(task.id, 0, manager.id)[0]?.seq ?? 0;
      expect(coordinator.listWorkerReports(task.id, terminalReportSeq, manager.id)).toEqual([]);
      await expect(
        coordinator.assignTaskAs(
          {
            taskId: task.id,
            targetAgentId: sibling.id,
            content: '別部門へ越権する',
            doneCriteria: [],
          },
          manager.id,
        ),
      ).rejects.toThrow('direct child');
      persistence.close();
    });

    it('supports Leader 1 → SubLeader 3 → Worker 6 and queues the ninth execution', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-ten-agent-'));
      cleanup.push(directory);
      const databasePath = join(directory, 'test.sqlite3');
      const persistence = new SqlitePersistenceClient(databasePath);
      const task = persistence.createTask('Ten Agent hierarchy');
      const runtime = new BlockingWorkerRuntime();
      const coordinator = new TeamCoordinator(
        persistence,
        runtime,
        () => undefined,
        () => new Date(),
        120_000,
        new TeamExecutionScheduler(8),
      );
      const team = persistence.promoteTaskToTeam(task.id);
      const managers = [];
      const childrenByManager = new Map<
        string,
        Awaited<ReturnType<typeof coordinator.hireWorkerAs>>[]
      >();

      for (let managerIndex = 0; managerIndex < 3; managerIndex += 1) {
        const manager = await coordinator.hireWorkerAs(
          {
            taskId: task.id,
            role: `SubLeader-${managerIndex + 1}`,
            objective: '直属Workerを2名管理する',
            contextInheritancePolicy: 'summary',
            writeCapable: false,
          },
          team.leaderAgentId,
          {
            maxDirectChildren: 2,
            maxDelegationLevels: 1,
            allowManagerChildren: false,
          },
        );
        managers.push(manager);
        const children = [];
        for (let childIndex = 0; childIndex < 2; childIndex += 1)
          children.push(
            await coordinator.hireWorkerAs(
              {
                taskId: task.id,
                role: `Worker-${managerIndex + 1}-${childIndex + 1}`,
                objective: '担当作業を完了する',
                contextInheritancePolicy: 'summary',
                writeCapable: false,
              },
              manager.id,
            ),
          );
        childrenByManager.set(manager.id, children);
      }

      const snapshot = persistence.getTeamSnapshot(team.id);
      expect(snapshot.agents).toHaveLength(10);
      expect(snapshot.agents.filter(({ depth }) => depth === 0)).toHaveLength(1);
      expect(snapshot.agents.filter(({ depth }) => depth === 1)).toHaveLength(3);
      expect(snapshot.agents.filter(({ depth }) => depth === 2)).toHaveLength(6);
      for (const manager of managers) {
        expect(manager).toMatchObject({
          parentAgentId: team.leaderAgentId,
          depth: 1,
          canDelegate: true,
          managerPolicy: {
            maxDirectChildren: 2,
            maxDelegationDepth: 2,
            allowManagerChildren: false,
          },
        });
        const children = childrenByManager.get(manager.id) ?? [];
        expect(children).toHaveLength(2);
        expect(children).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ parentAgentId: manager.id, depth: 2, canDelegate: false }),
            expect.objectContaining({ parentAgentId: manager.id, depth: 2, canDelegate: false }),
          ]),
        );
      }
      const firstManager = managers[0]!;
      const otherBranchChild = childrenByManager.get(managers[1]!.id)![0]!;
      await expect(
        coordinator.assignTaskAs(
          {
            taskId: task.id,
            targetAgentId: otherBranchChild.id,
            content: '他部門へ越権割当',
            doneCriteria: ['拒否される'],
          },
          firstManager.id,
        ),
      ).rejects.toThrow('direct child');

      const submissions = [];
      for (const manager of managers) {
        submissions.push(
          await coordinator.assignTask({
            taskId: task.id,
            targetAgentId: manager.id,
            content: `${manager.role}の統括報告`,
            doneCriteria: ['終端報告する'],
          }),
        );
        for (const child of childrenByManager.get(manager.id) ?? [])
          submissions.push(
            await coordinator.assignTaskAs(
              {
                taskId: task.id,
                targetAgentId: child.id,
                content: `${child.role}の担当作業`,
                doneCriteria: ['終端報告する'],
              },
              manager.id,
            ),
          );
      }
      expect(submissions).toHaveLength(9);
      await waitFor(() => runtime.activeExecutions === 8);
      expect(
        persistence.listTeamExecutions(team.id).filter(({ state }) => state === 'running'),
      ).toHaveLength(8);
      expect(
        persistence.listTeamExecutions(team.id).filter(({ state }) => state === 'queued'),
      ).toHaveLength(1);

      for (const release of runtime.releases.splice(0, 8)) release();
      await waitFor(() => runtime.activeExecutions === 1 && runtime.releases.length === 1);
      runtime.releases.shift()?.();
      await waitFor(() =>
        persistence.listTeamExecutions(team.id).every(({ state }) => state === 'completed'),
      );
      expect(coordinator.listWorkerReports(task.id, 0)).toHaveLength(3);
      for (const manager of managers)
        expect(coordinator.listWorkerReports(task.id, 0, manager.id)).toHaveLength(2);

      const budgets = persistence.getTeamBudgetStatus(team.id);
      expect(
        budgets.filter(({ scope, kind }) => scope === 'worker' && kind === 'spawnSlots'),
      ).toHaveLength(0);
      for (const scope of ['global', 'team'] as const)
        expect(
          budgets.find(
            ({ scope: candidate, kind }) => candidate === scope && kind === 'spawnSlots',
          ),
        ).toMatchObject({ committed: 0, reserved: 0 });
      persistence.close();

      const reopened = new SqlitePersistenceClient(databasePath);
      expect(reopened.getTeamSnapshot(team.id).agents).toHaveLength(10);
      expect(reopened.listTeamExecutions(team.id)).toHaveLength(9);
      expect(reopened.listTeamExecutions(team.id).every(({ state }) => state === 'completed')).toBe(
        true,
      );
      reopened.close();
    });

    it('keeps child Manager delegation inside the parent ceiling with distinct error codes', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Delegation error codes');
      const coordinator = new TeamCoordinator(persistence, new TestWorkerRuntime());
      const team = persistence.promoteTaskToTeam(task.id);
      const parent = await coordinator.hireWorkerAs(
        {
          taskId: task.id,
          role: 'Parent Manager',
          objective: 'Delegate one level',
          contextInheritancePolicy: 'summary',
          writeCapable: false,
        },
        team.leaderAgentId,
        {
          maxDirectChildren: 2,
          maxDelegationLevels: 1,
          allowManagerChildren: true,
        },
      );

      await expect(
        coordinator.hireWorkerAs(
          {
            taskId: task.id,
            role: 'Escaping Manager',
            objective: 'Attempt to exceed the parent ceiling',
            contextInheritancePolicy: 'summary',
            writeCapable: false,
          },
          parent.id,
          {
            maxDirectChildren: 1,
            maxDelegationLevels: 1,
            allowManagerChildren: false,
          },
        ),
      ).rejects.toMatchObject({ code: 'manager_delegation_limit' });
      await expect(
        coordinator.hireWorkerAs(
          {
            taskId: task.id,
            role: 'Too deep',
            objective: 'Attempt to exceed Team depth',
            contextInheritancePolicy: 'summary',
            writeCapable: false,
          },
          team.leaderAgentId,
          {
            maxDirectChildren: 1,
            maxDelegationLevels: 4,
            allowManagerChildren: false,
          },
        ),
      ).rejects.toMatchObject({ code: 'team_depth_limit' });
      expect(persistence.getTeamSnapshot(team.id).agents).toHaveLength(2);
      persistence.close();
    });

    it('rejects a zero-level relative Manager policy before creating an Agent', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Manager absolute delegation depth');
      const coordinator = new TeamCoordinator(persistence, new TestWorkerRuntime());
      const team = persistence.promoteTaskToTeam(task.id);

      await expect(
        coordinator.hireWorkerAs(
          {
            taskId: task.id,
            role: '調査部長',
            objective: '直属Workerへ再委譲する',
            contextInheritancePolicy: 'summary',
            writeCapable: false,
          },
          team.leaderAgentId,
          {
            maxDirectChildren: 2,
            maxDelegationLevels: 0,
            allowManagerChildren: false,
          },
        ),
      ).rejects.toThrow('maxDelegationLevels must be a positive integer');
      expect(persistence.getTeamSnapshot(team.id).agents).toHaveLength(1);
      persistence.close();
    });

    it('requires re-hiring a legacy Manager whose persisted ceiling equals its own depth', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Legacy Manager re-hire');
      const team = persistence.promoteTaskToTeam(task.id);
      const legacyManager = persistence.registerTeamWorker({
        teamId: team.id,
        role: 'Legacy Manager',
        objective: 'Old absolute-depth contract',
        parentCapabilityCeiling: {
          entries: [],
          maxWorkerDepth: 0,
          maxConcurrentWorkers: 2,
        },
        contextInheritancePolicy: 'summary',
        parentAgentId: team.leaderAgentId,
        canDelegate: true,
        managerPolicy: {
          maxDirectChildren: 2,
          maxDelegationDepth: 1,
          allowManagerChildren: false,
        },
      });
      const coordinator = new TeamCoordinator(persistence, new TestWorkerRuntime());

      await expect(
        coordinator.hireWorkerAs(
          {
            taskId: task.id,
            role: 'Blocked child',
            objective: 'Must not inherit auto-granted authority',
            contextInheritancePolicy: 'summary',
            writeCapable: false,
          },
          legacyManager.id,
        ),
      ).rejects.toMatchObject({
        code: 'manager_delegation_limit',
        message: expect.stringContaining('re-hire'),
        details: { requiresRehire: true },
      });
      expect(persistence.getTeamSnapshot(team.id).agents).toHaveLength(2);
      persistence.close();
    });

    it('returns durable execution IDs before completion and runs at most eight in parallel', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Eight parallel executions');
      const runtime = new BlockingWorkerRuntime();
      const coordinator = new TeamCoordinator(persistence, runtime);
      const workers = [];
      for (let index = 0; index < 10; index += 1)
        workers.push(
          await coordinator.hireWorker({
            taskId: task.id,
            role: `worker-${index}`,
            objective: `objective-${index}`,
            contextInheritancePolicy: 'summary',
            writeCapable: false,
          }),
        );

      const submissions = await Promise.all(
        workers.map((worker) =>
          coordinator.assignTask({
            taskId: task.id,
            targetAgentId: worker.id,
            content: `execute-${worker.role}`,
            doneCriteria: ['runtime completes'],
          }),
        ),
      );
      expect(new Set(submissions.map(({ executionId }) => executionId)).size).toBe(10);
      await waitFor(() => runtime.activeExecutions === 8);
      expect(runtime.maxActiveExecutions).toBe(8);
      const teamId = workers[0]!.teamId;
      expect(
        persistence.listTeamExecutions(teamId).filter(({ state }) => state === 'running'),
      ).toHaveLength(8);
      expect(
        persistence.listTeamExecutions(teamId).filter(({ state }) => state === 'queued'),
      ).toHaveLength(2);

      for (const release of runtime.releases.splice(0, 8)) release();
      await waitFor(() => runtime.releases.length === 2 && runtime.activeExecutions === 2);
      for (const release of runtime.releases.splice(0)) release();
      await waitFor(() =>
        persistence.listTeamExecutions(teamId).every(({ state }) => state === 'completed'),
      );
      expect(
        persistence
          .listTeamExecutions(teamId)
          .every((execution) => persistence.listTeamAttempts(execution.id).length === 1),
      ).toBe(true);
      expect(
        persistence
          .getTeamSnapshot(teamId)
          .messages.filter(({ executionId }) => executionId !== null),
      ).toHaveLength(20);
      persistence.close();
    });

    it('steers and cancels queued executions before they consume a runtime slot', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Queued execution control');
      const runtime = new BlockingWorkerRuntime();
      const coordinator = new TeamCoordinator(
        persistence,
        runtime,
        () => undefined,
        () => new Date(),
        120_000,
        new TeamExecutionScheduler(1),
      );
      const workers = [];
      for (const role of ['first', 'steered', 'canceled'])
        workers.push(
          await coordinator.hireWorker({
            taskId: task.id,
            role,
            objective: role,
            contextInheritancePolicy: 'summary',
            writeCapable: false,
          }),
        );
      const [first, steered, canceled] = await Promise.all(
        workers.map((worker) =>
          coordinator.assignTask({
            taskId: task.id,
            targetAgentId: worker.id,
            content: `initial-${worker.role}`,
            doneCriteria: ['runtime completes'],
          }),
        ),
      );
      if (first === undefined || steered === undefined || canceled === undefined)
        throw new Error('Expected three submissions');
      await waitFor(() => runtime.activeExecutions === 1);

      await expect(
        coordinator.steerExecution(task.id, steered.executionId, 'revised-steered'),
      ).resolves.toMatchObject({ executionId: steered.executionId, state: 'queued' });
      await expect(
        coordinator.cancelExecution(task.id, canceled.executionId),
      ).resolves.toMatchObject({ executionId: canceled.executionId, state: 'canceled' });
      expect(persistence.getTeamExecution(steered.executionId).instruction).toMatchObject({
        revision: 2,
        content: 'revised-steered',
      });
      expect(persistence.listTeamAttempts(canceled.executionId)).toHaveLength(0);

      runtime.releases.shift()?.();
      await waitFor(() => runtime.contents.includes('revised-steered'));
      expect(runtime.contents).toEqual(['initial-first', 'revised-steered']);
      runtime.releases.shift()?.();
      await waitFor(() => persistence.getTeamExecution(steered.executionId).state === 'completed');
      expect(persistence.getTeamExecution(canceled.executionId).state).toBe('canceled');
      const canceledMessage = persistence
        .getTeamSnapshot(workers[0]!.teamId)
        .messages.find(({ executionId }) => executionId === canceled.executionId);
      expect(canceledMessage).toBeDefined();
      expect(persistence.getTeamDelivery(canceledMessage!.id)?.state).toBe('failed');
      persistence.close();
    });

    it('carries earlier Agent work into a restarted execution without requiring a read tool', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Execution context continuity');
      const runtime = new InterruptibleWorkerRuntime();
      const coordinator = new TeamCoordinator(persistence, runtime);
      const worker = await coordinator.hireWorker({
        taskId: task.id,
        role: '論点整理',
        objective: 'AI便益論を整理する',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });

      const submission = await coordinator.assignTask({
        taskId: task.id,
        targetAgentId: worker.id,
        content: 'AI便益論の論点を作成してください。',
        doneCriteria: ['論点を作成する'],
      });
      await waitFor(() => runtime.contents.length === 1);
      const team = persistence.getTeamByTask(task.id);
      if (team === null) throw new Error('Expected active Team');
      await coordinator.sendAgentMessageAs(
        task.id,
        worker.id,
        team.leaderAgentId,
        'AIの便益は生産性向上と知識アクセスの改善です。',
      );
      await coordinator.steerExecution(
        task.id,
        submission.executionId,
        'すでに作成した論点を使って最終回答を書いてください。ツールは禁止です。',
      );
      await waitFor(() => runtime.contents.length === 2);

      expect(runtime.priorConversations[1]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: 'received',
            content: 'AI便益論の論点を作成してください。',
          }),
          expect.objectContaining({
            direction: 'sent',
            content: expect.stringContaining('AIの便益は生産性向上と知識アクセスの改善です。'),
          }),
        ]),
      );
      runtime.complete(worker.id);
      await waitFor(
        () => persistence.getTeamExecution(submission.executionId).state === 'completed',
      );
      persistence.close();
    });

    it('cancels a queued execution when its Worker is stopped', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Stop queued Worker');
      const runtime = new BlockingWorkerRuntime();
      const coordinator = new TeamCoordinator(
        persistence,
        runtime,
        () => undefined,
        () => new Date(),
        120_000,
        new TeamExecutionScheduler(1),
      );
      const firstWorker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'running',
        objective: 'hold the only slot',
        contextInheritancePolicy: 'summary',
        writeCapable: false,
      });
      const queuedWorker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'queued',
        objective: 'must be canceled',
        contextInheritancePolicy: 'summary',
        writeCapable: false,
      });
      const first = await coordinator.assignTask({
        taskId: task.id,
        targetAgentId: firstWorker.id,
        content: 'running',
        doneCriteria: ['complete'],
      });
      const queued = await coordinator.assignTask({
        taskId: task.id,
        targetAgentId: queuedWorker.id,
        content: 'must-not-run',
        doneCriteria: ['complete'],
      });
      await waitFor(() => runtime.activeExecutions === 1);

      await expect(coordinator.stopWorker(task.id, queuedWorker.id)).resolves.toMatchObject({
        id: queuedWorker.id,
        state: 'stopped',
      });
      expect(persistence.getTeamExecution(queued.executionId).state).toBe('canceled');
      expect(persistence.listTeamAttempts(queued.executionId)).toHaveLength(0);

      runtime.releases.shift()?.();
      await waitFor(() => persistence.getTeamExecution(first.executionId).state === 'completed');
      expect(runtime.contents).toEqual(['running']);
      persistence.close();
    });

    it('persists a terminal, identity-bound report when a scheduled runtime fails', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Runtime failure report');
      const runtime: TeamWorkerRuntime = {
        async start() {
          return { pid: null };
        },
        async execute() {
          throw new Error('deliberate runtime failure');
        },
        async stop() {},
      };
      const coordinator = new TeamCoordinator(persistence, runtime);
      const worker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'failing worker',
        objective: 'prove failure reporting',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });
      const submission = await coordinator.assignTask({
        taskId: task.id,
        targetAgentId: worker.id,
        content: 'fail now',
        doneCriteria: ['never satisfied'],
      });

      await waitFor(() => persistence.getTeamExecution(submission.executionId).state === 'failed');
      const attempts = persistence.listTeamAttempts(submission.executionId);
      const attempt = attempts.at(-1);
      const reports = coordinator.listWorkerReports(task.id, 0);
      expect(attempts).toHaveLength(2);
      expect(attempt).toMatchObject({ state: 'failed', terminalReason: 'runtime_failure' });
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        sourceAgentId: worker.id,
        executionId: submission.executionId,
        attemptId: attempt?.id,
      });
      expect(JSON.parse(reports[0]!.content)).toMatchObject({
        status: 'failed',
        summary: 'deliberate runtime failure',
      });
      persistence.close();
    });

    it('terminalizes Task, Execution, and Delivery when preflight fails before an Attempt starts', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Preflight failure state');
      const coordinator = new TeamCoordinator(
        persistence,
        new TestWorkerRuntime(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async () => {
          throw new Error('deliberate preflight failure');
        },
      );
      const worker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'preflight worker',
        objective: 'prove terminal state',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });
      const submission = await coordinator.assignTask({
        taskId: task.id,
        targetAgentId: worker.id,
        content: 'fail before runtime',
        doneCriteria: ['never reached'],
      });

      await waitFor(() => persistence.getTeamExecution(submission.executionId).state === 'failed');
      const dispatch = persistence.getTeamExecutionDispatch(submission.executionId);
      expect(persistence.listTeamAttempts(submission.executionId)).toHaveLength(0);
      expect(persistence.getTeamTask(dispatch.teamTaskId)).toMatchObject({
        status: 'failed',
      });
      expect(persistence.getTeamDelivery(dispatch.messageId)).toMatchObject({
        state: 'failed',
        lastError: 'deliberate preflight failure',
      });
      persistence.close();
    });

    it('terminalizes a Mission when preflight fails before its first Attempt starts', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Mission preflight failure state');
      const coordinator = new TeamCoordinator(
        persistence,
        new TestWorkerRuntime(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async () => {
          throw new Error('deliberate Mission preflight failure');
        },
      );
      const worker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'Mission preflight worker',
        objective: 'prove terminal Mission state',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });
      const mission = await coordinator.assignMission({
        taskId: task.id,
        objective: 'fail Mission before runtime',
        doneCriteria: ['never reached'],
        steps: [
          {
            workerId: worker.id,
            objective: 'first step',
            doneCriteria: ['never reached'],
            access: 'read-only',
          },
          {
            workerId: worker.id,
            objective: 'second step',
            doneCriteria: ['never reached'],
            access: 'read-only',
          },
        ],
      });
      const executionId = mission.steps[0]!.executionId;

      await waitFor(() => persistence.getTeamExecution(executionId).state === 'failed');
      const dispatch = persistence.getTeamExecutionDispatch(executionId);
      expect(persistence.listTeamAttempts(executionId)).toHaveLength(0);
      expect(persistence.getTeamTask(dispatch.teamTaskId).status).toBe('failed');
      expect(persistence.getTeamMission(mission.id).state).toBe('failed');
      expect(persistence.getTeamDelivery(dispatch.messageId)).toMatchObject({
        state: 'failed',
        lastError: 'deliberate Mission preflight failure',
      });
      persistence.close();
    });

    it('interrupts running executions for steer or cancel without changing execution identity', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask('Running execution control');
      const runtime = new InterruptibleWorkerRuntime();
      const coordinator = new TeamCoordinator(persistence, runtime);
      const workers = [];
      for (const role of ['steered', 'canceled'])
        workers.push(
          await coordinator.hireWorker({
            taskId: task.id,
            role,
            objective: role,
            contextInheritancePolicy: 'summary',
            writeCapable: false,
          }),
        );
      const [steeredWorker, canceledWorker] = workers;
      if (steeredWorker === undefined || canceledWorker === undefined)
        throw new Error('Expected two workers');
      const [steered, canceled] = await Promise.all([
        coordinator.assignTask({
          taskId: task.id,
          targetAgentId: steeredWorker.id,
          content: 'initial-steered',
          doneCriteria: ['runtime completes'],
        }),
        coordinator.assignTask({
          taskId: task.id,
          targetAgentId: canceledWorker.id,
          content: 'initial-canceled',
          doneCriteria: ['runtime completes'],
        }),
      ]);
      await waitFor(() => runtime.contents.length === 2);

      await expect(
        coordinator.steerExecution(task.id, steered.executionId, 'revised-running'),
      ).resolves.toMatchObject({ executionId: steered.executionId, state: 'queued' });
      await waitFor(
        () => runtime.contents.filter(({ agentId }) => agentId === steeredWorker.id).length === 2,
      );
      await expect(
        coordinator.cancelExecution(task.id, canceled.executionId),
      ).resolves.toMatchObject({ executionId: canceled.executionId, state: 'canceled' });

      expect(persistence.listTeamAttempts(steered.executionId)).toMatchObject([
        { ordinal: 1, state: 'interrupted', terminalReason: 'steered' },
        { ordinal: 2, state: 'running', terminalReason: null },
      ]);
      expect(persistence.listTeamAttempts(canceled.executionId)).toMatchObject([
        { ordinal: 1, state: 'canceled', terminalReason: 'user_canceled' },
      ]);
      expect(
        runtime.contents
          .filter(({ agentId }) => agentId === steeredWorker.id)
          .map(({ content }) => content),
      ).toEqual(['initial-steered', 'revised-running']);

      runtime.complete(steeredWorker.id);
      await waitFor(() => persistence.getTeamExecution(steered.executionId).state === 'completed');
      expect(persistence.listTeamAttempts(steered.executionId)).toMatchObject([
        { ordinal: 1, state: 'interrupted' },
        { ordinal: 2, state: 'completed' },
      ]);
      expect(persistence.getTeamExecution(canceled.executionId).state).toBe('canceled');
      const messagesByContent = new Map(
        coordinator.get(task.id)?.messages.map((message) => [message.content, message]) ?? [],
      );
      expect(messagesByContent.get('initial-steered')?.deliveryState).toBe('acked');
      expect(messagesByContent.get('revised-running')?.deliveryState).toBe('acked');
      expect(messagesByContent.get('initial-canceled')?.deliveryState).toBe('failed');
      persistence.close();
    });

    it('rehydrates an interrupted attempt into the Scheduler after app restart', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-team-rehydrate-'));
      cleanup.push(directory);
      const path = join(directory, 'test.sqlite3');
      const firstPersistence = new SqlitePersistenceClient(path);
      const task = firstPersistence.createTask('Restart execution recovery');
      const firstRuntime = new InterruptibleWorkerRuntime();
      const firstCoordinator = new TeamCoordinator(firstPersistence, firstRuntime);
      const worker = await firstCoordinator.hireWorker({
        taskId: task.id,
        role: 'recoverable',
        objective: 'resume after restart',
        contextInheritancePolicy: 'summary',
        writeCapable: false,
      });
      const submission = await firstCoordinator.assignTask({
        taskId: task.id,
        targetAgentId: worker.id,
        content: 'continue this exact instruction',
        doneCriteria: ['runtime completes after restart'],
      });
      await waitFor(() => firstRuntime.contents.length === 1);
      const firstAttempt = firstPersistence.listTeamAttempts(submission.executionId)[0];
      expect(firstAttempt?.state).toBe('running');
      firstPersistence.close();

      const reopened = new SqlitePersistenceClient(path);
      reopened.initializeMutationRecovery('replacement-instance', '2026-07-28T12:00:00.000Z');
      const secondRuntime = new InterruptibleWorkerRuntime();
      const secondCoordinator = new TeamCoordinator(reopened, secondRuntime);
      secondCoordinator.recoverOnStartup();
      await waitFor(() => secondRuntime.contents.length === 1);

      expect(reopened.getTeam(worker.teamId).state).toBe('active');
      expect(reopened.listTeamAttempts(submission.executionId)).toMatchObject([
        { id: firstAttempt?.id, ordinal: 1, state: 'interrupted', terminalReason: 'app_restart' },
        { ordinal: 2, state: 'running', terminalReason: null },
      ]);
      expect(secondRuntime.contents[0]).toMatchObject({
        agentId: worker.id,
        content: 'continue this exact instruction',
      });
      secondRuntime.complete(worker.id);
      await waitFor(() => reopened.getTeamExecution(submission.executionId).state === 'completed');
      expect(reopened.listTeamAttempts(submission.executionId)).toMatchObject([
        { ordinal: 1, state: 'interrupted' },
        { ordinal: 2, state: 'completed' },
      ]);
      reopened.close();
    });

    it('rejects runtime identity spoofing and fails the delivery closed', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask();
      const runtime = new TestWorkerRuntime();
      const coordinator = new TeamCoordinator(persistence, runtime);
      const worker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'worker',
        objective: 'work',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });
      runtime.spoofClaims = true;

      await expect(
        coordinator.sendToWorker({
          taskId: task.id,
          targetAgentId: worker.id,
          content: 'spoof attempt',
        }),
      ).rejects.toThrow('identity mismatch');
      const detail = coordinator.get(task.id);
      expect(detail?.workers.find(({ id }) => id === worker.id)?.state).toBe('failed');
      expect(detail?.messages[0]?.deliveryState).toBe('failed');
      persistence.close();
    });

    it('preserves a failed Worker report as failed instead of promoting it to completed', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask();
      const runtime = new TestWorkerRuntime();
      runtime.completionStatus = 'failed';
      const coordinator = new TeamCoordinator(persistence, runtime);
      const worker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'reviewer',
        objective: 'find a blocker',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });

      await coordinator.sendToWorker({
        taskId: task.id,
        targetAgentId: worker.id,
        content: 'report failure',
      });

      expect(coordinator.get(task.id)?.workers.find(({ id }) => id === worker.id)?.state).toBe(
        'failed',
      );
      persistence.close();
    });

    it('hasBusyWorkers reflects an in-flight dispatch and clears once it settles', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask();
      let releaseExecute: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseExecute = resolve;
      });
      const runtime: TeamWorkerRuntime = {
        async start() {
          return { pid: null };
        },
        async execute(input) {
          await gate;
          return {
            claims: {
              deliveryId: input.envelope.deliveryId,
              sourceAgentId: input.envelope.sourceAgentId,
              targetAgentId: input.envelope.targetAgentId,
            },
            completion: {
              status: 'succeeded',
              summary: 'done',
              artifacts: [],
              verification: [],
              risks: [],
            },
          };
        },
        async stop() {
          /* not exercised in this test */
        },
      };
      const coordinator = new TeamCoordinator(persistence, runtime);
      const worker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'worker',
        objective: 'work',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });
      expect(coordinator.hasBusyWorkers(task.id)).toBe(false);

      const dispatch = coordinator.sendToWorker({
        taskId: task.id,
        targetAgentId: worker.id,
        content: 'go',
      });
      // Give sendToWorker's synchronous prefix (queued via the Task mailbox) a tick to actually
      // transition the Worker to 'busy' before asserting.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(coordinator.hasBusyWorkers(task.id)).toBe(true);

      releaseExecute?.();
      await dispatch;
      expect(coordinator.hasBusyWorkers(task.id)).toBe(false);
      persistence.close();
    });

    it('seals a manual Team execution at dispatch and passes its durable execution ID', async () => {
      const persistence = createPersistence();
      const project = persistence.createProject('Manual dispatch context');
      persistence.setProjectInstruction({
        projectId: project.id,
        expectedRevision: project.revision,
        instruction: 'Seal this at Team dispatch.',
      });
      const task = persistence.createTask('manual Team dispatch', false, project.id);
      let dispatchedExecutionId: string | undefined;
      let dispatchedInstruction: string | undefined;
      const runtime: TeamWorkerRuntime = {
        async start() {
          return { pid: null };
        },
        async execute(input) {
          dispatchedExecutionId = input.executionId;
          dispatchedInstruction =
            input.executionId === undefined
              ? undefined
              : persistence.prepareTeamExecutionContext(task.id, input.executionId).projectItems[0]
                  ?.content;
          return {
            claims: {
              deliveryId: input.envelope.deliveryId,
              sourceAgentId: input.envelope.sourceAgentId,
              targetAgentId: input.envelope.targetAgentId,
            },
            completion: {
              status: 'succeeded',
              summary: 'done',
              artifacts: [],
              verification: [],
              risks: [],
            },
          };
        },
        async stop() {},
      };
      const coordinator = new TeamCoordinator(persistence, runtime);
      const worker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'worker',
        objective: 'work',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });

      const submission = await coordinator.assignTask({
        taskId: task.id,
        targetAgentId: worker.id,
        content: 'dispatch now',
        doneCriteria: ['done'],
      });
      await waitFor(() => dispatchedExecutionId !== undefined);

      expect(dispatchedExecutionId).toBe(submission.executionId);
      expect(dispatchedInstruction).toBe('Seal this at Team dispatch.');
      await waitFor(
        () => persistence.getTeamExecution(submission.executionId).state === 'completed',
      );
      persistence.close();
    });

    it('pushes accepted, stage, reasoning, and batched output into the live Worker snapshot', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask();
      let releaseExecute: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseExecute = resolve;
      });
      const runtime: TeamWorkerRuntime = {
        async start() {
          return { pid: null };
        },
        async execute(input) {
          input.onEvent?.({ type: 'accepted', at: '2026-07-26T00:00:00.000Z' });
          input.onEvent?.({
            type: 'activity',
            phase: 'planning',
            label: '方針を検討中',
            at: '2026-07-26T00:00:01.000Z',
          });
          input.onEvent?.({ type: 'reasoningPresence', active: true });
          input.onEvent?.({ type: 'outputDelta', text: '途中出力' });
          await gate;
          input.onEvent?.({ type: 'completed' });
          return {
            claims: {
              deliveryId: input.envelope.deliveryId,
              sourceAgentId: input.envelope.sourceAgentId,
              targetAgentId: input.envelope.targetAgentId,
            },
            completion: {
              status: 'succeeded',
              summary: '完了',
              artifacts: [],
              verification: [],
              risks: [],
            },
          };
        },
        async stop() {},
      };
      const snapshots: ReturnType<TeamCoordinator['get']>[] = [];
      const coordinator = new TeamCoordinator(persistence, runtime, (_taskId, detail) => {
        snapshots.push(detail);
      });
      const worker = await coordinator.hireWorker({
        taskId: task.id,
        role: 'worker',
        objective: 'stream',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });

      const dispatch = coordinator.sendToWorker({
        taskId: task.id,
        targetAgentId: worker.id,
        content: 'go',
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const live = snapshots.at(-1)?.workers.find(({ id }) => id === worker.id);
      expect(live).toMatchObject({
        state: 'busy',
        currentActivity: '方針を検討中',
        reasoningActive: true,
        liveOutput: '途中出力',
      });

      releaseExecute?.();
      await dispatch;
      expect(coordinator.get(task.id)?.workers.find(({ id }) => id === worker.id)).toMatchObject({
        state: 'done',
        reasoningActive: false,
        liveOutput: '',
      });
      persistence.close();
    });

    it('stops every owned Worker through the runtime and completes the Team', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask();
      const runtime = new TestWorkerRuntime();
      const coordinator = new TeamCoordinator(persistence, runtime);
      const workers = [];
      for (const role of ['one', 'two', 'three'])
        workers.push(
          await coordinator.hireWorker({
            taskId: task.id,
            role,
            objective: role,
            contextInheritancePolicy: 'none',
            writeCapable: false,
          }),
        );

      const detail = await coordinator.stopAll(task.id);
      expect(new Set(runtime.stopped)).toEqual(new Set(workers.map(({ id }) => id)));
      expect(detail.team.state).toBe('completed');
      expect(
        detail.workers
          .filter(({ kind }) => kind === 'worker')
          .every(({ state }) => state === 'stopped'),
      ).toBe(true);
      persistence.close();
    });

    it('re-forms a completed Team when a later turn explicitly hires a fresh Worker', async () => {
      const persistence = createPersistence();
      const task = persistence.createTask();
      const runtime = new TestWorkerRuntime();
      const coordinator = new TeamCoordinator(persistence, runtime);
      const previous = await coordinator.hireWorker({
        taskId: task.id,
        role: 'previous greeting worker',
        objective: 'greet once',
        contextInheritancePolicy: 'none',
        writeCapable: false,
      });

      await coordinator.sendToWorker({
        taskId: task.id,
        targetAgentId: previous.id,
        content: 'first greeting',
      });
      expect(coordinator.get(task.id)?.workers.find(({ id }) => id === previous.id)?.state).toBe(
        'done',
      );
      const historicalMessageSeq = coordinator.latestTeamMessageSeq(task.id);
      expect(historicalMessageSeq).toBeGreaterThan(0);
      await expect(
        coordinator.hireWorkerAs(
          {
            taskId: task.id,
            role: 'invalid child',
            objective: 'must not reopen the Team',
            contextInheritancePolicy: 'none',
            writeCapable: false,
          },
          previous.id,
        ),
      ).rejects.toThrow('A terminal Agent cannot hire child Agents');
      expect(coordinator.get(task.id)?.team.state).toBe('completed');

      vi.spyOn(runtime, 'start').mockRejectedValueOnce(new Error('runtime unavailable'));
      await expect(
        coordinator.hireWorker({
          taskId: task.id,
          role: 'failed replacement',
          objective: 'must not reopen before runtime startup',
          contextInheritancePolicy: 'none',
          writeCapable: false,
        }),
      ).rejects.toThrow('runtime unavailable');
      expect(coordinator.get(task.id)?.team.state).toBe('completed');
      const failedReplacement = coordinator
        .get(task.id)
        ?.workers.find(({ role }) => role === 'failed replacement');
      expect(failedReplacement?.state).toBe('failed');

      const fresh = await coordinator.hireWorker({
        taskId: task.id,
        role: 'fresh greeting worker',
        objective: 'greet again',
        contextInheritancePolicy: 'summary',
        writeCapable: false,
      });

      const detail = coordinator.get(task.id);
      expect(detail?.team.state).toBe('active');
      expect(detail?.workers.find(({ id }) => id === previous.id)?.state).toBe('stopped');
      expect(detail?.workers.find(({ id }) => id === failedReplacement?.id)?.state).toBe('stopped');
      expect(detail?.workers.find(({ id }) => id === fresh.id)?.state).toBe('ready');
      expect(coordinator.latestTeamMessageSeq(task.id)).toBe(historicalMessageSeq);
      persistence.close();
    });
  });
else
  describe('TeamCoordinator Electron ABI bridge', () => {
    it('runs the TeamCoordinator integration suite with Electron', async () => {
      // This suite can exceed Vitest's worker-RPC timeout on Windows CI. An asynchronous child
      // keeps the worker event loop available while Electron runs the SQLite integration cases.
      const result = await execFileAsync(
        electronTestExecutablePath(),
        [
          join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
          'run',
          'src/main/team-coordinator.test.ts',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SPRINT_CODER_ELECTRON_DB_TEST: '1' },
          // This bridge runs the coordinator integration cases in a second Electron process. A
          // serialized Windows suite can take about a minute and still needs time for clean
          // Vitest/Electron shutdown.
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      expect(result.stderr, result.stdout).not.toContain('Failed Tests');
    }, 130_000);
  });
