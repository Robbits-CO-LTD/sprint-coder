import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { assignCurrentTaskToProjectFolder, firstWindow, launchApp } from './helpers';
import {
  CLAUDE,
  CODEX,
  REAL_AI_ENABLED,
  REAL_RUNTIME_ENV,
  WORKSPACE_ROOT,
  collectRendererErrors,
  isStopVisible,
  makeDir,
  normalize,
  note,
  readText,
  recordMainLog,
  selectModel,
  setAccess,
  shot,
  shutdown,
  type Provider,
} from './real-ai-helpers';
import { parseWorkerEvents, runningConcurrency } from './real-ai-team-concurrency';

// 本物の Claude Code CLI / Codex CLI（ユーザーのサブスク）で、Team の大人数同時編集を確かめる opt-in の
// スペック。Leader（本物の AI）に Worker 32 人（Claude 16 / Codex 16）を雇わせ、各 Worker に別々の
// ファイルを書かせる。各 Worker が自分の worktree を持つこと、実行が時間的に重なること、統合後に
// 32 ファイルが正しく揃うことを測る。2 つ目は 4 人（Claude 2 / Codex 2）に同じファイルの別の節を
// 同時に編集させ、App がどう扱うか（直列化・衝突検知・失敗）を記録する。実課金が発生するので CI では
// 必ず skip される。
//
//   $env:SPRINT_CODER_REAL_AI_E2E = '1'
//   $env:SPRINT_CODER_E2E_MODE = 'dev'
//   npx playwright test tests/e2e/real-ai-team-scale.spec.ts --config playwright.dev.config.ts
//
// Leader: SPRINT_CODER_REAL_AI_TEAM_LEADER=claude（既定）| codex
// 人数:   SPRINT_CODER_REAL_AI_TEAM_SIZE=32（既定、偶数）
// 予算:   SPRINT_CODER_REAL_AI_TEAM_BUDGET=unlimited で既定の Team ポリシーを予算無制限にする。

const LEADER: Provider =
  process.env['SPRINT_CODER_REAL_AI_TEAM_LEADER'] === 'codex' ? CODEX : CLAUDE;
const TEAM_SIZE = Number(process.env['SPRINT_CODER_REAL_AI_TEAM_SIZE'] ?? 32);
const BUDGET_UNLIMITED = process.env['SPRINT_CODER_REAL_AI_TEAM_BUDGET'] === 'unlimited';
// 32 人のうち、同時に作業中（isolation の phase が running）だった人数の下限。
const MIN_CONCURRENT = Number(process.env['SPRINT_CODER_REAL_AI_TEAM_MIN_CONCURRENT'] ?? 30);
const ROWS = 60;
/** 衝突シナリオで、両方の Worker の worktree が揃ってから置く「編集してよい」の目印。 */
const GO_MARKER = '.sc-go';
/** Leader に指定する最終行の形式。`<token> completed=<n> failed=<n>`。 */
const FINAL_LINE = (token: string): RegExp =>
  // One pair of backticks around the line still counts: the prompt shows the format that way.
  new RegExp(`^(\`?)${token} completed=(\\d+) failed=(\\d+)\\1\\s*$`, 'gm');
// 各 Worker にファイルを 31 回に分けて書かせ、1 人の作業時間を数分に延ばす。Leader は割り当てを
// 1 件ずつ（数秒おきに）出すので、30 秒ほどで終わる作業では 30 人が同時に動く瞬間が作れない。
// 0 を指定すると 1 回で書かせる（割り当ての速さを見るとき）。
const SLOW_WRITE = process.env['SPRINT_CODER_REAL_AI_TEAM_SLOW'] !== '0';
const SLOW_NOTE = SLOW_WRITE
  ? ' Build the file in 31 separate steps: first create it with only the first line; then, 30 times, read the file back with read_file and rewrite it adding the next 2 rows. Do not write more than 2 new rows per step.'
  : '';
const pad = (n: number): string => String(n).padStart(2, '0');
/** Worker NN が書くファイルの正しい中身。重なりを作るため、短すぎない量（61 行）にする。 */
function expectedWorkerFile(index: number, provider: string): string {
  const rows = Array.from(
    { length: ROWS },
    (_, i) => `W${pad(index)} row ${String(i + 1).padStart(2, '0')}`,
  );
  return `${[`SC_FILE_${pad(index)}_${provider}`, ...rows].join('\n')}\n`;
}
const OVERALL_MS = 40 * 60_000;
const TERMINAL_EXECUTION = new Set(['completed', 'failed', 'canceled']);

type Selection = Readonly<{
  connectionId: string;
  requestedProvider: string;
  requestedModel: string;
}>;
type Assignment = Readonly<{
  index: number;
  role: string;
  provider: 'claude' | 'codex';
  selection: Selection;
  objective: string;
  criterion: string;
}>;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function tryGit(cwd: string, ...args: string[]): string {
  try {
    return git(cwd, ...args);
  } catch (error) {
    return `ERROR: ${String(error).slice(0, 300)}`;
  }
}

function commit(cwd: string, message: string): void {
  git(cwd, 'add', '.');
  git(
    cwd,
    '-c',
    'user.name=realai',
    '-c',
    'user.email=realai@example.invalid',
    'commit',
    '-q',
    '-m',
    message,
  );
}

/** README / src / shared/index.md を持つ新しい git リポジトリ。 */
function makeTeamWorkspace(label: string, sections: number): string {
  const root = makeDir(`realai-ws-${label}`, WORKSPACE_ROOT);
  if (/[\\/]appdata[\\/]/i.test(root))
    throw new Error(`workspace must live outside AppData (classified app-private): ${root}`);
  writeFileSync(join(root, 'README.md'), '# Team scale workspace\n\nOriginal line.\n');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'README.md'), 'Worker output files live here.\n');
  mkdirSync(join(root, 'shared'));
  const body = Array.from(
    { length: sections },
    (_, i) => `## Section ${i + 1}\n\nTODO-${i + 1}\n`,
  ).join('\n');
  writeFileSync(join(root, 'shared', 'index.md'), `# Shared index\n\n${body}`);
  git(root, 'init', '-q', '-b', 'main');
  // 衝突シナリオの同期用の目印（GO_MARKER）は git に無視させる。info/exclude は worktree と共有され、
  // status にも出ないので、App の「作業場所がきれいか」の確認や Worker の変更に混ざらない。
  writeFileSync(join(root, '.git', 'info', 'exclude'), `${GO_MARKER}\n`, { flag: 'a' });
  commit(root, 'init');
  return root;
}

