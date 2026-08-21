import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { TeamEnvelope } from '@sprint-coder/domain';
import { electronTestExecutablePath } from './electron-test-runtime';
import { auditCodexOnlyTeam } from './team-codex-audit';
import {
  TeamCoordinator,
  type TeamWorkerRuntime,
  type WorkerRuntimeResult,
} from './team-coordinator';
import type { AgentRecord } from './persistence';
import { SqlitePersistenceClient } from './persistence';
import { CodexRuntimeAdapter, probeCodex } from '../runtime-host/codex-adapter';
import { WorkerWorktreeManager } from './worker-worktree';
import { ManagedCodingHarness } from './provider-workspace-tools';
import { probeSandboxRunner } from './sandbox-runner';

const enabled = process.env['SPRINT_CODER_RUN_CODEX_SOAK'] === '1';
const electronChild = process.env['SPRINT_CODER_ELECTRON_DB_TEST'] === '1';
const roots: string[] = [];
// Four long real-Codex steps plus the 30-minute absolute timeout must exceed one hour.
const SOAK_SHARD_MS = durationFromEnvironment('SPRINT_CODER_SOAK_SHARD_MS', 7 * 60_000 + 30_000);
const SOAK_HARD_TIMEOUT_MS = durationFromEnvironment(
  'SPRINT_CODER_SOAK_HARD_TIMEOUT_MS',
  30 * 60_000,
);
const SOAK_MINIMUM_MS = durationFromEnvironment('SPRINT_CODER_SOAK_MINIMUM_MS', 60 * 60_000);
const SOAK_WAITING_RESUME_TIMEOUT_MS = durationFromEnvironment(
  'SPRINT_CODER_SOAK_WAITING_RESUME_TIMEOUT_MS',
  82 * 60_000,
);
const SOAK_SHELL_EXECUTABLE = '/bin/sh';

