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
import { assignCurrentTaskToProjectFolder, closeApp, firstWindow, launchApp } from './helpers';

// 本物の Claude Code CLI / Codex CLI（ユーザーのサブスク）で、ワークスペースへの書き込み・
// コマンド実行・Access preset・再起動復元・Team（Leader + Worker）を確かめる opt-in のスペック。
// 実課金が発生するので、CI では必ず skip される。
//
//   $env:SPRINT_CODER_REAL_AI_E2E = '1'
//   $env:SPRINT_CODER_E2E_MODE = 'dev'
//   npx playwright test tests/e2e/real-ai-workspace.spec.ts --config playwright.dev.config.ts
//
// 片方の Provider だけ: -g "claude" / -g "codex"。成果物（ワークスペース・user-data・スクリーン
// ショット）は SPRINT_CODER_REAL_AI_E2E_ROOT（既定は OS の一時フォルダ）の下に残す。

const ENABLED = process.env['SPRINT_CODER_REAL_AI_E2E'] === '1';
const ARTIFACT_ROOT =
  process.env['SPRINT_CODER_REAL_AI_E2E_ROOT'] ?? join(tmpdir(), 'sprint-coder-real-ai-e2e');
// ワークスペースは AppData の外に置く。Windows の %TEMP% は AppData\Local\Temp なので、
// path-guard がワークスペース全体を app-private に分類し、auto でも読み書き・コマンドが
// すべて拒否される（classifyPath の `appdata` 判定）。
const WORKSPACE_ROOT =
  process.env['SPRINT_CODER_REAL_AI_E2E_WORKSPACE_ROOT'] ??
  (process.platform === 'win32' ? 'C:\\sprint-coder-real-ai-ws' : ARTIFACT_ROOT);

const REAL_RUNTIME_ENV = {
  SPRINT_CODER_E2E_CLI_FIXTURES: '0',
  SPRINT_CODER_ALLOW_SIMULATED_TEAM_WORKERS: '0',
  SPRINT_CODER_RUNTIME_ADOPT: '1',
  SPRINT_CODER_REAL_WORKERS: '1',
  SPRINT_CODER_TEAM_MCP_TRACE: '1',
} as const;

type Provider = Readonly<{
  name: 'claude' | 'codex';
  search: string;
  /** 候補の modelId から、テストに使うものを選ぶ。fixture 専用の id を決め打ちしない。 */
  pick: (ids: readonly string[]) => string | undefined;
}>;

const PROVIDERS: readonly Provider[] = [
  {
    name: 'claude',
    search: 'sonnet',
    pick: (ids) => ids.find((id) => /^sonnet$/i.test(id)) ?? ids.find((id) => /sonnet/i.test(id)),
  },
  {
    name: 'codex',
    search: 'gpt',
    pick: (ids) =>
      ids.find((id) => /^gpt-[\d.]+$/i.test(id)) ??
      ids.find((id) => /^gpt-/i.test(id) && !/mini|nano|image/i.test(id)),
  },
];

const TERMINAL = /^(completed|failed|cancelled|interrupted|error)$/;

function makeDir(label: string, parent = ARTIFACT_ROOT): string {
  mkdirSync(parent, { recursive: true });
  return realpathSync.native(mkdtempSync(join(parent, `${label}-`)));
}

/** README と小さな Node プロジェクトを持つ git リポジトリを作る。 */
function makeWorkspace(label: string): string {
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

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function normalize(text: string | null): string | null {
  return text === null ? null : text.replace(/\r\n/g, '\n');
}

async function shot(page: Page, name: string): Promise<string> {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true }).catch(() => undefined);
  return path;
}