async function catalogSelection(
  page: Page,
  taskId: string,
  provider: Provider,
): Promise<Selection> {
  const catalog = await page.evaluate(
    async ({ id, text }) =>
      (
        await window.sprintCoder!.models.query({ taskId: id, text, availableOnly: true } as never)
      ).items.map((item) => ({
        connectionId: item.connectionId,
        providerId: item.providerId,
        modelId: item.modelId,
        via: `${item.providerDisplayName ?? ''} ${item.connectionDisplayName ?? ''}`,
      })),
    { id: taskId, text: provider.search },
  );
  console.info(`[real-ai] team-scale ${provider.name} catalog`, JSON.stringify(catalog));
  const viaCli = catalog.filter((item) => provider.via.test(item.via));
  const pool = viaCli.length > 0 ? viaCli : catalog;
  const modelId = provider.pick(pool.map((item) => item.modelId));
  const chosen = pool.find((item) => item.modelId === modelId);
  expect(chosen, `no ${provider.name} worker model in the catalog`).toBeTruthy();
  return {
    connectionId: chosen!.connectionId,
    requestedProvider: chosen!.providerId,
    requestedModel: chosen!.modelId,
  };
}

function leaderPrompt(
  title: string,
  assignments: readonly Assignment[],
  finalToken: string,
): string {
  const rows = assignments.map(
    (a) =>
      `- role "${a.role}" | modelSelection ${JSON.stringify(a.selection)} | objective: ${a.objective} | doneCriteria: ["${a.criterion}"]`,
  );
  return [
    `This is an automated ${title} of team mode. Follow these steps exactly and use only the team tools; never create or edit any file yourself.`,
    '1. Call team_list_models once (no filters needed). It is required before hiring.',
    `2. Hire exactly ${assignments.length} workers with team_hire_worker: agentKind "worker", writeCapable true, contextInheritancePolicy "summary", modelSelectionReason "Scale test requested by the user: half the workers use Claude and half use Codex", and exactly the role and modelSelection listed below for each worker. Do not change the model of any worker. Issue the hire calls in parallel (many tool calls in one message). Do not assign any task until every worker is hired.`,
    '3. After all workers are hired, call team_assign_tasks once with one entry in assignments for every worker, each with access "workspace-write" and exactly the objective and doneCriteria listed for its role, so that all workers run at the same time. Do not wait for any task to finish. If an assignment is reported as queued, that is fine; do not repeat it. Repeat only the entries whose results[].ok is false.',
    `4. Then call team_wait_reports repeatedly until all ${assignments.length} workers have reported. Do not retry, reassign or steer any task.`,
    `5. Finally end your reply with exactly one line in this exact format, with nothing else on that line: \`${finalToken} completed=<number of completed tasks> failed=<number of failed tasks>\` (for example \`${finalToken} completed=3 failed=0\`). Count a task as failed when its report is failed or it is waiting_resume.`,
    'Workers:',
    ...rows,
  ].join('\n');
}

type ExecutionTrack = {
  id: string;
  assignee: string;
  firstSeenAt: number;
  runningFrom: number | null;
  runningTo: number | null;
  terminalAt: number | null;
  states: string[];
  phases: string[];
  worktreePaths: string[];
  queueReasons: string[];
  terminalReason: string | null;
};

type TeamSnapshot = Readonly<{
  workers: readonly {
    id: string;
    kind: string;
    role: string;
    state: string;
    engine: string;
    requestedProvider: string | null;
    requestedModel: string | null;
    writeCapable: boolean;
  }[];
  executions: readonly {
    id: string;
    assigneeAgentId: string;
    state: string;
    queueReason: string | null;
    terminalReason: string | null;
    attemptStartReason: string | null;
    requestedModel: string | null;
    phase: string | null;
    worktreePaths: string[];
    baseHeads: string[];
    changedFiles: string[];
    isolationReason: string | null;
  }[];
  leaderMessages: readonly { source: string; content: string }[];
  activities: readonly { seq: number; type: string; summary: string }[];
  policy: unknown;
  budgets: unknown;
}>;

async function readTeam(page: Page, taskId: string): Promise<TeamSnapshot | null> {
  return page.evaluate(async (id) => {
    const detail = await window.sprintCoder!.teams.get(id);
    if (!detail) return null;
    return {
      workers: detail.workers.map((w) => ({
        id: w.id,
        kind: w.kind,
        role: w.role,
        state: w.state,
        engine: w.engine,
        requestedProvider: w.requestedProvider,
        requestedModel: w.requestedModel,
        writeCapable: w.writeCapable,
      })),
      executions: detail.executions.map((e) => ({
        id: e.id,
        assigneeAgentId: e.assigneeAgentId,
        state: e.state,
        queueReason: e.queueReason,
        terminalReason: e.terminalReason,
        attemptStartReason: e.attemptStartReason,
        requestedModel: e.requestedModel,
        phase: e.isolation?.phase ?? null,
        worktreePaths: (e.isolation?.repositories ?? []).map((r) => r.worktreePath),
        baseHeads: (e.isolation?.repositories ?? []).map((r) => r.baseHead),
        changedFiles: (e.isolation?.repositories ?? []).flatMap((r) => r.changedFiles),
        isolationReason: e.isolation?.reason ?? null,
      })),
      leaderMessages: detail.messages
        .filter((m) => m.targetKind === 'leader')
        .map((m) => ({ source: m.sourceAgentId, content: m.content.slice(0, 4_000) })),
      activities: detail.activities.map((a) => ({
        seq: a.seq,
        type: a.type,
        summary: JSON.stringify(a).slice(0, 400),
      })),
      policy: detail.team.policy,
      budgets: detail.budgets,
    };
  }, taskId);
}

function gitWorktreeCount(workspace: string): number {
  const out = tryGit(workspace, 'worktree', 'list', '--porcelain');
  return out.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length - 1;
}