afterAll(() => {
  if (process.env['SPRINT_CODER_KEEP_SOAK_ARTIFACTS'] === '1') return;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class DirectCodexTeamRuntime implements TeamWorkerRuntime {
  private readonly adapter = new CodexRuntimeAdapter(Math.max(120_000, SOAK_HARD_TIMEOUT_MS * 2));
  private readonly active = new Map<string, { turnId: string; executionWorkspace: string }>();
  private readonly harness: ManagedCodingHarness;
  private sandboxReady = false;

  constructor(
    private readonly persistence: SqlitePersistenceClient,
    private readonly taskId: string,
    private readonly workspacePath: string,
  ) {
    this.harness = new ManagedCodingHarness({
      workspaceFor: (taskId, turnId) =>
        this.persistence.readTurnWorkspaceSetForTask(taskId, turnId),
      rootIdentityFor: (turnId, rootId) =>
        this.persistence.getTurnWorkspaceRootIdentities(turnId).get(rootId),
      policyEpochFor: (taskId) => this.persistence.getPermissionPolicy(taskId).policyEpoch,
      authorizer: () => ({ decision: 'allow', reason: 'real_soak_fixture' }),
      lifecycle: (event) => this.persistence.recordManagedToolLifecycle(event),
      command: { persistence: this.persistence, publish: () => undefined },
    });
  }

  async start(): Promise<{ pid: null }> {
    if (!this.sandboxReady) {
      const sandbox = await probeSandboxRunner();
      if (!sandbox.available)
        throw new Error('Real Codex soak requires the managed sandbox runner');
      this.harness.setCommandSandboxAvailable(true);
      this.sandboxReady = true;
    }
    return { pid: null };
  }

  async execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
    workspacePath?: string | null;
    onEvent?: Parameters<TeamWorkerRuntime['execute']>[0]['onEvent'];
    signal?: AbortSignal;
  }): Promise<WorkerRuntimeResult> {
    const startedAt = Date.now();
    await this.start();
    const model = input.worker.modelSelection.requestedModel;
    if (model === null || model === 'auto')
      throw new Error('Soak requires an explicit Codex model');
    if (input.signal?.aborted === true) throw input.signal.reason;
    const prompt = [
      'You are a Sprint Coder durability-test Worker.',
      'Use only the supplied managed tools for workspace access.',
      'For a long command call exec_command with background true, then call poll_command until state is exited and exitCode is 0.',
      'Do not report success from prose or elapsed time; a terminal managed command result is mandatory.',
      `Requested step:\n${input.content}`,
    ].join('\n\n');
    const executionWorkspace = input.workspacePath ?? this.workspacePath;
    this.persistence.setWorkspace(this.taskId, executionWorkspace);
    const persistedTurn = this.persistence.startTurn(this.taskId, prompt);
    const turnId = persistedTurn.turnId;
    const policyEpoch = this.persistence.getPermissionPolicy(this.taskId).policyEpoch;
    const snapshot = this.harness.startTurn(
      {
        taskId: this.taskId,
        turnId,
        workspaceId: this.persistence.readTurnWorkspaceSet(turnId)?.digest ?? null,
        policyEpoch,
      },
      'codex',
    );
    const managedCalls: Array<{ name: string; output: unknown }> = [];
    this.active.set(input.worker.id, { turnId, executionWorkspace });
    const abortFromCaller = (): void => {
      void this.stop(input.worker.id);
    };
    input.signal?.addEventListener('abort', abortFromCaller, { once: true });
    let heartbeat: NodeJS.Timeout | undefined;
    let completedSuccessfully = false;
    try {
      const summary = await new Promise<string>((resolve, reject) => {
        let output = '';
        let settled = false;
        const finish = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          if (heartbeat !== undefined) clearInterval(heartbeat);
          callback();
        };
        heartbeat = setInterval(
          () => input.onEvent?.({ type: 'heartbeat', at: new Date().toISOString() }),
          15_000,
        );
        heartbeat.unref();
        this.adapter.start(
          turnId,
          prompt,
          [],
          () => input.onEvent?.({ type: 'accepted', at: new Date().toISOString() }),
          input.workspacePath ?? this.workspacePath,
          model,
          (event) => {
            if (event.type === 'stage') {
              this.persistence.changeStage(this.taskId, turnId, event.stage);
              input.onEvent?.({
                type: 'activity',
                phase: event.stage,
                label: event.stage,
                at: new Date().toISOString(),
              });
            }
            if (event.type === 'operation')
              input.onEvent?.({
                type: 'activity',
                phase: event.phase,
                label: event.label,
                at: new Date().toISOString(),
              });
            if (event.type === 'delta') {
              output += event.delta;
              input.onEvent?.({ type: 'outputDelta', text: event.delta });
            }
            if (event.type === 'reasoning')
              input.onEvent?.({ type: 'reasoningPresence', active: true });
            if (event.type === 'completed')
              finish(() => {
                input.onEvent?.({ type: 'completed' });
                resolve(event.finalText?.trim() || output.trim() || 'Codex step completed');
              });
          },
          (error) =>
            finish(() => {
              input.onEvent?.({ type: 'failed', error: error.userMessage });
              reject(new Error(error.userMessage));
            }),
          (code, canceled) => {
            if (!settled && (canceled || code !== 0))
              finish(() => reject(new Error(`Codex exited: code=${code}, canceled=${canceled}`)));
          },
          undefined,
          'high',
          input.worker.writeCapable ? 'workspace-write' : 'read-only',
          [],
          [],
          undefined,
          undefined,
          { inheritUserConfig: false },
          undefined,
          snapshot,
          async ({ callId, toolName, arguments: toolInput }) => {
            try {
              const output = await this.harness.broker.dispatch({
                taskId: this.taskId,
                turnId,
                callId,
                providerName: toolName,
                input: toolInput,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
              });
              managedCalls.push({ name: toolName, output });
              return { success: true, output };
            } catch (error) {
              console.error(
                '[real-codex-soak] managed tool failed:',
                error instanceof Error ? error.message : String(error),
              );
              throw error;
            }
          },
        );
      });
      if (!hasTerminalManagedCommand(managedCalls)) {
        console.error(
          '[real-codex-soak] no terminal command evidence:',
          JSON.stringify(managedCalls.map(({ name, output }) => managedCallSummary(name, output))),
        );
        throw new Error('Codex soak Worker completed without terminal managed command evidence');
      }
      completedSuccessfully = true;
      return {
        claims: {
          deliveryId: input.envelope.deliveryId,
          sourceAgentId: input.envelope.sourceAgentId,
          targetAgentId: input.envelope.targetAgentId,
        },
        completion: {
          status: 'succeeded',
          summary,
          artifacts: [],
          verification: [{ name: 'real-codex-soak-managed-command', outcome: 'pass' }],
          risks: [],
        },
        resolution: { resolvedProvider: 'openai', resolvedModel: model },
        usage: {
          costCents: 0,
          tokens: Math.max(1, Math.ceil(summary.length / 4)),
          timeMs: Date.now() - startedAt,
          toolCalls: managedCalls.length,
        },
      };
    } finally {
      input.signal?.removeEventListener('abort', abortFromCaller);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (this.active.get(input.worker.id)?.turnId === turnId) this.active.delete(input.worker.id);
      this.harness.finishTurn(this.taskId, turnId);
      if (this.persistence.getActiveTurnId(this.taskId) === turnId)
        this.persistence.completeTurn(
          this.taskId,
          turnId,
          completedSuccessfully ? 'completed' : input.signal?.aborted ? 'canceled' : 'failed',
        );
      if (executionWorkspace !== this.workspacePath)
        this.persistence.setWorkspace(this.taskId, this.workspacePath);
    }
  }

  async stop(agentId: string): Promise<void> {
    const active = this.active.get(agentId);
    if (active === undefined) return;
    await this.harness.policyEpochChanged(this.taskId);
    const forced = await this.adapter.cancel(active.turnId).finally(() => {
      if (active.executionWorkspace !== this.workspacePath)
        this.persistence.setWorkspace(this.taskId, this.workspacePath);
    });
    this.active.delete(agentId);
    if (forced) throw new Error('Codex process tree stop was not confirmed');
  }

  async dispose(): Promise<void> {
    for (const agentId of [...this.active.keys()]) await this.stop(agentId);
    this.adapter.dispose();
    await this.harness.dispose();
  }
}