async function selectModel(page: Page, provider: Provider): Promise<string> {
  const trigger = page.getByTestId('model-picker-v2-trigger');
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  let chosen: string | undefined;
  let seen: string[] = [];
  await expect(async () => {
    if (!(await page.getByTestId('model-picker-v2-search').isVisible())) await trigger.click();
    await page.getByTestId('model-picker-v2-search').fill(provider.search);
    const options = page.locator('[data-testid^="model-picker-v2-option-"]');
    await expect(options.first()).toBeVisible({ timeout: 3_000 });
    const rows = await options.evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: (node.getAttribute('data-testid') ?? '').replace('model-picker-v2-option-', ''),
        label: node.getAttribute('aria-label') ?? '',
      })),
    );
    seen = rows.map((row) => `${row.id} | ${row.label}`);
    // サブスク（CLI）経由の行に絞る。API 接続の同名モデルを選ばない。
    const viaCli = rows.filter((row) => /Claude Code|Codex/i.test(row.label));
    chosen = provider.pick((viaCli.length > 0 ? viaCli : rows).map((row) => row.id));
    expect(chosen, `no ${provider.name} model in picker: ${seen.join(' / ')}`).toBeTruthy();
  }).toPass({ timeout: 90_000 });
  console.info(`[real-ai] ${provider.name} picker options:`, JSON.stringify(seen));
  console.info(`[real-ai] ${provider.name} chosen model: ${chosen}`);
  await page.getByTestId(`model-picker-v2-option-${chosen}`).first().click();
  return chosen!;
}

async function setAccess(page: Page, preset: 'ask' | 'auto'): Promise<void> {
  const selector = page.getByTestId('access-selector');
  if ((await selector.getAttribute('data-access-preset')) === preset) return;
  await selector.click();
  await page.getByTestId(`access-option-${preset}`).click();
  await expect(selector).toHaveAttribute('data-access-preset', preset);
}

type TurnResult = Readonly<{
  status: string;
  answer: string;
  approvals: readonly string[];
  durationMs: number;
}>;

/**
 * 1 Turn を送って終端まで待つ。途中に承認カードが出たら内容を記録して「1回だけ許可」を押す
 * （approve=false なら「拒否」）。待ちは必ず timeoutMs で打ち切る。
 */
async function sendTurn(
  page: Page,
  prompt: string,
  options: Readonly<{ timeoutMs?: number; approve?: boolean; label: string }>,
): Promise<TurnResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
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
  while (Date.now() - started < timeoutMs) {
    const card = page.getByTestId('approval-card').first();
    if (await card.isVisible().catch(() => false)) {
      const text = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      approvals.push(text);
      console.info(`[real-ai] ${options.label} approval card:`, text);
      await shot(page, `${options.label}-approval-${approvals.length}`);
      const button = card.getByTestId(
        options.approve === false ? 'approval-deny' : 'approval-allow-once',
      );
      await button.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(1_000);
      continue;
    }
    // Team Canvas では run-card が描かれないので、Composer が「停止」から戻ったことでも終端を見る。
    const runCount = await runCards.count();
    status =
      runCount > 0
        ? ((await runCards
            .last()
            .getAttribute('data-run-status')
            .catch(() => '')) ?? '')
        : '';
    const streaming = await page.getByTestId('streaming-assistant-message').count();
    const stopVisible =
      (await page.locator('[data-testid="composer-send-button"].stop').count()) > 0 ||
      (await page.getByTestId('composer-interrupt-button').count()) > 0;
    const progressed = runCount > runsBefore || (await answers.count()) > before;
    const settled = runCount > 0 ? TERMINAL.test(status) : true;
    if (progressed && settled && streaming === 0 && !stopVisible) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= 5_000) {
        if (runCount === 0) status = 'completed';
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
    `[real-ai] ${options.label} status=${status} duration=${durationMs}ms answer=${JSON.stringify(answer.slice(0, 600))}`,
  );
  await shot(page, `${options.label}-done`);
  return { status, answer, approvals, durationMs };
}

async function startTask(page: Page, workspace: string, provider: Provider): Promise<string> {
  await page.getByTestId('sidebar-new-task-button').click();
  await assignCurrentTaskToProjectFolder(page, `RealAI ${provider.name}`, workspace);
  return selectModel(page, provider);
}

function collectRendererErrors(page: Page, sink: string[]): void {
  page.on('pageerror', (error) => sink.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') sink.push(`console: ${message.text()}`);
  });
}

async function shutdown(app: ElectronApplication | null): Promise<void> {
  await Promise.race([closeApp(app), new Promise((resolve) => setTimeout(resolve, 20_000))]);
  try {
    app?.process().kill('SIGKILL');
  } catch {
    /* already exited */
  }
}

function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: false })
    .map(String)
    .filter((path) => !path.startsWith('.git'));
}