function appWorktreeDirCount(profile: string): number {
  const dir = join(profile, 'team-worker-worktrees');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => /^(w-|worktree-)/.test(name)).length;
}

/** 1 Tick ごとに Team の状態・worktree の数・UI の応答時間を取る。 */
async function uiLatencyMs(page: Page): Promise<number> {
  const started = Date.now();
  await Promise.race([
    page.evaluate(() => new Promise<number>((resolve) => requestAnimationFrame(() => resolve(1)))),
    new Promise((resolve) => setTimeout(resolve, 30_000)),
  ]).catch(() => undefined);
  return Date.now() - started;
}

type DriveResult = Readonly<{
  wallMs: number;
  stoppedReason: string;
  timeline: unknown[];
  tracks: ExecutionTrack[];
  maxRunning: number;
  maxGitWorktrees: number;
  maxAppWorktreeDirs: number;
  maxActivePhases: number;
  maxWorkingPhases: number;
  maxUiLatencyMs: number;
  maxMainLatencyMs: number;
  longTasks: unknown;
  pageText: string;
  approvals: string[];
  last: TeamSnapshot | null;
  answer: string;
}>;

async function driveTeam(
  app: ElectronApplication,
  page: Page,
  input: Readonly<{
    taskId: string;
    workspace: string;
    profile: string;
    prompt: string;
    expectedExecutions: number;
    label: string;
    /** 毎回の観測の後に呼ぶ（衝突シナリオの同期に使う）。 */
    onTick?: (snapshot: TeamSnapshot | null) => Promise<void>;
  }>,
): Promise<DriveResult> {
  const answers = page.getByTestId('assistant-message');
  const answersBefore = await answers.count();
  // Renderer の長いタスク（50ms 超）を数える。UI が固まった時間の目安にする。
  await page.evaluate(() => {
    const stats = { count: 0, totalMs: 0, maxMs: 0, over1s: 0 };
    Object.defineProperty(window, '__scLongTasks', { value: stats, configurable: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        stats.count++;
        stats.totalMs += entry.duration;
        stats.maxMs = Math.max(stats.maxMs, entry.duration);
        if (entry.duration > 1_000) stats.over1s++;
      }
    }).observe({ type: 'longtask', buffered: false });
  });
  await page.getByTestId('composer-textarea').fill(input.prompt);
  await page.getByTestId('composer-send-button').click();
  const started = Date.now();
  let maxMainLatencyMs = 0;
  const timeline: unknown[] = [];
  const tracks = new Map<string, ExecutionTrack>();
  const approvals: string[] = [];
  let maxRunning = 0;
  let maxGitWorktrees = 0;
  let maxAppWorktreeDirs = 0;
  let maxActivePhases = 0;
  let maxWorkingPhases = 0;
  let maxUiLatencyMs = 0;
  let leaderIdleSince: number | null = null;
  let stalledSince: number | null = null;
  let rateLimitedSince: number | null = null;
  let stoppedReason = 'timeout';
  let last: TeamSnapshot | null = null;
  let tick = 0;
  while (Date.now() - started < OVERALL_MS) {
    tick++;
    const card = page.getByTestId('approval-card').first();
    if (await card.isVisible().catch(() => false)) {
      const text = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      approvals.push(text.slice(0, 500));
      await card
        .getByTestId('approval-allow-once')
        .click({ timeout: 5_000 })
        .catch(() => undefined);
    }
    const now = Date.now();
    const mainStarted = Date.now();
    await app.evaluate(() => 1).catch(() => undefined);
    const mainLatency = Date.now() - mainStarted;
    maxMainLatencyMs = Math.max(maxMainLatencyMs, mainLatency);
    const latency = await uiLatencyMs(page);
    maxUiLatencyMs = Math.max(maxUiLatencyMs, latency);
    last = await readTeam(page, input.taskId).catch(() => last);
    const gitWorktrees = gitWorktreeCount(input.workspace);
    const appDirs = appWorktreeDirCount(input.profile);
    maxGitWorktrees = Math.max(maxGitWorktrees, gitWorktrees);
    maxAppWorktreeDirs = Math.max(maxAppWorktreeDirs, appDirs);
    const executions = last?.executions ?? [];
    for (const execution of executions) {
      let track = tracks.get(execution.id);
      if (track === undefined) {
        track = {
          id: execution.id,
          assignee: execution.assigneeAgentId,
          firstSeenAt: now - started,
          runningFrom: null,
          runningTo: null,
          terminalAt: null,
          states: [],
          phases: [],
          worktreePaths: [],
          queueReasons: [],
          terminalReason: null,
        };
        tracks.set(execution.id, track);
      }
      if (track.states.at(-1) !== execution.state) track.states.push(execution.state);
      if (execution.phase !== null && track.phases.at(-1) !== execution.phase)
        track.phases.push(execution.phase);
      for (const path of execution.worktreePaths)
        if (!track.worktreePaths.includes(path)) track.worktreePaths.push(path);
      if (execution.queueReason !== null && !track.queueReasons.includes(execution.queueReason))
        track.queueReasons.push(execution.queueReason);
      if (execution.state === 'running') {
        track.runningFrom ??= now - started;
        track.runningTo = now - started;
      }
      if (TERMINAL_EXECUTION.has(execution.state)) {
        track.terminalAt ??= now - started;
        track.terminalReason = execution.terminalReason;
      }
    }
    const running = executions.filter(({ state }) => state === 'running').length;
    const activePhases = executions.filter(
      ({ phase }) => phase !== null && ['preparing', 'running', 'finalizing'].includes(phase),
    ).length;
    maxRunning = Math.max(maxRunning, running);
    maxActivePhases = Math.max(maxActivePhases, activePhases);
    const workingPhases = executions.filter(({ phase }) => phase === 'running').length;
    maxWorkingPhases = Math.max(maxWorkingPhases, workingPhases);
    const counts: Record<string, number> = {};
    for (const { state } of executions) counts[state] = (counts[state] ?? 0) + 1;
    const phases: Record<string, number> = {};
    for (const { phase } of executions) if (phase) phases[phase] = (phases[phase] ?? 0) + 1;
    const leaderBusy =
      (await isStopVisible(page)) ||
      (await page.getByTestId('streaming-assistant-message').count()) > 0;
    timeline.push({
      t: now - started,
      workers: (last?.workers ?? []).filter(({ kind }) => kind === 'worker').length,
      executions: executions.length,
      counts,
      phases,
      running,
      workingPhases,
      gitWorktrees,
      appDirs,
      uiLatencyMs: latency,
      mainLatencyMs: mainLatency,
      leaderBusy,
    });
    if (tick % 10 === 1)
      console.info(
        `[real-ai] ${input.label} t=${Math.round((now - started) / 1000)}s workers=${(last?.workers ?? []).length - 1} execs=${executions.length} ${JSON.stringify(counts)} phases=${JSON.stringify(phases)} gitWT=${gitWorktrees} dirs=${appDirs} ui=${latency}ms leaderBusy=${leaderBusy}`,
      );
    // 統合で衝突した実行は waiting_resume で止まる（人が再開するまで終わらない）。それも決着とみなす。
    const allTerminal =
      executions.length >= input.expectedExecutions &&
      executions.every(({ state }) => TERMINAL_EXECUTION.has(state) || state === 'waiting_resume');
    leaderIdleSince = leaderBusy ? null : (leaderIdleSince ?? now);
    if (allTerminal && leaderIdleSince !== null && now - leaderIdleSince > 15_000) {
      stoppedReason = 'all-terminal-and-leader-idle';
      break;
    }
    // Leader が止まったのに実行が揃わない（雇い漏れ・割り当て漏れ）まま 3 分動きがなければ打ち切る。
    const nothingMoving =
      leaderIdleSince !== null &&
      executions.every(({ state }) => TERMINAL_EXECUTION.has(state) || state === 'waiting_resume');
    stalledSince = nothingMoving ? (stalledSince ?? now) : null;
    if (stalledSince !== null && now - stalledSince > 180_000) {
      stoppedReason = allTerminal ? 'leader-idle' : 'stalled-leader-idle';
      break;
    }
    // Provider が rate limit で止まり続けるなら、無理に待たずに止める。
    const waitingRateLimit = executions.filter(
      ({ state }) => state === 'waiting_rate_limit',
    ).length;
    const live = executions.filter(({ state }) => !TERMINAL_EXECUTION.has(state)).length;
    rateLimitedSince = live > 0 && waitingRateLimit * 2 >= live ? (rateLimitedSince ?? now) : null;
    if (rateLimitedSince !== null && now - rateLimitedSince > 300_000) {
      stoppedReason = 'rate-limited';
      await page
        .evaluate(async (id) => window.sprintCoder!.teams.stopAll(id), input.taskId)
        .catch(() => undefined);
      break;
    }
    if (input.onTick) await input.onTick(last);
    if (tick % 20 === 0) await shot(page, `${input.label}-progress-${tick}`);
    await page.waitForTimeout(3_000);
  }
  const answer =
    (await answers.count()) > answersBefore
      ? ((await answers
          .last()
          .innerText()
          .catch(() => '')) ?? '')
      : '';
  return {
    wallMs: Date.now() - started,
    stoppedReason,
    timeline,
    tracks: [...tracks.values()],
    maxRunning,
    maxGitWorktrees,
    maxAppWorktreeDirs,
    maxActivePhases,
    maxWorkingPhases,
    maxUiLatencyMs,
    maxMainLatencyMs,
    longTasks: await page
      .evaluate(() => (window as unknown as { __scLongTasks?: unknown }).__scLongTasks ?? null)
      .catch(() => null),
    pageText: await page
      .locator('body')
      .innerText()
      .catch(() => ''),
    approvals,
    last,
    answer: answer.trim(),
  };
}

