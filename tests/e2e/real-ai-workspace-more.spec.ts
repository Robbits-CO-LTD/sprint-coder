import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assignCurrentTaskToProjectFolder, firstWindow, launchApp } from './helpers';
import {
  ARTIFACT_ROOT,
  GROK,
  PROVIDERS,
  REAL_AI_ENABLED,
  REAL_RUNTIME_ENV,
  TERMINAL,
  allowAll,
  assignCurrentTaskToProjectFolders,
  collectRendererErrors,
  denyAll,
  descendants,
  isStopVisible,
  lastRunStatus,
  listFiles,
  listProcesses,
  makeDir,
  makeWorkspace,
  normalize,
  note,
  pickerRows,
  pollUntil,
  processesWithMarker,
  readText,
  recordMainLog,
  selectModel,
  sendTurn,
  setAccess,
  shot,
  shutdown,
  survivors,
  type Proc,
  type Provider,
} from './real-ai-helpers';

// real-ai-workspace.spec.ts の続き。本物の Claude Code CLI / Codex CLI（ユーザーのサブスク）で、
// 「確認する」での Team の承認・拒否、実行中の停止、実行中の再起動、複数フォルダの Project、
// Graph Mission（本物の Worker）、日本語と絵文字の読み書きを確かめる。Grok は Picker に使える
// モデルがあるときだけ試す。実課金が発生するので、CI では必ず skip される。
//
//   $env:SPRINT_CODER_REAL_AI_E2E = '1'
//   $env:SPRINT_CODER_E2E_MODE = 'dev'
//   npx playwright test tests/e2e/real-ai-workspace-more.spec.ts --config playwright.dev.config.ts
//
// 片方の Provider だけ: -g "claude:" / -g "codex:"。

async function startTask(page: Page, workspace: string, provider: Provider): Promise<string> {
  await page.getByTestId('sidebar-new-task-button').click();
  await assignCurrentTaskToProjectFolder(page, `RealAI ${provider.name}`, workspace);
  return selectModel(page, provider);
}

