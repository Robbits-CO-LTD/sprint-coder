import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeApp } from './helpers';

// 本物の AI を使う opt-in スペック（real-ai-*.spec.ts）の共通部品。real-ai-workspace.spec.ts と同じ
// 約束（ゲート・成果物の置き場所・Runtime の環境変数・モデルの選び方）を使う。

export const REAL_AI_ENABLED = process.env['SPRINT_CODER_REAL_AI_E2E'] === '1';
export const ARTIFACT_ROOT =
  process.env['SPRINT_CODER_REAL_AI_E2E_ROOT'] ?? join(tmpdir(), 'sprint-coder-real-ai-e2e');
// ワークスペースは AppData の外に置く（%TEMP% 配下は path-guard が app-private と判定する）。
export const WORKSPACE_ROOT =
  process.env['SPRINT_CODER_REAL_AI_E2E_WORKSPACE_ROOT'] ??
  (process.platform === 'win32' ? 'C:\\sprint-coder-real-ai-ws' : ARTIFACT_ROOT);

export const REAL_RUNTIME_ENV = {
  SPRINT_CODER_E2E_CLI_FIXTURES: '0',
  SPRINT_CODER_ALLOW_SIMULATED_TEAM_WORKERS: '0',
  SPRINT_CODER_RUNTIME_ADOPT: '1',
  SPRINT_CODER_REAL_WORKERS: '1',
  SPRINT_CODER_TEAM_MCP_TRACE: '1',
} as const;

export type ProviderName = 'claude' | 'codex' | 'grok';
export type Provider = Readonly<{
  name: ProviderName;
  search: string;
  /** Picker の aria-label（「… 経由」）で、サブスク（CLI）経由の行を見分ける。 */
  via: RegExp;
  pick: (ids: readonly string[]) => string | undefined;
}>;

export const CLAUDE: Provider = {
  name: 'claude',
  search: 'sonnet',
  via: /Claude Code/i,
  pick: (ids) => ids.find((id) => /^sonnet$/i.test(id)) ?? ids.find((id) => /sonnet/i.test(id)),
};
export const CODEX: Provider = {
  name: 'codex',
  search: 'gpt',
  via: /Codex/i,
  pick: (ids) =>
    ids.find((id) => /^gpt-[\d.]+$/i.test(id)) ??
    ids.find((id) => /^gpt-/i.test(id) && !/mini|nano|image/i.test(id)),
};
export const GROK: Provider = {
  name: 'grok',
  search: 'grok',
  via: /Grok/i,
  pick: (ids) => ids.find((id) => /grok/i.test(id) && !/image|vision/i.test(id)),
};
export const PROVIDERS: readonly Provider[] = [CLAUDE, CODEX];

/** Run の終端。RunCard の値は `canceled`（米綴り）。 */
export const TERMINAL = /^(completed|failed|canceled|cancelled|interrupted|error)$/;

export function makeDir(label: string, parent = ARTIFACT_ROOT): string {
  mkdirSync(parent, { recursive: true });
  return realpathSync.native(mkdtempSync(join(parent, `${label}-`)));
}

/** README と小さな Node プロジェクトを持つ git リポジトリを作る。 */
export function makeWorkspace(label: string, options: Readonly<{ git?: boolean }> = {}): string {
  const root = makeDir(`realai-ws-${label}`, WORKSPACE_ROOT);
  if (/[\\/]appdata[\\/]/i.test(root))
    throw new Error(`workspace must live outside AppData (classified app-private): ${root}`);
  writeFileSync(join(root, 'README.md'), '# Real AI workspace\n\nOriginal line.\n');
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'realai-ws', version: '1.0.0', private: true, main: 'index.js' }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, 'index.js'),
    "module.exports = function greet() {\n  return 'hello';\n};\n",
  );
  if (options.git === false) return root;
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  };
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git(
    '-c',
    'user.name=realai',
    '-c',
    'user.email=realai@example.invalid',
    'commit',
    '-q',
    '-m',
    'init',
  );
  return root;
}

export function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

export function normalize(text: string | null): string | null {
  return text === null ? null : text.replace(/\r\n/g, '\n');
}

export function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: false })
    .map(String)
    .filter((path) => !path.startsWith('.git'));
}

export async function shot(page: Page, name: string): Promise<string> {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true }).catch(() => undefined);
  return path;
}

export function note(name: string, body: unknown): void {
  try {
    writeFileSync(
      test.info().outputPath(name),
      typeof body === 'string' ? body : JSON.stringify(body, null, 2),
    );
  } catch {
    /* 診断の書き出しは失敗してもテスト結果を変えない */
  }
}

type PickerRow = Readonly<{ id: string; label: string }>;

/** Picker を開いて検索し、候補行（id と aria-label）を返す。行が出なければ空。 */
export async function pickerRows(page: Page, search: string): Promise<PickerRow[]> {
  const trigger = page.getByTestId('model-picker-v2-trigger');
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  if (!(await page.getByTestId('model-picker-v2-search').isVisible())) await trigger.click();
  await page.getByTestId('model-picker-v2-search').fill(search);
  await page.waitForTimeout(1_000);
  return page.locator('[data-testid^="model-picker-v2-option-"]').evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: (node.getAttribute('data-testid') ?? '').replace('model-picker-v2-option-', ''),
      label: node.getAttribute('aria-label') ?? '',
    })),
  );
}