/** 実行区間（running を観測した最初〜最後）の重なりの最大数。 */
function maxOverlap(tracks: readonly ExecutionTrack[]): number {
  const events: [number, number][] = [];
  for (const track of tracks)
    if (track.runningFrom !== null && track.runningTo !== null) {
      events.push([track.runningFrom, 1]);
      events.push([track.runningTo + 1, -1]);
    }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let max = 0;
  for (const [, delta] of events) {
    current += delta;
    max = Math.max(max, current);
  }
  return max;
}

function repositoryState(workspace: string): Record<string, unknown> {
  const status = tryGit(workspace, 'status', '--porcelain');
  const log = tryGit(workspace, 'log', '--format=%h %an %s');
  return {
    status,
    cherryPickInProgress: existsSync(join(workspace, '.git', 'CHERRY_PICK_HEAD')),
    mergeInProgress: existsSync(join(workspace, '.git', 'MERGE_HEAD')),
    conflictMarkers: tryGit(workspace, 'grep', '-n', '-e', '^<<<<<<<', '-e', '^>>>>>>>'),
    worktreeList: tryGit(workspace, 'worktree', 'list', '--porcelain'),
    commitCount: log.split(/\r?\n/).filter((line) => line.trim() !== '').length,
    log,
  };
}

/** Main の stdout をそのまま貯める（Worker の CLI の起動（最初の出力）と終了の時刻を拾うため）。 */
const mainOutput = new WeakMap<ElectronApplication, string[]>();

async function launch(profile: string, logName: string): Promise<ElectronApplication> {
  const app = await launchApp(profile, undefined, REAL_RUNTIME_ENV);
  recordMainLog(app, logName);
  const chunks: string[] = [];
  mainOutput.set(app, chunks);
  for (const stream of [app.process().stdout, app.process().stderr])
    stream?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  return app;
}