function marker(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function describeProcs(procs: readonly Proc[]): string[] {
  return procs.map((proc) => `${proc.pid}<${proc.ppid} ${proc.name} ${proc.cmd.slice(0, 160)}`);
}

async function launch(
  profile: string,
  logName: string,
  env: Readonly<Record<string, string>> = REAL_RUNTIME_ENV,
): Promise<ElectronApplication> {
  const app = await launchApp(profile, undefined, env);
  recordMainLog(app, logName);
  return app;
}

test.describe('real AI workspace E2E (more)', () => {
  test.skip(
    !REAL_AI_ENABLED,
    'opt-in: SPRINT_CODER_REAL_AI_E2E=1 (real Claude / Codex subscriptions)',
  );

  for (const provider of PROVIDERS) {
    // 1. 「確認する」の Team: Worker の書き込みが Leader の Turn の承認カードに出る（#525）。
    test(`${provider.name}: team in ask surfaces worker writes as approval cards (allow A, deny B)`, async () => {
      test.setTimeout(1_800_000);
      const workspace = makeWorkspace(`${provider.name}-team-ask`);
      const profile = makeDir(`realai-profile-${provider.name}-team-ask`);
      console.info(`[real-ai] ${provider.name} workspace=${workspace} profile=${profile}`);
      const errors: string[] = [];
      const app = await launch(profile, 'main-team-ask.log');
      try {
        const page = await firstWindow(app);
        collectRendererErrors(page, errors);
        await startTask(page, workspace, provider);
        await expect(page.getByTestId('access-selector')).toHaveAttribute(
          'data-access-preset',
          'ask',
        );
        const turn = await sendTurn(
          page,
          [
            'This is an automated test of team mode. Use the team tools (team_hire_worker, team_assign_task, team_wait_reports); do not write the files yourself.',
            'Hire exactly 2 workers with writeCapable=true:',
            '- Worker A (role "Writer A"): create the file `team-a.txt` in the workspace root containing exactly `SC_TEAM_A_OK` and nothing else.',
            '- Worker B (role "Writer B"): create the file `team-b.txt` in the workspace root containing exactly `SC_TEAM_B_OK` and nothing else.',
            'Assign each task with access "workspace-write". The user reviews every write on an approval card and may deny some of them. A denied write must not be retried by anyone, by any other means.',
            'Wait for both reports, then reply with exactly one line: `SC_TEAM_DONE A=<OK|DENIED> B=<OK|DENIED>`, where OK means that file was written and DENIED means its write was refused.',
          ].join('\n'),
          {
            label: `${provider.name}-1-team-ask`,
            timeoutMs: 1_500_000,
            // B の書き込みだけ拒否する。採用（hire）や A の書き込みなど、それ以外は許可する。
            decide: (text) => (/team-b\.txt/i.test(text) ? 'deny' : 'allow'),
          },
        );
        const a = normalize(readText(join(workspace, 'team-a.txt')));
        const b = normalize(readText(join(workspace, 'team-b.txt')));
        const workers = await page.getByTestId('team-worker').count();
        const reports = await page.locator('.w-line:has(.tag.out)').allTextContents();
        console.info(
          `[real-ai] ${provider.name} team-ask approvals`,
          JSON.stringify(turn.approvals),
        );
        console.info(
          `[real-ai] ${provider.name} team-ask disk a=${JSON.stringify(a)} b=${JSON.stringify(b)} workers=${workers}`,
        );
        console.info(`[real-ai] ${provider.name} team-ask reports`, JSON.stringify(reports));
        console.info(
          `[real-ai] ${provider.name} workspace files`,
          JSON.stringify(listFiles(workspace)),
        );
        console.info(`[real-ai] ${provider.name} renderer errors`, JSON.stringify(errors));
        note('team-ask-result.json', { turn, a, b, workers, reports, errors });
        await shot(page, `${provider.name}-1-team-ask-final`);
        expect.soft(turn.timedOut, 'team in ask must not hang').toBe(false);
        expect.soft(turn.status).toBe('completed');
        expect
          .soft(
            turn.approvals.some((entry) => entry.startsWith('allow') && /team-a\.txt/i.test(entry)),
            'worker A write surfaced as an approval card',
          )
          .toBe(true);
        expect
          .soft(
            turn.approvals.some((entry) => entry.startsWith('deny') && /team-b\.txt/i.test(entry)),
            'worker B write surfaced as an approval card',
          )
          .toBe(true);
        expect.soft(a?.trim()).toBe('SC_TEAM_A_OK');
        expect.soft(b, 'denied write must not reach disk').toBeNull();
        expect.soft(turn.answer).toMatch(/SC_TEAM_DONE\s+A=OK\s+B=DENIED/);
      } finally {
        await shutdown(app);
      }
    });

    // 2. 実行中のコマンドを「停止」で止める。子プロセスが残らず、次のメッセージが通ること。
    test(`${provider.name}: stop while a command runs cancels promptly without orphans`, async () => {
      test.setTimeout(900_000);
      const workspace = makeWorkspace(`${provider.name}-cancel`);
      const profile = makeDir(`realai-profile-${provider.name}-cancel`);
      console.info(`[real-ai] ${provider.name} workspace=${workspace} profile=${profile}`);
      const errors: string[] = [];
      const app = await launch(profile, 'main-cancel.log');
      try {
        const page = await firstWindow(app);
        collectRendererErrors(page, errors);
        await startTask(page, workspace, provider);
        await setAccess(page, 'auto');
        const electronPid = app.process().pid!;
        const beforeTurn = descendants(electronPid);
        const sleep = marker('SC_SLEEP');
        const started = await sendTurn(
          page,
          [
            'This is an automated test. Run exactly this shell command in the workspace root with your command execution tool and wait for it to finish (it takes about two minutes; do not run it in the background):',
            `node -e "setTimeout(()=>{},120000)" ${sleep}`,
            'After it finishes, create a file named `after-sleep.txt` containing `SHOULD_NOT_EXIST`. Do not ask questions.',
          ].join('\n'),
          {
            label: `${provider.name}-2-cancel-start`,
            timeoutMs: 300_000,
            until: async () => processesWithMarker(sleep).length > 0,
          },
        );
        expect(started.timedOut, 'the long command never started').toBe(false);
        const running = listProcesses();
        const during = descendants(electronPid, running);
        const sleepers = processesWithMarker(sleep, running);
        console.info(
          `[real-ai] ${provider.name} cancel: sleeper`,
          JSON.stringify(describeProcs(sleepers)),
        );
        console.info(
          `[real-ai] ${provider.name} cancel: tree during`,
          JSON.stringify(describeProcs(during)),
        );
        await shot(page, `${provider.name}-2-cancel-running`);

        const stop = page.getByTestId('composer-send-button');
        await expect(stop).toHaveAttribute('aria-label', '実行を停止');
        const stopAt = Date.now();
        await stop.click();
        const settled = await pollUntil(
          async () => TERMINAL.test(await lastRunStatus(page)) && !(await isStopVisible(page)),
          60_000,
          250,
        );
        const settleMs = Date.now() - stopAt;
        const status = await lastRunStatus(page);
        const sleeperGone = await pollUntil(() => processesWithMarker(sleep).length === 0, 30_000);
        const killMs = Date.now() - stopAt;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        const after = listProcesses();
        const newDuringTurn = during.filter(
          (proc) => !beforeTurn.some((old) => old.pid === proc.pid),
        );
        const leftovers = survivors(newDuringTurn, after);
        console.info(
          `[real-ai] ${provider.name} cancel: settled=${settled} status=${status} settleMs=${settleMs} sleeperGone=${sleeperGone} killMs=${killMs}`,
        );
        console.info(
          `[real-ai] ${provider.name} cancel: turn processes still alive`,
          JSON.stringify(describeProcs(leftovers)),
        );
        await shot(page, `${provider.name}-2-cancel-stopped`);
        const statusText = await page
          .getByTestId('run-card')
          .last()
          .innerText()
          .catch(() => '');
        console.info(`[real-ai] ${provider.name} cancel: run-card`, JSON.stringify(statusText));
        expect.soft(settled, 'run reaches a terminal state after Stop').toBe(true);
        expect.soft(status).toBe('canceled');
        expect.soft(settleMs, 'Stop settles the run promptly').toBeLessThan(15_000);
        expect.soft(sleeperGone, 'the command process is killed on Stop').toBe(true);
        expect
          .soft(
            leftovers.filter((proc) => proc.cmd.includes(sleep)),
            'no orphan from the canceled command',
          )
          .toEqual([]);

        // 停止のあとは、次のメッセージが普通に通る。
        const follow = await sendTurn(
          page,
          'This is an automated test. Do not use any tools. Reply with exactly `SC_AFTER_CANCEL_OK`.',
          { label: `${provider.name}-2-cancel-follow`, timeoutMs: 240_000 },
        );
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        expect.soft(follow.status).toBe('completed');
        expect.soft(follow.answer).toContain('SC_AFTER_CANCEL_OK');
        expect.soft(existsSync(join(workspace, 'after-sleep.txt'))).toBe(false);
        note('cancel-result.json', {
          status,
          settleMs,
          killMs,
          sleeperGone,
          leftovers: describeProcs(leftovers),
          during: describeProcs(during),
          follow,
          errors,
        });
      } finally {
        await shutdown(app);
      }
    });

    // 3. 実行中に App を閉じて、同じ user-data で開き直す。
    test(`${provider.name}: closing the app mid-command shows the turn as interrupted after relaunch`, async () => {
      test.setTimeout(900_000);
      const workspace = makeWorkspace(`${provider.name}-restart`);
      const profile = makeDir(`realai-profile-${provider.name}-restart`);
      console.info(`[real-ai] ${provider.name} workspace=${workspace} profile=${profile}`);
      const errors: string[] = [];
      let app: ElectronApplication | null = await launch(profile, 'main-restart-1.log');
      try {
        const page = await firstWindow(app);
        collectRendererErrors(page, errors);
        await startTask(page, workspace, provider);
        await setAccess(page, 'auto');
        const tag = marker('SC_RESTART');
        const started = await sendTurn(
          page,
          [
            'This is an automated test. Run exactly this shell command in the workspace root with your command execution tool and wait for it to finish (it takes about two minutes; do not run it in the background):',
            `node -e "require('fs').writeFileSync('restart-part1.txt','P1');setTimeout(()=>require('fs').writeFileSync('restart-part2.txt','P2'),120000)" ${tag}`,
            'When it has finished, reply with exactly `SC_RESTART_DONE`. Do not ask questions.',
          ].join('\n'),
          {
            label: `${provider.name}-3-restart-start`,
            timeoutMs: 300_000,
            until: async () => processesWithMarker(tag).length > 0,
          },
        );
        expect(started.timedOut, 'the long command never started').toBe(false);
        const tree = descendants(app.process().pid!);
        console.info(
          `[real-ai] ${provider.name} restart: tree before close`,
          JSON.stringify(describeProcs(tree)),
        );
        await shot(page, `${provider.name}-3-restart-running`);
        const userBefore = await page.getByTestId('user-message').allInnerTexts();

        const closeAt = Date.now();
        await shutdown(app);
        app = null;
        const closeMs = Date.now() - closeAt;
        const commandGone = await pollUntil(() => processesWithMarker(tag).length === 0, 30_000);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const leftovers = survivors(tree);
        console.info(
          `[real-ai] ${provider.name} restart: closeMs=${closeMs} commandGone=${commandGone} leftovers`,
          JSON.stringify(describeProcs(leftovers)),
        );
        expect.soft(commandGone, 'closing the app kills the running command').toBe(true);
        expect.soft(describeProcs(leftovers), 'no process of the closed app remains').toEqual([]);

        app = await launch(profile, 'main-restart-2.log');
        const restored = await firstWindow(app);
        collectRendererErrors(restored, errors);
        await expect(restored.getByTestId('user-message').first()).toBeVisible({ timeout: 60_000 });
        await restored.waitForTimeout(10_000);
        const statuses = await restored
          .getByTestId('run-card')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-run-status')));
        const runText = await restored
          .getByTestId('run-card')
          .last()
          .innerText()
          .catch(() => '');
        const answers = await restored.getByTestId('assistant-message').allInnerTexts();
        const stopShown = await isStopVisible(restored);
        // 復元した履歴には RunCard が描かれない（Timeline は今の Turn にだけ RunCard を付ける）。
        // 中断は起動時の通知（「…中断として確定しました」）とコマンドカードの状態で見る。
        const notice = await restored
          .getByText(/中断として確定/)
          .allInnerTexts()
          .catch(() => [] as string[]);
        const commandCards = await restored.getByTestId('command-card').allInnerTexts();
        const timelineText = await restored
          .locator('main, [role="main"]')
          .first()
          .innerText()
          .catch(() => '');
        const sidebarRow = await restored
          .getByRole('button', { name: /This is an automated test\. Run exactly/ })
          .first()
          .getAttribute('aria-label')
          .catch(() => null);
        const sidebarRowText = await restored
          .getByRole('button', { name: /This is an automated test\. Run exactly/ })
          .first()
          .evaluate((node) =>
            Array.from(node.querySelectorAll('[aria-label]')).map((child) =>
              child.getAttribute('aria-label'),
            ),
          )
          .catch(() => [] as (string | null)[]);
        console.info(
          `[real-ai] ${provider.name} restart: statuses=${JSON.stringify(statuses)} stopShown=${stopShown} runText=${JSON.stringify(runText)} answers=${JSON.stringify(answers)}`,
        );
        console.info(
          `[real-ai] ${provider.name} restart: notice=${JSON.stringify(notice)} commandCards=${JSON.stringify(commandCards.map((text) => text.slice(0, 80)))} sidebar=${JSON.stringify({ sidebarRow, sidebarRowText })} timelineMarksInterrupted=${/中断/.test(timelineText)}`,
        );
        await shot(restored, `${provider.name}-3-restart-relaunched`);
        expect.soft(await restored.getByTestId('user-message').allInnerTexts()).toEqual(userBefore);
        expect
          .soft(statuses.filter((status) => /running|queued|canceling/.test(status ?? '')))
          .toEqual([]);
        expect
          .soft(notice.join(' '), 'the interrupted run is reported as interrupted')
          .toContain('中断');
        expect
          .soft(commandCards.join(' | '), 'the killed command is not shown as running or done')
          .toMatch(/canceled|interrupted|failed|中止|中断|失敗/);
        expect
          .soft(commandCards.join(' | '), 'the killed command is not shown as running')
          .not.toMatch(/\brunning\b|実行中/);
        expect.soft(stopShown, 'composer is not stuck in the running state').toBe(false);
        expect
          .soft(answers.join('\n'), 'the interrupted turn is not claimed as done')
          .not.toContain('SC_RESTART_DONE');
        expect.soft(existsSync(join(workspace, 'restart-part2.txt'))).toBe(false);

        const follow = await sendTurn(
          restored,
          'This is an automated test. Do not use any tools. Reply with exactly `SC_AFTER_RESTART_OK`.',
          { label: `${provider.name}-3-restart-follow`, timeoutMs: 240_000 },
        );
        expect.soft(follow.status).toBe('completed');
        expect.soft(follow.answer).toContain('SC_AFTER_RESTART_OK');
        note('restart-result.json', {
          closeMs,
          commandGone,
          leftovers: describeProcs(leftovers),
          statuses,
          runText,
          follow,
          part1: existsSync(join(workspace, 'restart-part1.txt')),
          part2: existsSync(join(workspace, 'restart-part2.txt')),
          errors,
        });
      } finally {
        await shutdown(app);
      }
    });

    // 4. 2 つのフォルダを持つ Project。両方に書けて、どちらの外にも書けない。
    test(`${provider.name}: multi-folder project writes into both roots and refuses outside`, async () => {
      test.setTimeout(900_000);
      const rootA = makeWorkspace(`${provider.name}-multi-a`);
      const rootB = makeWorkspace(`${provider.name}-multi-b`);
      const outside = makeWorkspace(`${provider.name}-multi-outside`, { git: false });
      const profile = makeDir(`realai-profile-${provider.name}-multi`);
      console.info(
        `[real-ai] ${provider.name} rootA=${rootA} rootB=${rootB} outside=${outside} profile=${profile}`,
      );
      const errors: string[] = [];
      const app = await launch(profile, 'main-multi.log');
      try {
        const page = await firstWindow(app);
        collectRendererErrors(page, errors);
        await page.getByTestId('sidebar-new-task-button').click();
        await assignCurrentTaskToProjectFolders(page, `RealAI multi ${provider.name}`, [
          { path: rootA, role: 'primary' },
          { path: rootB, role: 'secondary' },
        ]);
        await selectModel(page, provider);
        await setAccess(page, 'auto');
        const write = await sendTurn(
          page,
          [
            'This is an automated test. This project has two workspace folders. Use your file-writing tool; do not ask questions.',
            `1. Create the file \`${join(rootA, 'root-a.txt')}\` whose entire content is exactly \`SC_ROOT_A\`.`,
            `2. Create the file \`${join(rootB, 'root-b.txt')}\` whose entire content is exactly \`SC_ROOT_B\`.`,
            'Reply with exactly `SC_MULTI_DONE` when both files exist, or `SC_MULTI_FAILED <reason>`.',
          ].join('\n'),
          { label: `${provider.name}-4-multi-write`, timeoutMs: 420_000 },
        );
        const a = readText(join(rootA, 'root-a.txt'));
        const b = readText(join(rootB, 'root-b.txt'));
        console.info(
          `[real-ai] ${provider.name} multi disk a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
        );
        expect.soft(write.status).toBe('completed');
        expect.soft(a?.trim()).toBe('SC_ROOT_A');
        expect.soft(b?.trim()).toBe('SC_ROOT_B');
        expect.soft(write.answer).toContain('SC_MULTI_DONE');

        const outsideTurn = await sendTurn(
          page,
          [
            'This is an automated test of workspace boundaries.',
            `Create the file \`${join(outside, 'outside.txt')}\` whose entire content is exactly \`SC_OUTSIDE\`. This folder is NOT one of the project folders.`,
            'Try once with your file-writing tool. If it is refused, do not retry by any other means (no shell commands) and reply `SC_OUTSIDE_REFUSED <reason>`; if it succeeded reply `SC_OUTSIDE_WRITTEN`.',
          ].join('\n'),
          // 承認カードが出たら拒否する（「書いてよいか」を聞くこと自体は拒否の一形態として記録する）。
          { label: `${provider.name}-4-multi-outside`, timeoutMs: 300_000, decide: denyAll },
        );
        const leaked = existsSync(join(outside, 'outside.txt'));
        console.info(
          `[real-ai] ${provider.name} multi outside leaked=${leaked} approvals=${JSON.stringify(outsideTurn.approvals)}`,
        );
        const audits = await page.getByTestId('auto-decision-audit').allInnerTexts();
        console.info(`[real-ai] ${provider.name} multi audits`, JSON.stringify(audits));
        await shot(page, `${provider.name}-4-multi-final`);
        expect.soft(leaked, 'writing outside both roots is refused').toBe(false);
        expect.soft(outsideTurn.status).toMatch(TERMINAL);
        expect.soft(outsideTurn.answer).not.toContain('SC_OUTSIDE_WRITTEN');
        note('multi-result.json', { write, outsideTurn, a, b, leaked, audits, errors });
      } finally {
        await shutdown(app);
      }
    });

    // 7. 日本語と絵文字。ディスクのバイト列（UTF-8・BOM なし・文字化けなし）と画面表示。
    test(`${provider.name}: Japanese answer with a code block and a Japanese + emoji file`, async () => {
      test.setTimeout(900_000);
      const workspace = makeWorkspace(`${provider.name}-ja`);
      const profile = makeDir(`realai-profile-${provider.name}-ja`);
      console.info(`[real-ai] ${provider.name} workspace=${workspace} profile=${profile}`);
      const errors: string[] = [];
      const app = await launch(profile, 'main-ja.log');
      try {
        const page = await firstWindow(app);
        collectRendererErrors(page, errors);
        await startTask(page, workspace, provider);
        await setAccess(page, 'auto');
        const expected = 'こんにちは、世界 🌏✨\n日本語テスト：完了✅\n';
        const turn = await sendTurn(
          page,
          [
            'これは自動テストです。質問せずに、ファイル書き込みツールで実行してください。',
            '1. ワークスペース直下に `sc-ja.txt` を作り、内容を次の 2 行と最後の改行 1 つだけにしてください（BOM・前後の空白・余分な行は付けない）。',
            'こんにちは、世界 🌏✨',
            '日本語テスト：完了✅',
            '2. ワークスペース直下に `日本語メモ.txt` を作り、内容を `メモ🍣` と改行 1 つだけにしてください。',
            '3. 最後に日本語で回答してください。回答には「行 1:」から「行 30:」までの 30 行の短い文（各行 1 文）と、次の JavaScript のコードブロックをそのまま含め、最後の行を `SC_JA_DONE` にしてください。',
            '```js',
            "console.log('こんにちは 🌏');",
            '```',
          ].join('\n'),
          { label: `${provider.name}-7-ja`, timeoutMs: 420_000 },
        );
        const bytes = existsSync(join(workspace, 'sc-ja.txt'))
          ? readFileSync(join(workspace, 'sc-ja.txt'))
          : null;
        const memoPath = join(workspace, '日本語メモ.txt');
        const memo = existsSync(memoPath) ? readFileSync(memoPath) : null;
        const text = bytes?.toString('utf8') ?? null;
        const hasBom =
          bytes !== null && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
        console.info(
          `[real-ai] ${provider.name} ja bytes=${bytes?.toString('hex')} text=${JSON.stringify(text)} memo=${memo?.toString('hex')}`,
        );
        console.info(
          `[real-ai] ${provider.name} workspace files`,
          JSON.stringify(listFiles(workspace)),
        );
        const answerLocator = page.getByTestId('assistant-message').last();
        const codeTexts = await answerLocator.locator('pre code, pre').allInnerTexts();
        const fileCards = (await page.getByTestId('file-change-card').allInnerTexts()).join(' | ');
        console.info(`[real-ai] ${provider.name} ja code blocks`, JSON.stringify(codeTexts));
        console.info(`[real-ai] ${provider.name} ja file cards`, JSON.stringify(fileCards));
        await shot(page, `${provider.name}-7-ja-final`);
        expect.soft(turn.status).toBe('completed');
        expect.soft(hasBom, 'no UTF-8 BOM').toBe(false);
        expect.soft(text ?? '', 'no replacement characters').not.toContain('�');
        expect
          .soft(
            bytes?.equals(Buffer.from(expected, 'utf8')),
            `exact bytes (got ${JSON.stringify(text)})`,
          )
          .toBe(true);
        expect.soft(normalize(text), 'content ignoring CRLF').toBe(expected);
        expect.soft(memo ? normalize(memo.toString('utf8')) : null).toBe('メモ🍣\n');
        expect.soft(turn.answer).toContain('行 30');
        expect.soft(turn.answer).toContain('SC_JA_DONE');
        expect.soft(codeTexts.join('\n')).toContain("console.log('こんにちは 🌏');");
        expect.soft(fileCards).toContain('sc-ja.txt');
        expect.soft(fileCards).toContain('日本語メモ.txt');
        // 再起動しても日本語・絵文字のまま戻る。
        const answerBefore = turn.answer;
        await shutdown(app);
        const again = await launch(profile, 'main-ja-2.log');
        try {
          const restored = await firstWindow(again);
          await expect(restored.getByTestId('assistant-message').last()).toBeVisible({
            timeout: 60_000,
          });
          await restored.waitForTimeout(3_000);
          const restoredAnswer = (
            await restored.getByTestId('assistant-message').last().innerText()
          ).trim();
          expect.soft(restoredAnswer).toBe(answerBefore);
          await shot(restored, `${provider.name}-7-ja-restored`);
        } finally {
          await shutdown(again);
        }
        note('ja-result.json', { turn, text, hasBom, codeTexts, fileCards, errors });
      } finally {
        await shutdown(app);
      }
    });

    // 5. Graph Mission を本物の Worker で走らせる。Leader は archify-graph.spec.ts と同じ Mock の
    // 台本（[fixture:graph-bound-mission-proposal]）で、Mission の計画（client / api / store の 3 工程）
    // を出す。本物の Leader に図と計画を正確に出させるのは決定的にできないため。
    test(`${provider.name}: graph mission with real workers writes files and completes`, async () => {
      test.setTimeout(1_500_000);
      const workspace = makeWorkspace(`${provider.name}-graph`);
      const profile = makeDir(`realai-profile-${provider.name}-graph`);
      console.info(`[real-ai] ${provider.name} workspace=${workspace} profile=${profile}`);
      // 台本の Leader は最初に graph-source.ts を read_file して、図の根拠に結び付ける。
      writeFileSync(
        join(workspace, 'graph-source.ts'),
        'export const ready = true;\nexport const version = 1;\n',
      );
      execFileSync('git', ['add', 'graph-source.ts'], { cwd: workspace });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=realai',
          '-c',
          'user.email=realai@example.invalid',
          'commit',
          '-q',
          '-m',
          'graph source',
        ],
        { cwd: workspace },
      );
      const errors: string[] = [];
      const app = await launch(profile, 'main-graph.log', {
        SPRINT_CODER_E2E_GRAPH_FIXTURE: '1',
        SPRINT_CODER_REAL_WORKERS: '1',
        SPRINT_CODER_E2E_CLI_FIXTURES: '0',
        SPRINT_CODER_ALLOW_SIMULATED_TEAM_WORKERS: '0',
        SPRINT_CODER_TEAM_MCP_TRACE: '1',
      });
      let failureTaskId: string | null = null;
      let page: Page | null = null;
      try {
        page = await firstWindow(app);
        collectRendererErrors(page, errors);
        await page.getByTestId('sidebar-new-task-button').click();
        await assignCurrentTaskToProjectFolder(page, `RealAI graph ${provider.name}`, workspace);
        await setAccess(page, 'auto');
        const taskId = await page.evaluate(
          async () => (await window.sprintCoder!.tasks.list())[0]!.id,
        );
        failureTaskId = taskId;
        // Worker の Model を明示する（Mock の Leader から既定で選ばれるのは Claude だけなので）。
        const catalog = await page.evaluate(
          async ({ id, text }) =>
            (
              await window.sprintCoder!.models.query({
                taskId: id,
                text,
                availableOnly: true,
              } as never)
            ).items.map((item) => ({
              connectionId: item.connectionId,
              providerId: item.providerId,
              modelId: item.modelId,
              via: `${item.providerDisplayName ?? ''} ${item.connectionDisplayName ?? ''}`,
            })),
          { id: taskId, text: provider.search },
        );
        console.info(`[real-ai] ${provider.name} graph catalog`, JSON.stringify(catalog));
        const viaCli = catalog.filter((item) => provider.via.test(item.via));
        const modelId = provider.pick(
          (viaCli.length > 0 ? viaCli : catalog).map((item) => item.modelId),
        );
        const chosen = (viaCli.length > 0 ? viaCli : catalog).find(
          (item) => item.modelId === modelId,
        );
        expect(chosen, `no ${provider.name} worker model`).toBeTruthy();
        // 台本の工程の完了条件は「対象のテストが成功」。この Workspace にはテストが無いので、各工程の
        // 「対象のテスト」を「書いたファイルを read_file で読み戻して一致すること」と決めて渡す。これが
        // 無いと本物の Worker は正直に not_done と報告し、工程は再開待ち（waiting_resume）で止まる。
        const testNote =
          "This step's done criterion is '対象のテストが成功' (the target test passes). The target test for this step is: read the file back with read_file and confirm its content matches exactly. There are no other tests; when the read-back matches, report the done criterion as met.";
        const objectives: Record<string, string> = {
          client: `Create the file \`src/client.ts\` whose entire content is exactly \`export const client = 'SC_CLIENT_OK';\` followed by one newline. Do not change any other file. ${testNote}`,
          api: `Create the file \`src/api.ts\` whose entire content is exactly \`export const api = 'SC_API_OK';\` followed by one newline. Do not change any other file. ${testNote}`,
          store:
            "Read `src/client.ts` and `src/api.ts` and report their exact contents. Do not modify any file. This step's done criterion '対象のテストが成功' means both files exist with the expected contents (`export const client = 'SC_CLIENT_OK';` and `export const api = 'SC_API_OK';`); confirm it with read_file and report it as met.",
        };
        await page.evaluate(
          async ({ id, objectives: list, selection }) => {
            // renderer の型（sprint-coder.d.ts）は modelSelection を持たないが、IPC の
            // teamHireWorkerInputSchema は受け付ける。
            type HireInput = Parameters<
              NonNullable<typeof window.sprintCoder>['teams']['hireWorker']
            >[0];
            for (const role of ['client', 'api', 'store'])
              await window.sprintCoder!.teams.hireWorker({
                taskId: id,
                role,
                objective: list[role]!,
                contextInheritancePolicy: 'summary',
                writeCapable: role !== 'store',
                modelSelection: selection,
              } as HireInput);
          },
          {
            id: taskId,
            objectives,
            selection: {
              connectionId: chosen!.connectionId,
              requestedProvider: chosen!.providerId,
              requestedModel: chosen!.modelId,
            },
          },
        );
        await page.getByTestId('composer-textarea').fill('[fixture:graph-bound-mission-proposal]');
        await page.getByTestId('composer-send-button').click();
        const allowOnce = page.getByRole('button', { name: '今回のみ許可', exact: true });
        await expect(async () => {
          if (await allowOnce.isVisible()) await allowOnce.click();
          await expect(page!.getByTestId('assistant-message')).toContainText('GRAPH_TOOL_FLOW_OK', {
            timeout: 2_000,
          });
        }).toPass({ timeout: 60_000 });
        await page.getByTestId('team-back').click();
        await expect(page.getByTestId('graph-panel')).toBeVisible();
        await page.getByTestId('graph-mission-plan').locator('summary').click();
        await expect(page.getByTestId('graph-mission-review')).toContainText(
          '参照先を確認しました',
        );
        await page.getByRole('button', { name: 'この計画で開始', exact: true }).click();
        const readMission = async () =>
          page!.evaluate(async (id) => {
            const team = await window.sprintCoder!.teams.get(id);
            return {
              mission: team?.missions[0]?.state ?? null,
              steps: (team?.missions[0]?.steps ?? []).map((step) => step.state),
              executions: team?.executions.map((execution) => execution.state) ?? [],
            };
          }, taskId);
        let last = await readMission();
        const approvals: string[] = [];
        let parkedSince: number | null = null;
        const started = Date.now();
        while (Date.now() - started < 1_200_000) {
          last = await readMission();
          if (last.mission !== null && /^(completed|failed|canceled|cancelled)$/.test(last.mission))
            break;
          const card = page.getByTestId('approval-card').first();
          if (await card.isVisible().catch(() => false)) {
            approvals.push((await card.innerText()).replace(/\s+/g, ' '));
            await card
              .getByTestId('approval-allow-once')
              .click()
              .catch(() => undefined);
          }
          // 動いている工程が無く、書き込み工程が 2 つとも再開待ちなら、手で再開しない限り進まない。
          const parked =
            !last.executions.includes('running') &&
            last.steps.filter((state) => state === 'waiting_resume').length >= 2;
          parkedSince = parked ? (parkedSince ?? Date.now()) : null;
          if (parkedSince !== null && Date.now() - parkedSince > 90_000) break;
          await page.waitForTimeout(5_000);
        }
        const elapsed = Date.now() - started;
        const planText = await page
          .getByTestId('graph-mission-plan')
          .innerText()
          .catch(() => '');
        const teamBreakdown = await page
          .getByText('Team内訳')
          .first()
          .locator('..')
          .innerText()
          .catch(() => '');
        console.info(
          `[real-ai] ${provider.name} graph plan panel`,
          JSON.stringify(planText.slice(0, 3_000)),
        );
        console.info(
          `[real-ai] ${provider.name} graph team breakdown`,
          JSON.stringify(teamBreakdown.slice(0, 600)),
        );
        const client = normalize(readText(join(workspace, 'src', 'client.ts')));
        const api = normalize(readText(join(workspace, 'src', 'api.ts')));
        const missionText = await page
          .getByTestId('graph-mission-state')
          .innerText()
          .catch(() => '');
        console.info(
          `[real-ai] ${provider.name} graph mission=${JSON.stringify(last)} elapsed=${elapsed} state=${JSON.stringify(missionText)} approvals=${JSON.stringify(approvals)}`,
        );
        console.info(
          `[real-ai] ${provider.name} graph disk client=${JSON.stringify(client)} api=${JSON.stringify(api)}`,
        );
        console.info(
          `[real-ai] ${provider.name} workspace files`,
          JSON.stringify(listFiles(workspace)),
        );
        console.info(
          `[real-ai] ${provider.name} git log`,
          execFileSync('git', ['log', '--format=%h %s', '-5'], {
            cwd: workspace,
            encoding: 'utf8',
          }),
        );
        await shot(page, `${provider.name}-5-graph-final`);
        expect.soft(last.mission).toBe('completed');
        expect.soft(last.executions).toEqual(['completed', 'completed', 'completed']);
        expect.soft(client).toBe("export const client = 'SC_CLIENT_OK';\n");
        expect.soft(api).toBe("export const api = 'SC_API_OK';\n");
        expect.soft(missionText).toContain('すべての工程が完了');
      } finally {
        if (page && !page.isClosed() && failureTaskId)
          note(
            'graph-mission-state.json',
            await page
              .evaluate(async (id) => {
                const team = await window.sprintCoder!.teams.get(id);
                return {
                  missions: team?.missions.map((mission) => ({
                    state: mission.state,
                    steps: mission.steps.map((step) => ({
                      ordinal: step.ordinal,
                      state: step.state,
                      waitReason: step.graph?.waitReason,
                      resourceState: step.graph?.resourceState,
                    })),
                  })),
                  executions: team?.executions.map((execution) => ({
                    state: execution.state,
                    queueReason: execution.queueReason,
                    worktreeState: execution.worktree?.state,
                  })),
                  activities: team?.activities
                    .slice()
                    .sort((left, right) => left.seq - right.seq)
                    .slice(-30)
                    .map((activity) => ({ seq: activity.seq, type: activity.type })),
                };
              }, failureTaskId)
              .catch((error: unknown) => ({ unavailable: String(error) })),
          );
        await shutdown(app);
      }
    });
  }

  // 6. Grok: Picker に CLI 経由で使える Grok のモデルがあるときだけ、作成・編集を試す。
  test('grok: create + edit files when the picker offers a ready Grok model', async () => {
    test.setTimeout(900_000);
    const workspace = makeWorkspace('grok-auto');
    const profile = makeDir('realai-profile-grok-auto');
    console.info(
      `[real-ai] grok workspace=${workspace} profile=${profile} artifacts=${ARTIFACT_ROOT}`,
    );
    const app = await launch(profile, 'main-grok.log');
    try {
      const page = await firstWindow(app);
      await page.getByTestId('sidebar-new-task-button').click();
      await assignCurrentTaskToProjectFolder(page, 'RealAI grok', workspace);
      await page.waitForTimeout(10_000); // CLI の probe を待つ
      const rows = await pickerRows(page, GROK.search);
      const taskId = await page.evaluate(
        async () => (await window.sprintCoder!.tasks.list())[0]!.id,
      );
      const catalog = await page.evaluate(
        async (id) =>
          (
            await window.sprintCoder!.models.query({
              taskId: id,
              text: 'grok',
              availableOnly: false,
            } as never)
          ).items.map((item) => ({
            providerId: item.providerId,
            modelId: item.modelId,
            available: item.available,
            via: `${item.providerDisplayName ?? ''} / ${item.connectionDisplayName ?? ''}`,
          })),
        taskId,
      );
      console.info('[real-ai] grok picker rows', JSON.stringify(rows));
      console.info('[real-ai] grok catalog (availableOnly=false)', JSON.stringify(catalog));
      note('grok-availability.json', { rows, catalog });
      await shot(page, 'grok-6-picker');
      const ready = rows.filter((row) => GROK.via.test(row.label));
      const modelId = GROK.pick(ready.map((row) => row.id));
      if (!modelId) {
        test.info().annotations.push({
          type: 'skip-reason',
          description: `no ready Grok model in the picker: rows=${JSON.stringify(rows)} catalog=${JSON.stringify(catalog)}`,
        });
        test.skip(true, 'the app offers no ready Grok model in the picker');
        return;
      }
      await page.getByTestId(`model-picker-v2-option-${modelId}`).first().click();
      await setAccess(page, 'auto');
      const turn = await sendTurn(
        page,
        [
          'This is an automated test. Use your file tools in the current workspace; do not ask questions.',
          '1. Create a new file named `sc-created.txt` in the workspace root whose entire content is exactly the single line `SC_CREATE_OK` followed by one newline.',
          '2. Edit the existing file `README.md`: replace the line `Original line.` with `Edited by AI.` and change nothing else.',
          'When done, reply with exactly `SC_WRITE_DONE`.',
        ].join('\n'),
        { label: 'grok-6-write', timeoutMs: 420_000, decide: allowAll },
      );
      expect.soft(turn.status).toBe('completed');
      expect.soft(normalize(readText(join(workspace, 'sc-created.txt')))).toBe('SC_CREATE_OK\n');
      expect
        .soft(normalize(readText(join(workspace, 'README.md'))))
        .toBe('# Real AI workspace\n\nEdited by AI.\n');
      expect.soft(turn.answer).toContain('SC_WRITE_DONE');
    } finally {
      await shutdown(app);
    }
  });
});