function hasTerminalManagedCommand(calls: readonly { name: string; output: unknown }[]): boolean {
  return calls.some(({ name, output }) => {
    if (name !== 'exec_command' && name !== 'poll_command') return false;
    if (typeof output !== 'object' || output === null) return false;
    const result = output as Record<string, unknown>;
    if (result['exitCode'] === 0) return true;
    const nested = result['result'];
    return (
      result['state'] === 'exited' &&
      typeof nested === 'object' &&
      nested !== null &&
      (nested as Record<string, unknown>)['exitCode'] === 0
    );
  });
}

function managedCallSummary(name: string, output: unknown): Record<string, unknown> {
  const result =
    typeof output === 'object' && output !== null ? (output as Record<string, unknown>) : {};
  const nested =
    typeof result['result'] === 'object' && result['result'] !== null
      ? (result['result'] as Record<string, unknown>)
      : {};
  return {
    name,
    state: result['state'] ?? null,
    exitCode: result['exitCode'] ?? null,
    nestedExitCode: nested['exitCode'] ?? null,
  };
}

const suite = enabled ? describe : describe.skip;

suite('real Codex Mission durability soak', () => {
  it(
    'survives a 60+ minute Mission with timeout, restart, and manual resume',
    async () => {
      if (!electronChild) {
        const result = await runElectronTest(
          electronTestExecutablePath(),
          [
            join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
            'run',
            'src/main/team-codex-mission-soak.test.ts',
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: '1',
              SPRINT_CODER_ELECTRON_DB_TEST: '1',
              SPRINT_CODER_TEAM_CODEX_ONLY: '1',
            },
            timeout: 95 * 60_000,
          },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        return;
      }

      expect(process.env['SPRINT_CODER_TEAM_CODEX_ONLY']).toBe('1');
      const model = process.env['SPRINT_CODER_SOAK_CODEX_MODEL'] ?? 'gpt-5.6-sol';
      const probe = await probeCodex();
      expect(probe.available).toBe(true);
      expect(probe.models.some(({ id }) => id === model)).toBe(true);
      const continuationRoot = process.env['SPRINT_CODER_SOAK_CONTINUE_ROOT'];
      if (continuationRoot !== undefined) {
        await continueExistingSoak(continuationRoot, model);
        return;
      }

      const root = mkdtempSync(join(tmpdir(), 'sprint-coder-codex-soak-'));
      roots.push(root);
      const workspacePath = join(root, 'workspace');
      const dbPath = join(root, 'soak.sqlite3');
      mkdirSync(workspacePath);
      const workspace = realpathSync.native(workspacePath);
      writeFileSync(
        join(workspace, 'soak-delay.mjs'),
        `const ms = ${SOAK_SHARD_MS};\nsetTimeout(() => console.log('delay complete', process.argv[2]), ms);\n`,
      );
      writeFileSync(
        join(workspace, 'soak-timeout-once.mjs'),
        [
          "import { existsSync, writeFileSync } from 'node:fs';",
          "const marker = 'soak-timeout.marker';",
          "if (existsSync(marker)) console.log('resume detected; timeout step complete');",
          'else {',
          "  writeFileSync(marker, 'partial write preserved\\n');",
          '  setInterval(() => {}, 60_000);',
          '}',
        ].join('\n'),
      );
      expect(runGit(workspace, ['init']).status).toBe(0);
      expect(runGit(workspace, ['add', '.']).status).toBe(0);
      expect(
        runGit(workspace, [
          '-c',
          'user.name=Sprint Coder Soak',
          '-c',
          'user.email=soak@example.invalid',
          'commit',
          '-m',
          'soak fixture',
        ]).status,
      ).toBe(0);

      const startedAt = Date.now();
      const timeoutProcessBaseline = liveSoakTimeoutProcessCount();
      let persistence = new SqlitePersistenceClient(dbPath);
      persistence.setRuntime('codex');
      persistence.setModel(model);
      const task = persistence.createTask('Real Codex 60 minute Mission');
      persistence.setWorkspace(task.id, workspace);
      let runtime = new DirectCodexTeamRuntime(persistence, task.id, workspace);
      const worktreesRoot = join(root, 'team-worker-worktrees');
      const createCoordinator = () =>
        new TeamCoordinator(
          persistence,
          runtime,
          undefined,
          undefined,
          SOAK_HARD_TIMEOUT_MS,
          undefined,
          undefined,
          undefined,
          new WorkerWorktreeManager({ worktreesRoot }),
        );
      let coordinator = createCoordinator();
      const hireWorker = (role: string, writeCapable: boolean) =>
        coordinator.hireWorker({
          taskId: task.id,
          role,
          objective: '耐久Missionを正確に実行する',
          contextInheritancePolicy: 'none',
          writeCapable,
        });
      const [readWorker, writeWorker, testWorker1, testWorker2, testWorker3, timeoutWorker] =
        await Promise.all([
          hireWorker('CodexコマンドWorker', true),
          hireWorker('Codex書き込みWorker', true),
          hireWorker('Codex長時間テストWorker 1', true),
          hireWorker('Codex長時間テストWorker 2', true),
          hireWorker('Codex長時間テストWorker 3', true),
          hireWorker('CodexタイムアウトWorker', true),
        ]);
      const delayStep = (workerId: string, name: string) => ({
        workerId,
        objective: `Call exec_command with executable ${JSON.stringify(SOAK_SHELL_EXECUTABLE)}, argv ["-c", ${JSON.stringify(`sleep ${(SOAK_SHARD_MS / 1000).toFixed(3)}; printf 'delay complete ${name}\\n'`)}], purpose ${JSON.stringify(`Run ${name} durability delay`)}, background true. Then call poll_command for the returned sessionId until state is exited and result.exitCode is 0.`,
        doneCriteria: [`${name} delay exited successfully`],
        access: 'workspace-write' as const,
      });
      const verificationCommand =
        `test "$(cat soak-output.txt)" = 'codex workspace write verified' && ` +
        'test -f soak-timeout.marker && /usr/bin/git diff --check';
      const mission = await coordinator.assignMission({
        taskId: task.id,
        objective: 'Validate long-running Codex Team durability',
        doneCriteria: ['All durability boundaries are verified'],
        steps: [
          delayStep(readWorker.id, 'read'),
          {
            workerId: writeWorker.id,
            objective: `Call exec_command once with executable ${JSON.stringify(SOAK_SHELL_EXECUTABLE)}, argv ["-c", "printf 'codex workspace write verified\\n' > soak-output.txt"], purpose "Create the soak output fixture", verification true. Require exitCode 0.`,
            doneCriteria: ['soak-output.txt has the expected content'],
            access: 'workspace-write',
          },
          delayStep(testWorker1.id, 'long-test-1'),
          delayStep(testWorker2.id, 'long-test-2'),
          delayStep(testWorker3.id, 'long-test-3'),
          {
            workerId: timeoutWorker.id,
            objective: `Call exec_command with executable ${JSON.stringify(SOAK_SHELL_EXECUTABLE)}, argv ["-c", "if [ -f soak-timeout.marker ]; then printf 'resume detected; timeout step complete\\n'; else printf 'partial write preserved\\n' > soak-timeout.marker; while :; do sleep 60; done; fi"], purpose "Exercise timeout and resume", background true. Poll until terminal and do not claim success while it is running.`,
            doneCriteria: ['the preserved marker makes the resumed invocation exit'],
            access: 'workspace-write',
          },
          {
            workerId: writeWorker.id,
            objective: `Call exec_command once with executable ${JSON.stringify(SOAK_SHELL_EXECUTABLE)}, argv ["-c", ${JSON.stringify(verificationCommand)}], purpose "Verify soak artifacts and git diff", verification true. Require exitCode 0.`,
            doneCriteria: ['both files and git diff are verified'],
            access: 'workspace-write',
          },
        ],
      });

      await waitFor(
        () => persistence.getTeamMission(mission.id).state === 'waiting_resume',
        SOAK_WAITING_RESUME_TIMEOUT_MS,
      );
      const waitingMission = persistence.getTeamMission(mission.id);
      expect(waitingMission.currentStepOrdinal).toBe(6);
      const timeoutStep = waitingMission.steps.find(({ ordinal }) => ordinal === 6);
      expect(timeoutStep).toBeDefined();
      expect(persistence.listTeamAttempts(timeoutStep!.executionId).at(-1)?.terminalReason).toBe(
        'hard_timeout',
      );
      const timeoutWorktree = persistence.getTeamMissionWorktree(timeoutStep!.executionId);
      expect(timeoutWorktree).toMatchObject({ state: 'quarantined' });
      expect(existsSync(join(timeoutWorktree!.path, 'soak-timeout.marker'))).toBe(true);
      expect(existsSync(join(workspace, 'soak-timeout.marker'))).toBe(false);
      await waitFor(() => liveSoakTimeoutProcessCount() <= timeoutProcessBaseline, 5_000);
      await runtime.dispose();
      persistence.close();

      persistence = new SqlitePersistenceClient(dbPath);
      persistence.initializeMutationRecovery('real-codex-soak-restart', new Date().toISOString());
      runtime = new DirectCodexTeamRuntime(persistence, task.id, workspace);
      coordinator = createCoordinator();
      coordinator.recoverOnStartup();
      expect(persistence.getTeamMission(mission.id).state).toBe('waiting_resume');
      await coordinator.resumeMission(task.id, mission.id);
      await waitFor(
        () => persistence.getTeamMission(mission.id).state === 'completed',
        10 * 60_000,
      );

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(SOAK_MINIMUM_MS);
      expect(auditCodexOnlyTeam(persistence, mission.teamId)).toMatchObject({
        ok: true,
        violations: [],
      });
      expect(persistence.checkTeamIntegrity()).toEqual({
        sqlite: 'ok',
        inconsistencies: [],
      });
      expect(existsSync(join(workspace, 'soak-output.txt'))).toBe(true);
      console.log(
        JSON.stringify({
          kind: 'real-codex-team-soak',
          elapsedMs: Date.now() - startedAt,
          missionId: mission.id,
          codexAudit: auditCodexOnlyTeam(persistence, mission.teamId),
          integrity: persistence.checkTeamIntegrity(),
        }),
      );
      await runtime.dispose();
      persistence.close();
    },
    100 * 60_000,
  );
});

function durationFromEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 100) throw new Error(`${name} is invalid`);
  return parsed;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for soak condition');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function continueExistingSoak(root: string, model: string): Promise<void> {
  const workspace = realpathSync.native(join(root, 'workspace'));
  const dbPath = join(root, 'soak.sqlite3');
  let persistence = new SqlitePersistenceClient(dbPath);
  persistence.initializeMutationRecovery('real-codex-soak-continuation', new Date().toISOString());
  const task = persistence.listTasks()[0];
  if (task === undefined) throw new Error('Soak continuation Task not found');
  const team = persistence.getTeamByTask(task.id);
  if (team === null) throw new Error('Soak continuation Team not found');
  const mission = persistence.listTeamMissions(team.id)[0];
  if (mission === undefined) throw new Error('Soak continuation Mission not found');
  let runtime = new DirectCodexTeamRuntime(persistence, task.id, workspace);
  const worktreesRoot = join(root, 'team-worker-worktrees');
  const createCoordinator = () =>
    new TeamCoordinator(
      persistence,
      runtime,
      undefined,
      undefined,
      SOAK_HARD_TIMEOUT_MS,
      undefined,
      undefined,
      undefined,
      new WorkerWorktreeManager({ worktreesRoot }),
    );
  let coordinator = createCoordinator();
  coordinator.recoverOnStartup();
  if (mission.state === 'completed') {
    verifyCompletedSoak(persistence, mission, model);
    await runtime.dispose();
    persistence.close();
    return;
  }
  const timeoutProcessBaseline = liveSoakTimeoutProcessCount();
  await coordinator.resumeMission(task.id, mission.id);
  await waitFor(() => {
    const current = persistence.getTeamMission(mission.id);
    if (current.state !== 'waiting_resume' || current.currentStepOrdinal !== 6) return false;
    const timeoutStep = current.steps.find(({ ordinal }) => ordinal === 6);
    return (
      timeoutStep !== undefined &&
      persistence.listTeamAttempts(timeoutStep.executionId).at(-1)?.terminalReason ===
        'hard_timeout'
    );
  }, 35 * 60_000);
  const interrupted = persistence.getTeamMission(mission.id);
  const interruptedStep = interrupted.steps.find(({ ordinal }) => ordinal === 6);
  const interruptedWorktree =
    interruptedStep === undefined
      ? null
      : persistence.getTeamMissionWorktree(interruptedStep.executionId);
  expect(interruptedWorktree).toMatchObject({ state: 'quarantined' });
  expect(existsSync(join(interruptedWorktree!.path, 'soak-timeout.marker'))).toBe(true);
  await waitFor(() => liveSoakTimeoutProcessCount() <= timeoutProcessBaseline, 5_000);
  await runtime.dispose();
  persistence.close();

  persistence = new SqlitePersistenceClient(dbPath);
  persistence.initializeMutationRecovery(
    'real-codex-soak-continuation-restart',
    new Date().toISOString(),
  );
  runtime = new DirectCodexTeamRuntime(persistence, task.id, workspace);
  coordinator = createCoordinator();
  coordinator.recoverOnStartup();
  expect(persistence.getTeamMission(mission.id).state).toBe('waiting_resume');
  await coordinator.resumeMission(task.id, mission.id);
  await waitFor(() => persistence.getTeamMission(mission.id).state === 'completed', 10 * 60_000);

  verifyCompletedSoak(persistence, mission, model);
  await runtime.dispose();
  persistence.close();
}