export async function selectModel(page: Page, provider: Provider): Promise<string> {
  let chosen: string | undefined;
  let seen: string[] = [];
  await expect(async () => {
    const rows = await pickerRows(page, provider.search);
    seen = rows.map((row) => `${row.id} | ${row.label}`);
    const viaCli = rows.filter((row) => provider.via.test(row.label));
    chosen = provider.pick((viaCli.length > 0 ? viaCli : rows).map((row) => row.id));
    expect(chosen, `no ${provider.name} model in picker: ${seen.join(' / ')}`).toBeTruthy();
  }).toPass({ timeout: 90_000 });
  console.info(`[real-ai] ${provider.name} picker options:`, JSON.stringify(seen));
  console.info(`[real-ai] ${provider.name} chosen model: ${chosen}`);
  await page.getByTestId(`model-picker-v2-option-${chosen}`).first().click();
  return chosen!;
}

export async function setAccess(page: Page, preset: 'ask' | 'auto'): Promise<void> {
  const selector = page.getByTestId('access-selector');
  if ((await selector.getAttribute('data-access-preset')) === preset) return;
  await selector.click();
  await page.getByTestId(`access-option-${preset}`).click();
  await expect(selector).toHaveAttribute('data-access-preset', preset);
}

/** 承認カードの文面から「許可する」か「拒否する」かを決める。 */
export type ApprovalDecider = (text: string) => 'allow' | 'deny';
export const allowAll: ApprovalDecider = () => 'allow';
export const denyAll: ApprovalDecider = () => 'deny';

/** 見えている承認カードを 1 枚だけ処理する。処理したら文面を返す。 */
export async function answerApprovalCard(
  page: Page,
  decide: ApprovalDecider,
  label: string,
  log: string[],
): Promise<string | null> {
  const card = page.getByTestId('approval-card').first();
  if (!(await card.isVisible().catch(() => false))) return null;
  const text = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const decision = decide(text);
  log.push(`${decision}: ${text}`);
  console.info(`[real-ai] ${label} approval card (${decision}):`, text);
  await shot(page, `${label}-approval-${log.length}`);
  await card
    .getByTestId(decision === 'deny' ? 'approval-deny' : 'approval-allow-once')
    .click({ timeout: 5_000 })
    .catch((error: unknown) => console.info(`[real-ai] ${label} approval click failed`, error));
  await page.waitForTimeout(1_000);
  return text;
}

/** Every Auto decision row on screen. The rows sit behind one summary per Turn (issue #863), so
 * the closed groups are opened first. */
export async function readAutoDecisionAudits(page: Page): Promise<string[]> {
  const closed = page.locator('[data-testid="auto-decision-group"]:not([open]) > summary');
  while ((await closed.count()) > 0) await closed.first().click();
  return page.getByTestId('auto-decision-audit').allInnerTexts();
}

export async function isStopVisible(page: Page): Promise<boolean> {
  return (
    (await page.locator('[data-testid="composer-send-button"].stop').count()) > 0 ||
    (await page.getByTestId('composer-interrupt-button').count()) > 0
  );
}

export async function lastRunStatus(page: Page): Promise<string> {
  const cards = page.getByTestId('run-card');
  if ((await cards.count()) === 0) return '';
  return (
    (await cards
      .last()
      .getAttribute('data-run-status')
      .catch(() => '')) ?? ''
  );
}

export type TurnResult = Readonly<{
  status: string;
  answer: string;
  approvals: readonly string[];
  durationMs: number;
  timedOut: boolean;
}>;

/**
 * 1 Turn を送って終端まで待つ。承認カードは decide で許可/拒否する。`until` を渡すと、その条件が
 * 真になった時点で（終端を待たずに）戻る。待ちは必ず timeoutMs で打ち切る。
 */