test.describe('real AI workspace E2E', () => {
  test.skip(!ENABLED, 'opt-in: SPRINT_CODER_REAL_AI_E2E=1 (real Claude / Codex subscriptions)');

  for (const provider of PROVIDERS) {
    test(`${provider.name}: auto writes, edits, runs a command and restores after restart`, async () => {
      test.setTimeout(1_500_000);
      const workspace = makeWorkspace(`${provider.name}-auto`);
      const profile = makeDir(`realai-profile-${provider.name}-auto`);
      console.info(`[real-ai] ${provider.name} workspace=${workspace} profile=${profile}`);
      const errors: string[] = [];
      let app: ElectronApplication | null = await launchApp(profile, undefined, REAL_RUNTIME_ENV);
      try {
        const page = await firstWindow(app);
        collectRendererErrors(page, errors);
        await startTask(page, workspace, provider);
        await setAccess(page, 'auto');

        // a. 新規作成と既存ファイルの編集
        const writeTurn = await test.step('a. create + edit files', () =>
          sendTurn(
            page,
            [
              'This is an automated test. Use your file tools in the current workspace; do not ask questions.',
              '1. Create a new file named `sc-created.txt` in the workspace root whose entire content is exactly the single line `SC_CREATE_OK` followed by one newline.',
              '2. Edit the existing file `README.md`: replace the line `Original line.` with `Edited by AI.` and change nothing else.',
              'When done, reply with exactly `SC_WRITE_DONE`.',
            ].join('\n'),
            { label: `${provider.name}-a-write`, timeoutMs: 420_000 },
          ));
        const created = normalize(readText(join(workspace, 'sc-created.txt')));
        const readme = normalize(readText(join(workspace, 'README.md')));
        console.info(`[real-ai] ${provider.name} disk sc-created.txt=${JSON.stringify(created)}`);
        console.info(`[real-ai] ${provider.name} disk README.md=${JSON.stringify(readme)}`);
        const fileCards = page.getByTestId('file-change-card');
        const fileCardText = (await fileCards.allInnerTexts()).join(' | ');
        console.info(
          `[real-ai] ${provider.name} file-change-card: ${JSON.stringify(fileCardText)}`,
        );
        expect.soft(writeTurn.status).toBe('completed');
        expect.soft(created).toBe('SC_CREATE_OK\n');
        expect.soft(readme).toBe('# Real AI workspace\n\nEdited by AI.\n');
        expect.soft(fileCardText).toContain('sc-created.txt');
        expect.soft(fileCardText).toContain('README.md');
        expect.soft(writeTurn.answer).toContain('SC_WRITE_DONE');

        // b. コマンド実行。「安全時は自動」では、自動レビューが許可しないコマンドは拒否で終わらず承認
        // カードに回り、許可すれば実行される（#825）。レビューが許可したものはカード無しで実行される。
        // sendTurn はカードを「1回だけ許可」で通す。続けてフルアクセスでも試す。
        const commandPrompt = (file: string): string =>
          [
            'This is an automated test. Run this exact shell command in the workspace root with your command execution tool (do not create the file with a file-writing tool):',
            `node -e "require('fs').writeFileSync('${file}','SC_CMD_OK:'+process.version)"`,
            'Then run `node --version` and reply with exactly `SC_CMD_DONE <the version it printed>`.',
            'If a command is refused, do not retry and do not ask questions; reply `SC_CMD_REFUSED <reason>`.',
          ].join('\n');
        const runCommandStep = async (preset: 'auto' | 'full', file: string) => {
          const turn = await sendTurn(page, commandPrompt(file), {
            label: `${provider.name}-b-command-${preset}`,
            timeoutMs: 420_000,
          });
          const out = readText(join(workspace, file));
          const cards = (await page.getByTestId('command-card').allInnerTexts()).join(' | ');
          console.info(
            `[real-ai] ${provider.name} [${preset}] disk ${file}=${JSON.stringify(out)}`,
          );
          console.info(
            `[real-ai] ${provider.name} [${preset}] command-card: ${JSON.stringify(cards.slice(-900))}`,
          );
          console.info(
            `[real-ai] ${provider.name} [${preset}] command approvals: ${JSON.stringify(turn.approvals)}`,
          );
          expect.soft(turn.status, `${preset} command turn status`).toBe('completed');
          expect
            .soft(out ?? '', `${preset}: ${file} written by the command`)
            .toMatch(/^SC_CMD_OK:v\d+\.\d+\.\d+$/);
          expect.soft(turn.answer, `${preset}: reply`).toMatch(/SC_CMD_DONE v\d+\.\d+\.\d+/);
          if (preset === 'auto') {
            const audits = await page.getByTestId('auto-decision-audit').allInnerTexts();
            console.info(
              `[real-ai] ${provider.name} [auto] auto-decision-audit: ${JSON.stringify(audits)}`,
            );
            const autoAllowed = audits.some(
              (text) => text.includes('shell.execute') && /自動許可|今回のみ許可/.test(text),
            );
            expect
              .soft(
                turn.approvals.length > 0 || autoAllowed,
                'auto: a command is either asked about on a card or allowed by the reviewer',
              )
              .toBe(true);
            expect
              .soft(
                audits.filter((text) => text.includes('shell.execute') && text.includes('拒否')),
                'auto: no command is refused for good',
              )
              .toEqual([]);
          }
          return turn;
        };
        await test.step('b1. run a command at auto', () =>
          runCommandStep('auto', 'cmd-out-auto.txt'));
        await test.step('b2. run a command at full', async () => {
          // フルアクセスの初回確認は Main のネイティブダイアログ。分離した E2E プロセスの中だけで
          // 「有効化」を押した扱いにする（file-edits.spec.ts の showOpenDialog と同じ差し替え）。
          await app!.evaluate(({ dialog }) => {
            Object.defineProperty(dialog, 'showMessageBox', {
              configurable: true,
              value: async () => ({ response: 1, checkboxChecked: false }),
            });
          });
          await page.getByTestId('access-selector').click();
          await page.getByTestId('access-option-full').click();
          await page.getByTestId('access-full-confirm').click();
          await expect(page.getByTestId('access-selector')).toHaveAttribute(
            'data-access-preset',
            'full',
          );
          await runCommandStep('full', 'cmd-out-full.txt');
        });

        const beforeRestart = {
          users: await page.getByTestId('user-message').allInnerTexts(),
          answers: await page.getByTestId('assistant-message').allInnerTexts(),
          fileCards: await fileCards.count(),
          commandCards: await page.getByTestId('command-card').count(),
        };
        await shot(page, `${provider.name}-d-before-restart`);

        // d. 再起動して復元
        await shutdown(app);
        app = await launchApp(profile, undefined, REAL_RUNTIME_ENV);
        const restored = await firstWindow(app);
        collectRendererErrors(restored, errors);
        await expect(restored.getByTestId('user-message').first()).toBeVisible({ timeout: 60_000 });
        await restored.waitForTimeout(3_000);
        const afterRestart = {
          users: await restored.getByTestId('user-message').allInnerTexts(),
          answers: await restored.getByTestId('assistant-message').allInnerTexts(),
          fileCards: await restored.getByTestId('file-change-card').count(),
          commandCards: await restored.getByTestId('command-card').count(),
          runStatuses: await restored
            .getByTestId('run-card')
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-run-status'))),
          access: await restored.getByTestId('access-selector').getAttribute('data-access-preset'),
          model: await restored.getByTestId('model-picker-v2-trigger').innerText(),
        };
        console.info(`[real-ai] ${provider.name} before restart`, JSON.stringify(beforeRestart));
        console.info(`[real-ai] ${provider.name} after restart`, JSON.stringify(afterRestart));
        await shot(restored, `${provider.name}-d-after-restart`);
        expect.soft(afterRestart.users).toEqual(beforeRestart.users);
        expect.soft(afterRestart.answers).toEqual(beforeRestart.answers);
        expect.soft(afterRestart.fileCards).toBe(beforeRestart.fileCards);
        expect.soft(afterRestart.commandCards).toBe(beforeRestart.commandCards);
        expect.soft(afterRestart.access).toBe('full');
        for (const runStatus of afterRestart.runStatuses)
          expect.soft(runStatus).not.toMatch(/running|queued|streaming/);
        console.info(`[real-ai] ${provider.name} renderer errors`, JSON.stringify(errors));
        console.info(
          `[real-ai] ${provider.name} workspace files`,
          JSON.stringify(listFiles(workspace)),
        );
      } finally {
        await shutdown(app);
      }
    });

    test(`${provider.name}: ask denies writes on the card, then writes after approval`, async () => {
      test.setTimeout(600_000);
      const workspace = makeWorkspace(`${provider.name}-ask`);
      const profile = makeDir(`realai-profile-${provider.name}-ask`);
      console.info(`[real-ai] ${provider.name} workspace=${workspace} profile=${profile}`);
      const app = await launchApp(profile, undefined, REAL_RUNTIME_ENV);
      try {
        const page = await firstWindow(app);
        await startTask(page, workspace, provider);
        await expect(page.getByTestId('access-selector')).toHaveAttribute(
          'data-access-preset',
          'ask',
        );
        const turn = await sendTurn(
          page,
          [
            "This is an automated test. Create a file named `sc-ask.txt` in the workspace root containing exactly `SC_ASK_SHOULD_NOT_EXIST`, and also run the command `node -e \"require('fs').writeFileSync('ask-cmd.txt','x')\"`.",
            'If you cannot write files or run commands, do not ask the user; reply in one short sentence explaining why, starting with `SC_ASK_BLOCKED`.',
          ].join('\n'),
          { label: `${provider.name}-c-ask`, timeoutMs: 300_000, approve: false },
        );
        console.info(`[real-ai] ${provider.name} ask approvals: ${JSON.stringify(turn.approvals)}`);
        expect.soft(existsSync(join(workspace, 'sc-ask.txt'))).toBe(false);
        expect.soft(existsSync(join(workspace, 'ask-cmd.txt'))).toBe(false);
        expect.soft(turn.status).toMatch(TERMINAL);
        expect.soft(turn.status).toBe('completed');
        expect.soft(turn.answer.length).toBeGreaterThan(0);
        await expect.soft(page.getByTestId('file-change-card')).toHaveCount(0);

        // 「確認する」の説明は「変更とコマンドは実行前に確認します」。承認カードで許可すれば
        // 実際に書き込まれ、コマンドも走るはず。
        const approved = await sendTurn(
          page,
          [
            "This is an automated test. Create a file named `sc-ask-approved.txt` in the workspace root whose entire content is exactly `SC_ASK_APPROVED`, then run `node -e \"require('fs').writeFileSync('ask-cmd-approved.txt','SC_ASK_CMD')\"`.",
            'Use your tools; the user will approve them. Reply `SC_ASK_APPROVED_DONE` when both succeeded, or `SC_ASK_BLOCKED <reason>` if a tool was refused.',
          ].join('\n'),
          { label: `${provider.name}-c-ask-approve`, timeoutMs: 300_000, approve: true },
        );
        console.info(
          `[real-ai] ${provider.name} ask-approve approvals: ${JSON.stringify(approved.approvals)}`,
        );
        const approvedFile = readText(join(workspace, 'sc-ask-approved.txt'));
        const approvedCmd = readText(join(workspace, 'ask-cmd-approved.txt'));
        const askCards = (await page.getByTestId('file-change-card').allInnerTexts()).join(' | ');
        console.info(
          `[real-ai] ${provider.name} ask-approve disk file=${JSON.stringify(approvedFile)} cmd=${JSON.stringify(approvedCmd)} cards=${JSON.stringify(askCards)}`,
        );
        expect.soft(approved.approvals.length, 'ask: approval cards raised').toBeGreaterThan(0);
        expect.soft(approvedFile?.trim()).toBe('SC_ASK_APPROVED');
        expect.soft(approvedCmd).toBe('SC_ASK_CMD');
        expect.soft(askCards).toContain('sc-ask-approved.txt');
        expect.soft(approved.answer).toContain('SC_ASK_APPROVED_DONE');
        console.info(
          `[real-ai] ${provider.name} workspace files`,
          JSON.stringify(listFiles(workspace)),
        );
      } finally {
        await shutdown(app);
      }
    });

    test(`${provider.name}: leader hires two write-capable workers that each write a file`, async () => {
      test.setTimeout(1_800_000);
      const workspace = makeWorkspace(`${provider.name}-team`);
      const profile = makeDir(`realai-profile-${provider.name}-team`);
      console.info(`[real-ai] ${provider.name} workspace=${workspace} profile=${profile}`);
      const errors: string[] = [];
      const trace: string[] = [];
      let app: ElectronApplication | null = await launchApp(profile, undefined, REAL_RUNTIME_ENV);
      app.process().stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (/Team MCP|team_|Worker|worker/i.test(text)) trace.push(text.slice(0, 2_000));
      });
      try {
        const page = await firstWindow(app);
        collectRendererErrors(page, errors);
        await startTask(page, workspace, provider);
        await setAccess(page, 'auto');
        const turn = await sendTurn(
          page,
          [
            'This is an automated test of team mode. Use the team tools (team_hire_worker, team_assign_task, team_wait_reports); do not write the files yourself.',
            'Hire exactly 2 workers with writeCapable=true:',
            '- Worker A (role "Writer A"): create the file `team-a.txt` in the workspace root containing exactly `SC_TEAM_A_OK` and nothing else.',
            '- Worker B (role "Writer B"): create the file `team-b.txt` in the workspace root containing exactly `SC_TEAM_B_OK` and nothing else.',
            'Assign each task with access "workspace-write". Wait for both reports, then reply with `SC_TEAM_DONE` followed by a one-line summary of each worker report.',
          ].join('\n'),
          { label: `${provider.name}-e-team`, timeoutMs: 1_500_000 },
        );
        await expect.soft(page.getByTestId('team-list')).toBeVisible({ timeout: 10_000 });
        const workers = await page.getByTestId('team-worker').count();
        const roles = await page.locator('.w-head .role-name').allTextContents();
        const reports = await page.locator('.w-line:has(.tag.out)').allTextContents();
        const a = normalize(readText(join(workspace, 'team-a.txt')));
        const b = normalize(readText(join(workspace, 'team-b.txt')));
        console.info(
          `[real-ai] ${provider.name} team workers=${workers} roles=${JSON.stringify(roles)}`,
        );
        console.info(`[real-ai] ${provider.name} team reports=${JSON.stringify(reports)}`);
        console.info(
          `[real-ai] ${provider.name} team disk a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
        );
        console.info(
          `[real-ai] ${provider.name} workspace files`,
          JSON.stringify(listFiles(workspace)),
        );
        console.info(
          `[real-ai] ${provider.name} git status`,
          execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' }),
        );
        console.info(`[real-ai] ${provider.name} renderer errors`, JSON.stringify(errors));
        writeFileSync(test.info().outputPath('team-trace.txt'), trace.join('\n'));
        await shot(page, `${provider.name}-e-team-final`);
        expect.soft(turn.status).toBe('completed');
        expect.soft(workers).toBeGreaterThanOrEqual(2);
        expect.soft(reports.length).toBeGreaterThanOrEqual(2);
        expect.soft(a?.trim()).toBe('SC_TEAM_A_OK');
        expect.soft(b?.trim()).toBe('SC_TEAM_B_OK');
        expect.soft(turn.answer).toContain('SC_TEAM_DONE');
        console.info(
          `[real-ai] ${provider.name} git log`,
          execFileSync('git', ['log', '--format=%h %s', '-5'], {
            cwd: workspace,
            encoding: 'utf8',
          }),
        );

        // 再起動後も Team（Worker 2人・報告・最終回答）が戻ること。
        await shutdown(app);
        app = await launchApp(profile, undefined, REAL_RUNTIME_ENV);
        const restored = await firstWindow(app);
        collectRendererErrors(restored, errors);
        await restored.waitForTimeout(5_000);
        // ヘッダーの「Teamを開く」を名前で指す。/Team/ だと、AI が付けた Task 名（例:「Team mode …」）
        // のサイドバー行に先に当たり、Team を開かずに終わる。
        const teamButton = restored.getByRole('button', { name: 'Teamを開く' });
        if (
          (await restored.getByTestId('team-list').count()) === 0 &&
          (await teamButton.count()) > 0
        )
          await teamButton.click().catch(() => undefined);
        await expect.soft(restored.getByTestId('team-list')).toBeVisible({ timeout: 30_000 });
        const restoredWorkers = await restored.getByTestId('team-worker').count();
        const restoredReports = await restored.locator('.w-line:has(.tag.out)').count();
        const restoredAnswer = await restored.getByTestId('assistant-message').last().innerText();
        console.info(
          `[real-ai] ${provider.name} team after restart workers=${restoredWorkers} reports=${restoredReports} answerHasDone=${restoredAnswer.includes('SC_TEAM_DONE')}`,
        );
        await shot(restored, `${provider.name}-e-team-after-restart`);
        expect.soft(restoredWorkers).toBe(workers);
        expect.soft(restoredReports).toBe(reports.length);
        expect.soft(restoredAnswer).toContain('SC_TEAM_DONE');
        console.info(`[real-ai] ${provider.name} renderer errors (all)`, JSON.stringify(errors));
      } finally {
        await shutdown(app);
      }
    });
  }
});