function verifyCompletedSoak(
  persistence: SqlitePersistenceClient,
  mission: ReturnType<SqlitePersistenceClient['getTeamMission']>,
  model: string,
): void {
  const elapsedMs = Date.now() - new Date(mission.createdAt).getTime();
  expect(persistence.getTeamMission(mission.id).state).toBe('completed');
  expect(elapsedMs).toBeGreaterThanOrEqual(SOAK_MINIMUM_MS);
  expect(auditCodexOnlyTeam(persistence, mission.teamId)).toMatchObject({
    ok: true,
    violations: [],
  });
  expect(persistence.checkTeamIntegrity()).toEqual({
    sqlite: 'ok',
    inconsistencies: [],
  });
  console.log(
    JSON.stringify({
      kind: 'real-codex-team-soak-continuation',
      elapsedMs,
      missionId: mission.id,
      model,
      codexAudit: auditCodexOnlyTeam(persistence, mission.teamId),
      integrity: persistence.checkTeamIntegrity(),
    }),
  );
}

function runGit(workspace: string, args: readonly string[]) {
  return spawnSync('git', ['-C', workspace, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function liveSoakTimeoutProcessCount(): number {
  if (process.platform === 'win32') return 0;
  const result = spawnSync('pgrep', ['-f', 'node soak-timeout-once.mjs'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.status !== 0) return 0;
  return result.stdout.split('\n').filter((line) => line.trim() !== '').length;
}

function runElectronTest(
  executable: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
  }>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-4 * 1024 * 1024);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4 * 1024 * 1024);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}