export async function sendTurn(
  page: Page,
  prompt: string,
  options: Readonly<{
    label: string;
    timeoutMs?: number;
    decide?: ApprovalDecider;
    until?: () => Promise<boolean>;
  }>,
): Promise<TurnResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const decide = options.decide ?? allowAll;
  const answers = page.getByTestId('assistant-message');
  const before = await answers.count();
  const runCards = page.getByTestId('run-card');
  const runsBefore = await runCards.count();
  await page.getByTestId('composer-textarea').fill(prompt);
  await page.getByTestId('composer-send-button').click();
  const started = Date.now();
  const approvals: string[] = [];
  let status = '';
  let idleSince: number | null = null;
  let timedOut = true;
  while (Date.now() - started < timeoutMs) {
    if ((await answerApprovalCard(page, decide, options.label, approvals)) !== null) continue;
    if (options.until && (await options.until())) {
      timedOut = false;
      status = await lastRunStatus(page);
      break;
    }
    const runCount = await runCards.count();
    status = await lastRunStatus(page);
    const streaming = await page.getByTestId('streaming-assistant-message').count();
    const progressed = runCount > runsBefore || (await answers.count()) > before;
    const settled = runCount > 0 ? TERMINAL.test(status) : true;
    if (progressed && settled && streaming === 0 && !(await isStopVisible(page))) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= 5_000) {
        if (runCount === 0) status = 'completed';
        timedOut = false;
        break;
      }
    } else idleSince = null;
    await page.waitForTimeout(1_000);
  }
  const answer =
    (await answers.count()) > before
      ? (
          (await answers
            .last()
            .innerText()
            .catch(() => '')) ?? ''
        ).trim()
      : '';
  const durationMs = Date.now() - started;
  console.info(
    `[real-ai] ${options.label} status=${status} timedOut=${timedOut} duration=${durationMs}ms answer=${JSON.stringify(answer.slice(0, 600))}`,
  );
  await shot(page, `${options.label}-done`);
  return { status, answer, approvals, durationMs, timedOut };
}

export function collectRendererErrors(page: Page, sink: string[]): void {
  page.on('pageerror', (error) => sink.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') sink.push(`console: ${message.text()}`);
  });
}

/** Main の stdout/stderr を test の成果物フォルダへ逐次書き出す（終了後の切り分け用）。 */
export function recordMainLog(app: ElectronApplication, name: string): void {
  const chunks: string[] = [];
  const flush = (): void => note(name, chunks.join(''));
  for (const stream of [app.process().stdout, app.process().stderr])
    stream?.on('data', (chunk: Buffer) => {
      chunks.push(chunk.toString('utf8'));
      if (chunks.length % 20 === 0) flush();
    });
  app.process().once('exit', flush);
}

export async function shutdown(app: ElectronApplication | null): Promise<void> {
  await Promise.race([closeApp(app), new Promise((resolve) => setTimeout(resolve, 20_000))]);
  try {
    app?.process().kill('SIGKILL');
  } catch {
    /* already exited */
  }
}

export type Proc = Readonly<{ pid: number; ppid: number; name: string; cmd: string }>;

/** OS のプロセス一覧（Windows は Win32_Process）。コマンドラインは診断のため 300 文字に切る。 */
export function listProcesses(): Proc[] {
  if (process.platform === 'win32') {
    const script = [
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
      'Get-CimInstance Win32_Process | ForEach-Object {',
      `  "{0}\`t{1}\`t{2}\`t{3}" -f $_.ProcessId,$_.ParentProcessId,$_.Name,(($_.CommandLine) -replace '[\\r\\n\\t]',' ')`,
      '}',
    ].join(' ');
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
    );
    return out
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const [pid, ppid, name, ...rest] = line.split('\t');
        return {
          pid: Number(pid),
          ppid: Number(ppid),
          name: name ?? '',
          cmd: rest.join(' ').slice(0, 300),
        };
      });
  }
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [pid, ppid, name, ...rest] = line.trim().split(/\s+/);
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        name: name ?? '',
        cmd: rest.join(' ').slice(0, 300),
      };
    });
}

/** rootPid の子孫（root 自身は含めない）。 */
export function descendants(rootPid: number, procs: readonly Proc[] = listProcesses()): Proc[] {
  const result: Proc[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const proc of procs)
      if (proc.ppid === parent && !seen.has(proc.pid)) {
        seen.add(proc.pid);
        result.push(proc);
        queue.push(proc.pid);
      }
  }
  return result;
}

/** 以前に見たプロセスのうち、同じ pid・同じ名前でまだ生きているもの。 */
export function survivors(
  previous: readonly Proc[],
  procs: readonly Proc[] = listProcesses(),
): Proc[] {
  return previous.filter((old) =>
    procs.some((proc) => proc.pid === old.pid && proc.name === old.name),
  );
}

export function processesWithMarker(
  marker: string,
  procs: readonly Proc[] = listProcesses(),
): Proc[] {
  return procs.filter(
    (proc) => proc.cmd.includes(marker) && !/powershell|Get-CimInstance/i.test(proc.cmd),
  );
}

export async function pollUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 1_000,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return check();
}

/** 1 つの Project に複数フォルダを持たせて今の Task を割り当てる（helpers の複数フォルダ版）。 */
export async function assignCurrentTaskToProjectFolders(
  page: Page,
  projectName: string,
  folders: readonly Readonly<{ path: string; role: 'primary' | 'secondary' }>[],
): Promise<void> {
  await page.evaluate(
    async ({ name, list }) => {
      if (!window.sprintCoder) throw new Error('Sprint Coder API unavailable');
      const task = (await window.sprintCoder.tasks.list()).find((candidate) => !candidate.archived);
      if (!task) throw new Error('current Task unavailable');
      const project = await window.sprintCoder.projects.create({ name, folders: [...list] });
      await window.sprintCoder.projects.assignTask({
        projectId: project.id,
        taskId: task.id,
        expectedProjectId: task.projectId,
      });
    },
    { name: projectName, list: folders },
  );
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: projectName }).first().waitFor();
}