async function prepareTask(
  page: Page,
  workspace: string,
  projectName: string,
): Promise<{
  taskId: string;
  leaderModel: string;
  claude: Selection;
  codex: Selection;
  teamConcurrency: number | null;
}> {
  const settings = await page.evaluate(async () => {
    const api = window.sprintCoder!.settings;
    return {
      modelResearch: await api.getTeamModelResearch().catch((e: unknown) => String(e)),
      modelSettings: await api.getTeamModelSettings().catch((e: unknown) => String(e)),
      defaultPolicy: await api.getDefaultTeamPolicy().catch((e: unknown) => String(e)),
      teamConcurrency: await api.getTeamConcurrency().catch((e: unknown) => String(e)),
    };
  });
  console.info('[real-ai] team-scale settings', JSON.stringify(settings));
  note('team-settings.json', settings);
  if (BUDGET_UNLIMITED)
    await page.evaluate(async () => {
      const api = window.sprintCoder!.settings;
      const policy = await api.getDefaultTeamPolicy();
      await api.setDefaultTeamPolicy({ ...policy, budgetMode: 'unlimited' });
    });
  await page.getByTestId('sidebar-new-task-button').click();
  await assignCurrentTaskToProjectFolder(page, projectName, workspace);
  const leaderModel = await selectModel(page, LEADER);
  await setAccess(page, 'auto');
  const taskId = await page.evaluate(async () => (await window.sprintCoder!.tasks.list())[0]!.id);
  const claude = await catalogSelection(page, taskId, CLAUDE);
  const codex = await catalogSelection(page, taskId, CODEX);
  const teamConcurrency =
    typeof settings.teamConcurrency === 'object'
      ? settings.teamConcurrency.maxConcurrentExecutions
      : null;
  return { taskId, leaderModel, claude, codex, teamConcurrency };
}

function summarize(result: DriveResult, assignments: readonly Assignment[]) {
  const workers = (result.last?.workers ?? []).filter(({ kind }) => kind === 'worker');
  const byEngine: Record<string, number> = {};
  for (const worker of workers) byEngine[worker.engine] = (byEngine[worker.engine] ?? 0) + 1;
  const byRequestedProvider: Record<string, number> = {};
  for (const worker of workers) {
    const key = worker.requestedProvider ?? 'null';
    byRequestedProvider[key] = (byRequestedProvider[key] ?? 0) + 1;
  }
  const engineOf = new Map(workers.map((w) => [w.id, w.engine]));
  const roleOf = new Map(workers.map((w) => [w.id, w.role]));
  const executions = result.last?.executions ?? [];
  const perProvider: Record<string, Record<string, number>> = {};
  for (const execution of executions) {
    const engine = engineOf.get(execution.assigneeAgentId) ?? 'unknown';
    const bucket = (perProvider[engine] ??= {});
    bucket[execution.state] = (bucket[execution.state] ?? 0) + 1;
    if (execution.terminalReason)
      bucket[`reason:${execution.terminalReason}`] =
        (bucket[`reason:${execution.terminalReason}`] ?? 0) + 1;
  }
  const rateLimited: Record<string, number> = {};
  const retried: Record<string, number> = {};
  for (const track of result.tracks) {
    const engine = engineOf.get(track.assignee) ?? 'unknown';
    if (
      track.states.includes('waiting_rate_limit') ||
      track.queueReasons.includes('rate_limit') ||
      track.terminalReason === 'rate_limited'
    )
      rateLimited[engine] = (rateLimited[engine] ?? 0) + 1;
    if (
      track.queueReasons.includes('automatic_retry') ||
      track.states.filter((s) => s === 'running').length > 1
    )
      retried[engine] = (retried[engine] ?? 0) + 1;
  }
  const distinctWorktrees = new Set(result.tracks.flatMap((track) => track.worktreePaths));
  const executionsPerWorker: Record<string, number> = {};
  for (const execution of executions) {
    const role = roleOf.get(execution.assigneeAgentId) ?? execution.assigneeAgentId;
    executionsPerWorker[role] = (executionsPerWorker[role] ?? 0) + 1;
  }
  return {
    expectedWorkers: assignments.length,
    hiredWorkers: workers.length,
    writeCapableWorkers: workers.filter((w) => w.writeCapable).length,
    byEngine,
    byRequestedProvider,
    workersWithWrongEngine: workers
      .filter((w) => {
        const expected = assignments.find((a) => a.role === w.role)?.provider;
        return expected !== undefined && expected !== w.engine;
      })
      .map((w) => `${w.role}:${w.engine}`),
    executions: executions.length,
    executionsPerWorker,
    perProvider,
    rateLimited,
    retried,
    distinctIsolationWorktrees: distinctWorktrees.size,
    maxRunningSampled: result.maxRunning,
    maxOverlapFromIntervals: maxOverlap(result.tracks),
    maxGitWorktrees: result.maxGitWorktrees,
    maxAppWorktreeDirs: result.maxAppWorktreeDirs,
    maxActiveIsolationPhases: result.maxActivePhases,
    maxWorkingIsolationPhases: result.maxWorkingPhases,
    maxUiLatencyMs: result.maxUiLatencyMs,
    maxMainLatencyMs: result.maxMainLatencyMs,
    longTasks: result.longTasks,
    wallMs: result.wallMs,
    stoppedReason: result.stoppedReason,
    approvals: result.approvals.length,
    policy: result.last?.policy,
  };
}

