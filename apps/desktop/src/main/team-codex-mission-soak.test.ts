import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

const enabled = process.env['SPRINT_CODER_RUN_CODEX_SOAK'] === '1';
const electronChild = process.env['SPRINT_CODER_ELECTRON_DB_TEST'] === '1';
const roots: string[] = [];
// Four long real-Codex steps plus the 30-minute absolute timeout must exceed one hour.
const SOAK_SHARD_MS = 7 * 60_000 + 30_000;
const SOAK_MINIMUM_MS = 60 * 60_000;

afterAll(() => {
  if (process.env['SPRINT_CODER_KEEP_SOAK_ARTIFACTS'] === '1') return;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class DirectCodexTeamRuntime implements TeamWorkerRuntime {
  private readonly adapter = new CodexRuntimeAdapter(60 * 60_000);
  private readonly active = new Map<string, string>();

  constructor(private readonly workspacePath: string) {}

  async start(): Promise<{ pid: null }> {
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
    const turnId = randomUUID();
    const model = input.worker.modelSelection.requestedModel;
    if (model === null || model === 'auto')
      throw new Error('Soak requires an explicit Codex model');
    if (input.signal?.aborted === true) throw input.signal.reason;
    this.active.set(input.worker.id, turnId);
    const abortFromCaller = (): void => {
      void this.adapter.cancel(turnId);
    };
    input.signal?.addEventListener('abort', abortFromCaller, { once: true });
    let heartbeat: NodeJS.Timeout | undefined;
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
          [
            'You are a Sprint Coder durability-test Worker.',
            'Execute the requested workspace command exactly and wait for it to finish.',
            'Do not shorten, background, or replace intentional delays.',
            `Requested step:\n${input.content}`,
          ].join('\n\n'),
          [],
          () => input.onEvent?.({ type: 'accepted', at: new Date().toISOString() }),
          input.workspacePath ?? this.workspacePath,
          model,
          (event) => {
            if (event.type === 'stage')
              input.onEvent?.({
                type: 'activity',
                phase: event.stage,
                label: event.stage,
                at: new Date().toISOString(),
              });
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
            if (event.type === 'fileChange')
              input.onEvent?.({ type: 'fileChange', changes: event.changes });
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
        );
      });
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
          verification: [{ name: 'real-codex-soak', outcome: 'pass' }],
          risks: [],
        },
        resolution: { resolvedProvider: 'openai', resolvedModel: model },
        usage: {
          costCents: 0,
          tokens: Math.max(1, Math.ceil(summary.length / 4)),
          timeMs: Date.now() - startedAt,
          toolCalls: 1,
        },
      };
    } finally {
      input.signal?.removeEventListener('abort', abortFromCaller);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (this.active.get(input.worker.id) === turnId) this.active.delete(input.worker.id);
    }
  }

  async stop(agentId: string): Promise<void> {
    const turnId = this.active.get(agentId);
    if (turnId === undefined) return;
    const forced = await this.adapter.cancel(turnId);
    if (forced) throw new Error('Codex process tree stop was not confirmed');
    this.active.delete(agentId);
  }

  async dispose(): Promise<void> {
    for (const agentId of [...this.active.keys()]) await this.stop(agentId);
    this.adapter.dispose();
  }
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
      const workspace = join(root, 'workspace');
      const dbPath = join(root, 'soak.sqlite3');
      mkdirSync(workspace);
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
      let runtime = new DirectCodexTeamRuntime(workspace);
      const worktreesRoot = join(root, 'team-worker-worktrees');
      const createCoordinator = () =>
        new TeamCoordinator(
          persistence,
          runtime,
          undefined,
          undefined,
          undefined,
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
          hireWorker('Codex読み取りWorker', false),
          hireWorker('Codex書き込みWorker', true),
          hireWorker('Codex長時間テストWorker 1', false),
          hireWorker('Codex長時間テストWorker 2', false),
          hireWorker('Codex長時間テストWorker 3', false),
          hireWorker('CodexタイムアウトWorker', true),
        ]);
      const delayStep = (workerId: string, name: string) => ({
        workerId,
        objective: `Run node soak-delay.mjs ${name} and wait for the process to exit.`,
        doneCriteria: [`${name} delay exited successfully`],
        access: 'read-only' as const,
      });
      const mission = await coordinator.assignMission({
        taskId: task.id,
        objective: 'Validate long-running Codex Team durability',
        doneCriteria: ['All durability boundaries are verified'],
        steps: [
          delayStep(readWorker.id, 'read'),
          {
            workerId: writeWorker.id,
            objective:
              "Create soak-output.txt containing exactly 'codex workspace write verified\\n'.",
            doneCriteria: ['soak-output.txt has the expected content'],
            access: 'workspace-write',
          },
          delayStep(testWorker1.id, 'long-test-1'),
          delayStep(testWorker2.id, 'long-test-2'),
          delayStep(testWorker3.id, 'long-test-3'),
          {
            workerId: timeoutWorker.id,
            objective: 'Run node soak-timeout-once.mjs and wait for the process to exit.',
            doneCriteria: ['the preserved marker makes the resumed invocation exit'],
            access: 'workspace-write',
          },
          {
            workerId: writeWorker.id,
            objective:
              'Verify soak-output.txt, soak-timeout.marker, git diff --check, and report the results.',
            doneCriteria: ['both files and git diff are verified'],
            access: 'read-only',
          },
        ],
      });

      await waitFor(
        () => persistence.getTeamMission(mission.id).state === 'waiting_resume',
        82 * 60_000,
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
      runtime = new DirectCodexTeamRuntime(workspace);
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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for soak condition');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function continueExistingSoak(root: string, model: string): Promise<void> {
  const workspace = join(root, 'workspace');
  const dbPath = join(root, 'soak.sqlite3');
  let persistence = new SqlitePersistenceClient(dbPath);
  persistence.initializeMutationRecovery('real-codex-soak-continuation', new Date().toISOString());
  const task = persistence.listTasks()[0];
  if (task === undefined) throw new Error('Soak continuation Task not found');
  const team = persistence.getTeamByTask(task.id);
  if (team === null) throw new Error('Soak continuation Team not found');
  const mission = persistence.listTeamMissions(team.id)[0];
  if (mission === undefined) throw new Error('Soak continuation Mission not found');
  let runtime = new DirectCodexTeamRuntime(workspace);
  const worktreesRoot = join(root, 'team-worker-worktrees');
  const createCoordinator = () =>
    new TeamCoordinator(
      persistence,
      runtime,
      undefined,
      undefined,
      undefined,
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
  runtime = new DirectCodexTeamRuntime(workspace);
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