test.describe('real AI Team scale E2E', () => {
  test.skip(
    !REAL_AI_ENABLED,
    'opt-in: SPRINT_CODER_REAL_AI_E2E=1 (real Claude / Codex subscriptions)',
  );

  // 1. 32 人（Claude 16 / Codex 16）が別々のファイルを同時に書く。
  test(`team-scale: ${TEAM_SIZE} workers (half Claude, half Codex) write distinct files concurrently`, async () => {
    test.setTimeout(OVERALL_MS + 10 * 60_000);
    expect(TEAM_SIZE % 2, 'TEAM_SIZE must be even').toBe(0);
    const workspace = makeTeamWorkspace('team-scale', TEAM_SIZE);
    const profile = makeDir('realai-profile-team-scale');
    console.info(
      `[real-ai] team-scale workspace=${workspace} profile=${profile} leader=${LEADER.name}`,
    );
    note('paths.json', {
      workspace,
      profile,
      leader: LEADER.name,
      size: TEAM_SIZE,
      budgetUnlimited: BUDGET_UNLIMITED,
    });
    const errors: string[] = [];
    const app = await launch(profile, 'main-team-scale.log');
    let page: Page | null = null;
    let taskId: string | null = null;
    try {
      page = await firstWindow(app);
      collectRendererErrors(page, errors);
      const prepared = await prepareTask(page, workspace, 'RealAI team scale');
      taskId = prepared.taskId;
      const assignments: Assignment[] = Array.from({ length: TEAM_SIZE }, (_, i) => {
        const index = i + 1;
        const provider = index % 2 === 1 ? 'claude' : 'codex';
        const file = `src/worker-${pad(index)}.txt`;
        const content = `SC_FILE_${pad(index)}_${provider}`;
        return {
          index,
          role: `W${pad(index)}-${provider}`,
          provider,
          selection: provider === 'claude' ? prepared.claude : prepared.codex,
          objective: `Create the file \`${file}\` with exactly ${ROWS + 1} lines: the first line is \`${content}\`, followed by the ${ROWS} lines \`W${pad(index)} row 01\`, \`W${pad(index)} row 02\`, ... up to \`W${pad(index)} row ${ROWS}\` (two-digit row numbers), every line ending with one newline and nothing else in the file. Do not create, modify or delete any other file.${SLOW_NOTE}`,
          criterion: `${file} has exactly ${ROWS + 1} lines starting with ${content} and ending with W${pad(index)} row ${ROWS}, confirmed by reading it back`,
        };
      });
      note('assignments.json', { leaderModel: prepared.leaderModel, assignments });
      const result = await driveTeam(app, page, {
        taskId: prepared.taskId,
        workspace,
        profile,
        prompt: leaderPrompt('scale test', assignments, 'SC_TEAM_SCALE_DONE'),
        expectedExecutions: TEAM_SIZE,
        label: 'team-scale',
      });
      await shot(page, 'team-scale-final');
      // 同時に CLI が動いていた人数（区間の取り方と根拠は real-ai-team-concurrency.ts の先頭）。
      const dbConcurrency = await runningConcurrency(
        join(profile, 'sprint-coder.sqlite3'),
        parseWorkerEvents((mainOutput.get(app) ?? []).join('')),
        MIN_CONCURRENT,
      );
      const files = assignments.map((a) => {
        const path = `src/worker-${pad(a.index)}.txt`;
        const text = normalize(readText(join(workspace, path)));
        const expected = expectedWorkerFile(a.index, a.provider);
        return {
          path,
          exact: text === expected,
          trimmedMatch: text?.trim() === expected.trim(),
          text: text?.slice(0, 200) ?? null,
        };
      });
      const srcFiles = readdirSync(join(workspace, 'src')).sort();
      const unexpectedFiles = srcFiles.filter(
        (name) => name !== 'README.md' && !/^worker-\d\d\.txt$/.test(name),
      );
      const repo = repositoryState(workspace);
      const summary = {
        ...summarize(result, assignments),
        leaderModel: prepared.leaderModel,
        workerModels: { claude: prepared.claude, codex: prepared.codex },
        teamConcurrency: prepared.teamConcurrency,
        dbConcurrency,
        filesExact: files.filter((f) => f.exact).length,
        filesTrimmedMatch: files.filter((f) => f.trimmedMatch).length,
        missingFiles: files.filter((f) => f.text === null).map((f) => f.path),
        wrongFiles: files.filter((f) => f.text !== null && !f.trimmedMatch),
        unexpectedFiles,
        sharedIndexUnchanged:
          normalize(readText(join(workspace, 'shared', 'index.md')))?.includes(
            `TODO-${TEAM_SIZE}`,
          ) ?? false,
        repo,
        rendererErrors: errors,
        answer: result.answer.slice(0, 2_000),
      };
      console.info('[real-ai] team-scale summary', JSON.stringify(summary, null, 2));
      note('team-scale-summary.json', summary);
      note('team-scale-timeline.json', result.timeline);
      note('team-scale-page.txt', result.pageText);
      note('team-scale-tracks.json', result.tracks);
      note('team-scale-last.json', result.last);
      expect.soft(summary.hiredWorkers).toBe(TEAM_SIZE);
      expect.soft(summary.byEngine).toEqual({ claude: TEAM_SIZE / 2, codex: TEAM_SIZE / 2 });
      expect.soft(summary.filesTrimmedMatch).toBe(TEAM_SIZE);
      expect.soft(unexpectedFiles).toEqual([]);
      expect.soft(String(repo['status']).trim()).toBe('');
      expect.soft(repo['cherryPickInProgress']).toBe(false);
      // 30 人以上が本当に同時に CLI を動かしていたこと。rate limit の待機が 1 件でもあれば、待機中の
      // Worker も worktree を持ったままなので重なりを正しく判定できない。判定不能として失敗させる。
      // 画面のサンプリング値（maxWorkingIsolationPhases など）は参考として記録するだけにする。
      expect(dbConcurrency.error, '同時実行数を DB から読めませんでした').toBeUndefined();
      expect(
        dbConcurrency.rateLimitWaits + dbConcurrency.rateLimitedAttempts,
        `判定不能: rate limit の待機が起きたため、同時編集の合否を判定から除外します（待機 ${dbConcurrency.rateLimitWaits} 件、待機した Attempt ${dbConcurrency.rateLimitedAttempts} 件）`,
      ).toBe(0);
      expect(
        dbConcurrency.withoutCliStart,
        `判定不能: CLI の起動（最初の出力）を Main ログで確かめられない区間が ${dbConcurrency.withoutCliStart} 件あります`,
      ).toBe(0);
      expect(
        dbConcurrency.withoutCliEnd,
        `判定不能: CLI の終了を Main ログで確かめられない区間が ${dbConcurrency.withoutCliEnd} 件あります`,
      ).toBe(0);
      expect(
        dbConcurrency.fallbackAttempts,
        `判定不能: 別の Runtime へ fallback した Attempt が ${dbConcurrency.fallbackAttempts} 件あり、CLI の起動時刻を決められません`,
      ).toBe(0);
      expect.soft(dbConcurrency.maxConcurrent).toBeGreaterThanOrEqual(MIN_CONCURRENT);
      expect.soft(dbConcurrency.secondsAtOrAbove).toBeGreaterThan(0);
      expect.soft(summary.maxAppWorktreeDirs).toBeGreaterThanOrEqual(MIN_CONCURRENT);
      // 実行ごとに別々の worktree（パスの重なり・入れ子なし）。
      const paths = result.tracks.flatMap((track) =>
        track.worktreePaths.map((p) => p.toLowerCase()),
      );
      expect.soft(result.tracks.every((track) => track.worktreePaths.length === 1)).toBe(true);
      expect.soft(new Set(paths).size).toBe(TEAM_SIZE);
      expect
        .soft(paths.filter((a, i) => paths.some((b, j) => i !== j && b.startsWith(`${a}${sep}`))))
        .toEqual([]);
      expect.soft(summary.teamConcurrency).toBeGreaterThanOrEqual(TEAM_SIZE);
      expect.soft(errors).toEqual([]);
    } finally {
      if (page && !page.isClosed() && taskId)
        note(
          'team-scale-final-detail.json',
          await readTeam(page, taskId).catch((e: unknown) => String(e)),
        );
      await shutdown(app);
    }
  });

  // 2. 4 人（Claude 2 / Codex 2）が同じファイル shared/index.md の別々の節を同時に編集する。
  test('team-overlap: 4 workers (2 Claude, 2 Codex) edit separate sections of the same file', async () => {
    test.setTimeout(30 * 60_000);
    const workspace = makeTeamWorkspace('team-overlap', 4);
    const profile = makeDir('realai-profile-team-overlap');
    console.info(
      `[real-ai] team-overlap workspace=${workspace} profile=${profile} leader=${LEADER.name}`,
    );
    note('paths.json', { workspace, profile, leader: LEADER.name });
    const before = normalize(readText(join(workspace, 'shared', 'index.md')));
    const errors: string[] = [];
    const app = await launch(profile, 'main-team-overlap.log');
    let page: Page | null = null;
    let taskId: string | null = null;
    try {
      page = await firstWindow(app);
      collectRendererErrors(page, errors);
      const prepared = await prepareTask(page, workspace, 'RealAI team overlap');
      taskId = prepared.taskId;
      const assignments: Assignment[] = [1, 2, 3, 4].map((index) => {
        const provider = index % 2 === 1 ? 'claude' : 'codex';
        return {
          index,
          role: `S${index}-${provider}`,
          provider,
          selection: provider === 'claude' ? prepared.claude : prepared.codex,
          objective: `Edit the existing file \`shared/index.md\`: replace the single line \`TODO-${index}\` with \`DONE-${index} by ${provider}\`. Change nothing else in that file (other sections are being edited by other workers) and do not touch any other file.`,
          criterion: `shared/index.md contains the line DONE-${index} by ${provider} in Section ${index}, confirmed by reading it back`,
        };
      });
      note('assignments.json', { leaderModel: prepared.leaderModel, assignments });
      const result = await driveTeam(app, page, {
        taskId: prepared.taskId,
        workspace,
        profile,
        prompt: leaderPrompt('same-file overlap test', assignments, 'SC_TEAM_OVERLAP_DONE'),
        expectedExecutions: 4,
        label: 'team-overlap',
      });
      await shot(page, 'team-overlap-final');
      const after = normalize(readText(join(workspace, 'shared', 'index.md')));
      const expected = [1, 2, 3, 4].reduce(
        (text, index) =>
          text?.replace(
            `TODO-${index}\n`,
            `DONE-${index} by ${index % 2 === 1 ? 'claude' : 'codex'}\n`,
          ) ?? null,
        before,
      );
      const repo = repositoryState(workspace);
      const summary = {
        ...summarize(result, assignments),
        leaderModel: prepared.leaderModel,
        editsPresent: [1, 2, 3, 4].filter((index) =>
          after?.includes(`DONE-${index} by ${index % 2 === 1 ? 'claude' : 'codex'}`),
        ),
        todosLeft: [1, 2, 3, 4].filter((index) => after?.includes(`TODO-${index}\n`)),
        exactlyExpected: after === expected,
        after,
        perExecution: (result.last?.executions ?? []).map((e) => ({
          state: e.state,
          phase: e.phase,
          terminalReason: e.terminalReason,
          isolationReason: e.isolationReason,
          changedFiles: e.changedFiles,
        })),
        repo,
        rendererErrors: errors,
        answer: result.answer.slice(0, 2_000),
      };
      console.info('[real-ai] team-overlap summary', JSON.stringify(summary, null, 2));
      note('team-overlap-summary.json', summary);
      note('team-overlap-timeline.json', result.timeline);
      note('team-overlap-page.txt', result.pageText);
      note('team-overlap-tracks.json', result.tracks);
      note('team-overlap-last.json', result.last);
      expect.soft(summary.hiredWorkers).toBe(4);
      expect.soft(summary.editsPresent).toEqual([1, 2, 3, 4]);
      expect.soft(summary.exactlyExpected).toBe(true);
      expect.soft(String(repo['status']).trim()).toBe('');
      expect.soft(repo['cherryPickInProgress']).toBe(false);
      expect.soft(errors).toEqual([]);
    } finally {
      if (page && !page.isClosed() && taskId)
        note(
          'team-overlap-final-detail.json',
          await readTeam(page, taskId).catch((e: unknown) => String(e)),
        );
      await shutdown(app);
    }
  });

  // 3. 2 人（Claude 1 / Codex 1）が同じ行を別々の内容に書き換える。本当の衝突で App が何をするか記録する。
  test('team-conflict: 2 workers (Claude, Codex) rewrite the same line differently', async () => {
    test.setTimeout(25 * 60_000);
    const workspace = makeTeamWorkspace('team-conflict', 2);
    const profile = makeDir('realai-profile-team-conflict');
    console.info(
      `[real-ai] team-conflict workspace=${workspace} profile=${profile} leader=${LEADER.name}`,
    );
    note('paths.json', { workspace, profile, leader: LEADER.name });
    const errors: string[] = [];
    const app = await launch(profile, 'main-team-conflict.log');
    let page: Page | null = null;
    let taskId: string | null = null;
    try {
      page = await firstWindow(app);
      collectRendererErrors(page, errors);
      const prepared = await prepareTask(page, workspace, 'RealAI team conflict');
      taskId = prepared.taskId;
      const assignments: Assignment[] = (['claude', 'codex'] as const).map((provider, i) => ({
        index: i + 1,
        role: `C${i + 1}-${provider}`,
        provider,
        selection: provider === 'claude' ? prepared.claude : prepared.codex,
        objective: `First wait for the go signal: use read_file to read the file \`${GO_MARKER}\` in the workspace root. If it does not exist yet, call team_wait_events once and then try read_file again; keep repeating this until \`${GO_MARKER}\` exists (the test harness creates it within a few minutes, once every worker is ready). Do not edit anything before \`${GO_MARKER}\` exists, and never create, modify or delete \`${GO_MARKER}\` yourself. Then edit the existing file \`shared/index.md\`: replace the single line \`TODO-1\` with \`OWNED-BY-${provider}\`. Change nothing else and do not touch any other file.`,
        criterion: `shared/index.md contains the line OWNED-BY-${provider} in Section 1, confirmed by reading it back`,
      }));
      // 同期点: 2 人の isolation が両方とも running になり、同じ baseHead から準備され、その時点で
      // Workspace の HEAD もまだその baseHead のまま（どちらも統合されていない）ことを確かめてから、
      // 両方の worktree に目印を置く。Worker は目印が現れるまで編集しない。
      const sync: {
        releasedAt: number | null;
        baseHead: string | null;
        worktrees: string[];
        lastSeen: unknown;
      } = { releasedAt: null, baseHead: null, worktrees: [], lastSeen: null };
      const result = await driveTeam(app, page, {
        taskId: prepared.taskId,
        workspace,
        profile,
        prompt: leaderPrompt('same-line conflict test', assignments, 'SC_TEAM_CONFLICT_DONE'),
        expectedExecutions: 2,
        label: 'team-conflict',
        onTick: async (snapshot) => {
          if (sync.releasedAt !== null || snapshot === null) return;
          const executions = snapshot.executions;
          sync.lastSeen = executions.map((e) => ({
            state: e.state,
            phase: e.phase,
            baseHeads: e.baseHeads,
          }));
          if (
            executions.length !== 2 ||
            !executions.every(
              (e) =>
                e.phase === 'running' && e.worktreePaths.length === 1 && e.baseHeads.length === 1,
            )
          )
            return;
          const bases = new Set(executions.map((e) => e.baseHeads[0]!));
          const head = tryGit(workspace, 'rev-parse', 'HEAD').trim();
          if (bases.size !== 1 || !bases.has(head)) return;
          for (const e of executions) writeFileSync(join(e.worktreePaths[0]!, GO_MARKER), 'go\n');
          sync.releasedAt = Date.now();
          sync.baseHead = head;
          sync.worktrees = executions.map((e) => e.worktreePaths[0]!);
          console.info(`[real-ai] team-conflict go marker placed base=${head}`);
        },
      });
      await shot(page, 'team-conflict-final');
      const after = normalize(readText(join(workspace, 'shared', 'index.md')));
      const repo = repositoryState(workspace);
      const summary = {
        ...summarize(result, assignments),
        after,
        winners: (['claude', 'codex'] as const).filter((p) => after?.includes(`OWNED-BY-${p}`)),
        sync,
        finalBaseHeads: (result.last?.executions ?? []).map((e) => e.baseHeads),
        finalLines: [...result.answer.matchAll(FINAL_LINE('SC_TEAM_CONFLICT_DONE'))].map((m) => ({
          completed: Number(m[2]),
          failed: Number(m[3]),
        })),
        // 衝突した側の Worker から Leader へ届いた failed 報告（衝突したファイルと waiting_resume を含む）。
        conflictReports: (result.last?.leaderMessages ?? [])
          .filter((m) => m.content.includes('衝突したファイル'))
          .map((m) => m.content.slice(0, 1_500)),
        corrupted: /^(<<<<<<<|=======|>>>>>>>)/m.test(after ?? ''),
        perExecution: (result.last?.executions ?? []).map((e) => ({
          state: e.state,
          phase: e.phase,
          terminalReason: e.terminalReason,
          isolationReason: e.isolationReason,
          changedFiles: e.changedFiles,
          worktreePaths: e.worktreePaths,
        })),
        repo,
        rendererErrors: errors,
        answer: result.answer.slice(0, 2_000),
      };
      console.info('[real-ai] team-conflict summary', JSON.stringify(summary, null, 2));
      note('team-conflict-summary.json', summary);
      note('team-conflict-timeline.json', result.timeline);
      note('team-conflict-tracks.json', result.tracks);
      note('team-conflict-page.txt', result.pageText);
      // 同期点に届かなかった（どちらかが先に統合された・同じ baseHead にならなかった）なら、衝突が
      // 起きないのは App のせいとは限らない。判定不能として、理由を出して失敗させる。
      expect(
        sync.releasedAt,
        `判定不能: 2 人の worktree が同じ baseHead で揃う前に進んだため、衝突の扱いを判定できません（最後に見た状態: ${JSON.stringify(sync.lastSeen)}）`,
      ).not.toBeNull();
      expect(
        new Set(summary.finalBaseHeads.flat()).size,
        `判定不能: 2 人の baseHead が違います ${JSON.stringify(summary.finalBaseHeads)}`,
      ).toBe(1);
      // 片方だけが統合され、もう片方は衝突として waiting_resume で止まり、Leader に failed 報告が届く。
      expect.soft(summary.winners).toHaveLength(1);
      expect
        .soft((result.last?.executions ?? []).map((e) => e.state).sort())
        .toEqual(['completed', 'waiting_resume']);
      expect.soft(summary.conflictReports).toHaveLength(1);
      expect.soft(summary.conflictReports[0] ?? '').toContain('shared/index.md');
      expect.soft(summary.conflictReports[0] ?? '').toContain('waiting_resume');
      // Leader の最終回答は指定の 1 行（completed=1 failed=1）でなければならない。無い・形式違いは失敗。
      expect(
        summary.finalLines,
        `Leader の最終回答に「SC_TEAM_CONFLICT_DONE completed=<n> failed=<n>」の行がちょうど 1 つ必要です: ${JSON.stringify(result.answer.slice(-500))}`,
      ).toHaveLength(1);
      expect.soft(summary.finalLines[0]).toEqual({ completed: 1, failed: 1 });
      expect.soft(summary.corrupted).toBe(false);
      expect.soft(repo['cherryPickInProgress']).toBe(false);
      expect.soft(String(repo['status']).trim()).toBe('');
      expect.soft(errors).toEqual([]);
    } finally {
      if (page && !page.isClosed() && taskId)
        note(
          'team-conflict-final-detail.json',
          await readTeam(page, taskId).catch((e: unknown) => String(e)),
        );
      await shutdown(app);
    }
  });
});
