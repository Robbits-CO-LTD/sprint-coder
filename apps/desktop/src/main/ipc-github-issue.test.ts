import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcRouter } from './ipc';
import type { StartedTurn } from './persistence';
import {
  GITHUB_INPUT_EXAMPLES,
  GITHUB_ISSUE_INPUT_EXAMPLE,
  GITHUB_PUSH_INPUT_EXAMPLE,
  githubInputHelp,
  parseGithubActionInput,
} from '../github-issue-request';
import type * as GithubIssueModule from './github-issue';
import { githubLoginEnvironment } from './github-issue';
import type * as GithubPushModule from './github-push-transport';
import { LocalGithubPushError } from './local-github-push';
import { IPC_CHANNELS } from '@sprint-coder/contracts';

const { showMessageBox, login, request, push } = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  login: vi.fn<() => Promise<string>>(),
  request: vi.fn<typeof fetch>(),
  push: vi.fn<typeof GithubPushModule.pushApprovedGithubCommit>(),
}));

vi.mock('./github-push-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubPushModule>()),
  pushApprovedGithubCommit: push,
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  clipboard: {},
  dialog: { showMessageBox },
  ipcMain: { on: vi.fn() },
  MessageChannelMain: class {},
  BrowserWindow: class {},
  nativeImage: {},
  shell: {},
  utilityProcess: {},
  session: {},
  safeStorage: {},
  screen: {},
  globalShortcut: {},
}));

vi.mock('./github-issue', async (importOriginal) => {
  const actual = await importOriginal<typeof GithubIssueModule>();
  return {
    ...actual,
    writeGithubContent: (...args: Parameters<typeof actual.writeGithubContent>) =>
      actual.writeGithubContent(args[0], args[1], args[2], {
        ...args[3],
        readToken: login,
        fetch: request,
      }),
  };
});

const input =
  'https://github.com/team/repo に Issue を起票して\nタイトル: 設定が開かない\n本文: ボタンを押しても応答しません。\nWindowsで再現。';
const endpoint = 'https://api.github.com/repos/team/repo';
const commentInput =
  'https://github.com/team/repo/issues/42 にコメントして\n本文: Windowsでも再現しました。';
const pullInput =
  'https://github.com/team/repo にPRを作成して\n元ブランチ: fix/settings\n先ブランチ: main\nタイトル: 設定の修正\n本文: 設定画面を修正しました。';

function harness(text = input) {
  const localOnly = vi.fn(() => false);
  let activeTurn: string | null = 'turn-1';
  let policyEpoch = 1;
  const finish = vi.fn(() => {
    activeTurn = null;
  });
  const appendDelta = vi.fn();
  const prepareLocalGithubPush = vi.fn();
  const cancelTurnAndFinishGoal = vi.fn((_taskId: string, _turnId: string, _message?: string) => {
    activeTurn = null;
    return { event: null, task: null };
  });
  const replaceActiveTurn = vi.fn(() => {
    activeTurn = 'turn-2';
    return { started: { turnId: activeTurn }, canceledEvent: null };
  });
  const persistence = {
    getActiveTurnId: () => activeTurn,
    getOperationResult: () => ({ found: false }),
    replaceActiveTurn,
    getPermissionPolicy: () => ({ policyEpoch, revokedCapabilities: [] }),
    getTask: () => ({ localOnly: localOnly() }),
    readTurnWorkspaceSetForTask: () => ({
      primaryRootId: 'root',
      roots: [{ rootId: 'root', path: '/fixture' }],
    }),
    changeStage: vi.fn(),
    appendDelta,
  };
  const router = Object.assign(
    Object.create(IpcRouter.prototype) as {
      startSelectedRuntime(turn: StartedTurn, userChatInput: boolean): Promise<void>;
      register(): void;
    },
    {
      persistence,
      permissionBroker: { prepareLocalGithubPush },
      window: { webContents: { once: vi.fn() } },
      githubActions: new Map(),
      canceledRuntimeTurns: new Set(),
      pendingTaskTitles: new Map(),
      attachmentCapabilityByTurn: new Map(),
      publish: vi.fn(),
      finishAndAdvance: finish,
    },
  );
  const started: StartedTurn = {
    turnId: 'turn-1',
    text,
    runtimeKind: 'mock',
    model: 'auto',
    modelSelection: { connectionId: null, requestedProvider: null, requestedModel: null },
    skills: [],
    autoSkills: [],
    teamTurn: false,
    sealId: 'seal',
    contextUsageEvents: [],
    workspaceSet: {
      roots: [],
      primaryRootId: null,
      digest: 'empty',
      source: 'none',
      projectId: null,
    },
    event: {
      type: 'stage.changed',
      taskId: 'task-1',
      turnId: 'turn-1',
      seq: 1,
      stage: 'understanding',
    },
  };
  return {
    prepareLocalGithubPush,
    start: () => router.startSelectedRuntime(started, true),
    registerIpc() {
      type Handler = (input: object, event: object, envelope: object) => Promise<unknown>;
      const handlers = new Map<string, Handler>();
      const register = (channel: string, _input: unknown, _output: unknown, handler: Handler) =>
        handlers.set(channel, handler);
      let running: Promise<void> | undefined;
      Object.assign(persistence, {
        startTurn: () => started,
        cancelTurnAndFinishGoal,
      });
      Object.assign(router, {
        handle: register,
        handleMutation: register,
        refreshTeamOfferWorkspace: vi.fn(),
        resolveTurnSkills: async () => [],
        pendingStopAndSendByOperation: new Map(),
        cancelRuntime: async () => {
          await running;
          return true;
        },
        approvalCoordinator: { turnEnded: vi.fn() },
        dispatchQueueTransition: vi.fn(),
        releaseCanceledRuntime: (turnId: string) => router.githubActions.delete(turnId),
        runMutation: (
          _event: unknown,
          _envelope: unknown,
          _taskId: unknown,
          _channel: unknown,
          run: () => unknown,
        ) => ({ executed: true, value: run() }),
        dispatchStarted: (turn: StartedTurn, isUserInput: boolean) => {
          if (turn.turnId === started.turnId)
            running = router.startSelectedRuntime(turn, isUserInput);
        },
      });
      router.register();
      return {
        start: async () => {
          const accepted = await handlers.get(IPC_CHANNELS.turnsStart)!(
            { taskId: started.event.taskId, text, skills: [], attachmentIds: [] },
            {},
            {},
          );
          await running;
          return accepted;
        },
        cancel: async () => {
          await handlers.get(IPC_CHANNELS.turnsCancel)!(
            { taskId: started.event.taskId, turnId: started.turnId },
            {},
            {},
          );
        },
        replace: () => {
          const payload = { taskId: started.event.taskId, text: 'next request', skills: [] };
          return handlers.get(IPC_CHANNELS.turnsStopAndSend)!(
            payload,
            {},
            { payload, operationId: 'replace-1' },
          );
        },
      };
    },
    changePolicy: () => {
      policyEpoch += 1;
    },
    localOnly,
    finish,
    appendDelta,
    cancelTurnAndFinishGoal,
    replaceActiveTurn,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  login.mockResolvedValue('local_test_credential');
  request.mockImplementation(
    async () =>
      new Response(JSON.stringify({ number: 17, repository_url: endpoint }), { status: 201 }),
  );
});

describe('GitHub Issue request in chat', () => {
  it('rejects missing or whitespace-only issue bodies', async () => {
    for (const body of ['', ' \t\n　']) {
      const text = input.replace(/本文:[\s\S]*$/u, `本文:${body}`);
      expect(parseGithubActionInput(text)).toEqual({ kind: 'incomplete', action: 'issue' });
      await harness(text).start();
    }
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps only CLI login and OS session environment keys', () => {
    const source = {
      HOME: '/home/example',
      GH_CONFIG_DIR: '/home/example/github',
      XDG_CONFIG_HOME: '/home/example/.config',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_RUNTIME_DIR: '/run/user/1000',
      GH_TOKEN: 'secret',
      OPENAI_API_KEY: 'secret',
      SSH_AUTH_SOCK: '/tmp/ssh.sock',
      NODE_OPTIONS: '--require=hook',
    };
    expect(githubLoginEnvironment('linux', source)).toEqual({
      HOME: source.HOME,
      GH_CONFIG_DIR: source.GH_CONFIG_DIR,
      XDG_CONFIG_HOME: source.XDG_CONFIG_HOME,
      DBUS_SESSION_BUS_ADDRESS: source.DBUS_SESSION_BUS_ADDRESS,
      XDG_RUNTIME_DIR: source.XDG_RUNTIME_DIR,
      PATH: expect.any(String),
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
    });
    expect(
      githubLoginEnvironment('win32', { AppData: 'C:\\Profile', gh_config_dir: 'C:\\GitHub' }),
    ).toMatchObject({ APPDATA: 'C:\\Profile', GH_CONFIG_DIR: 'C:\\GitHub' });
  });

  it('leaves ordinary discussions alone and keeps the input example inert', () => {
    for (const text of [
      'GitHubでIssueを起票する方法は？',
      'Issueの起票内容を考えて',
      'Issueを起票してくださいという文章を添削して',
      'この文章にコメントして',
      '.github/workflows/ci.yml にコメントして',
      'src/issue-list.ts にコメントして',
    ]) {
      expect(parseGithubActionInput(text)).toBeNull();
    }
    expect(parseGithubActionInput(GITHUB_ISSUE_INPUT_EXAMPLE)).toMatchObject({
      kind: 'incomplete',
    });
    expect(parseGithubActionInput('GitHub CLIで Issue を起票して')).toMatchObject({
      kind: 'incomplete',
    });
    expect(parseGithubActionInput(input.replace('github.com', 'example.com'))).toMatchObject({
      kind: 'incomplete',
    });
  });

  it('shows the exact request, and performs one fixed POST after explicit approval', async () => {
    let approve!: (result: { response: number }) => void;
    showMessageBox.mockImplementation(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    );
    const h = harness();
    const pending = h.start();
    await h.start();
    expect(showMessageBox).toHaveBeenCalledOnce();
    expect(showMessageBox.mock.calls[0]?.[1]).toMatchObject({ defaultId: 0, cancelId: 0 });
    const detail = showMessageBox.mock.calls[0]?.[1].detail;
    expect(detail).toContain('https://github.com/team/repo');
    expect(detail).toContain('設定が開かない');
    expect(detail).toContain('ボタンを押しても応答しません。\nWindowsで再現。');
    expect(login).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();

    approve({ response: 1 });
    await pending;
    await h.start();
    expect(login).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]).toEqual([
      `${endpoint}/issues`,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify({
          title: '設定が開かない',
          body: 'ボタンを押しても応答しません。\nWindowsで再現。',
        }),
      }),
    ]);
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(
      'task-1',
      'turn-1',
      'completed',
      expect.stringContaining('https://github.com/team/repo/issues/17'),
    );
    expect(JSON.stringify(h.appendDelta.mock.calls)).not.toContain('local_test_credential');
  });

  it.each([
    { text: input, destination: 'リポジトリのIssue一覧' },
    {
      text: pullInput,
      destination: 'リポジトリのPR一覧',
    },
  ])(
    'persists an unknown result when stopping after a POST starts ($destination)',
    async ({ text, destination }) => {
      expect(parseGithubActionInput(text)).toMatchObject({ kind: 'create' });
      showMessageBox.mockResolvedValue({ response: 1 });
      request.mockImplementation(async (_url, init) => {
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        });
      });
      const h = harness(text);
      const ipc = h.registerIpc();
      const started = ipc.start();
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

      await ipc.cancel();
      await started;

      expect(h.cancelTurnAndFinishGoal).toHaveBeenCalledWith(
        'task-1',
        'turn-1',
        expect.stringContaining(`再送する前に${destination}`),
      );
      expect(h.appendDelta).not.toHaveBeenCalled();
      expect(h.finish).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it('keeps the original POST notice when a stop-and-send transaction is retried', async () => {
    showMessageBox.mockResolvedValue({ response: 1 });
    request.mockImplementation(async (_url, init) => {
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const h = harness();
    h.replaceActiveTurn.mockImplementationOnce(() => {
      throw new Error('replacement seal failed');
    });
    const ipc = h.registerIpc();
    const started = ipc.start();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    await expect(ipc.replace()).rejects.toThrow('replacement seal failed');
    await started;
    await expect(ipc.replace()).resolves.toBeUndefined();

    expect(h.replaceActiveTurn).toHaveBeenCalledTimes(2);
    expect(h.replaceActiveTurn).toHaveBeenLastCalledWith(
      'task-1',
      'turn-1',
      'next request',
      [],
      false,
      expect.stringContaining('再送する前にリポジトリのIssue一覧'),
    );
    expect(h.finish).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not mark a comment as possibly sent when stopped during destination verification', async () => {
    const text = commentInput;
    expect(parseGithubActionInput(text)).toMatchObject({ kind: 'create' });
    showMessageBox.mockResolvedValue({ response: 1 });
    request.mockImplementation(async (_url, init) => {
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const h = harness(text);
    const ipc = h.registerIpc();
    const started = ipc.start();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    await ipc.cancel();
    await started;

    expect(h.cancelTurnAndFinishGoal).toHaveBeenCalledExactlyOnceWith(
      'task-1',
      'turn-1',
      undefined,
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `${endpoint}/issues/42`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('does not authenticate or make a request when canceled', async () => {
    showMessageBox.mockResolvedValue({ response: 0 });
    const h = harness();
    await h.start();
    expect(login).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledWith(
      'task-1',
      'turn-1',
      'completed',
      expect.stringContaining('取り消しました'),
    );
  });

  it('accepts the explicitly formatted composer request without a provider selection', async () => {
    showMessageBox.mockResolvedValue({ response: 1 });
    const h = harness();
    await expect(h.registerIpc().start()).resolves.toEqual({ turnId: 'turn-1' });
    expect(request).toHaveBeenCalledOnce();
    expect(h.finish).toHaveBeenCalledWith(
      'task-1',
      'turn-1',
      'completed',
      expect.stringContaining('/issues/17'),
    );
  });

  it('shows the example without opening approval for an incomplete request', async () => {
    const h = harness('GitHubにIssueを起票して');
    await h.start();
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledWith(
      'task-1',
      'turn-1',
      'completed',
      expect.stringContaining(GITHUB_ISSUE_INPUT_EXAMPLE),
    );
  });

  it('blocks a local-only Task and rechecks authority after reading the login', async () => {
    const local = harness();
    local.localOnly.mockReturnValue(true);
    await local.start();
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();

    const allowed = harness();
    showMessageBox.mockResolvedValue({ response: 1 });
    login.mockImplementation(async () => {
      allowed.changePolicy();
      return 'local_test_credential';
    });
    await allowed.start();
    expect(request).not.toHaveBeenCalled();
    expect(allowed.finish).toHaveBeenCalledWith(
      'task-1',
      'turn-1',
      'failed',
      expect.stringContaining('送信していません'),
    );
  });

  it('does not retry an uncertain response', async () => {
    showMessageBox.mockResolvedValue({ response: 1 });
    request.mockRejectedValue(new Error('timeout with sensitive request details'));
    const h = harness();
    await h.start();
    expect(request).toHaveBeenCalledOnce();
    expect(h.finish).toHaveBeenCalledWith(
      'task-1',
      'turn-1',
      'failed',
      expect.stringContaining('二重投稿'),
    );
    expect(JSON.stringify(h.appendDelta.mock.calls)).not.toContain('sensitive request details');
  });
});

describe('GitHub input help', () => {
  it.each(['issue', 'comment', 'pull'] as const)(
    'documents valid %s input and body limits',
    (action) => {
      const example = GITHUB_INPUT_EXAMPLES[action].replace('<所有者>/<リポジトリ>', 'team/repo');
      const help = githubInputHelp(action);
      const [, lines, length] = /本文は(\d+)行・(\d+)文字以内/u.exec(help) ?? [];
      expect(lines).toBeDefined();
      expect(length).toBeDefined();
      expect(help).toContain(GITHUB_INPUT_EXAMPLES[action]);
      expect(parseGithubActionInput(example)).toMatchObject({
        kind: 'create',
        request: { action },
      });
      for (const [body, kind] of [
        ['あ'.repeat(Number(length)), 'create'],
        ['あ'.repeat(Number(length) + 1), 'incomplete'],
        [Array<string>(Number(lines)).fill('あ').join('\n'), 'create'],
        [
          Array<string>(Number(lines) + 1)
            .fill('あ')
            .join('\n'),
          'incomplete',
        ],
      ] as const) {
        expect(parseGithubActionInput(example.replace(/本文: .*$/u, '本文: ' + body))?.kind).toBe(
          kind,
        );
      }
    },
  );

  it.each(['issue', 'pull'] as const)('uses the documented title limit for %s', (action) => {
    const example = GITHUB_INPUT_EXAMPLES[action].replace('<所有者>/<リポジトリ>', 'team/repo');
    const [, length] = /タイトルは(\d+)文字以内/u.exec(githubInputHelp(action)) ?? [];
    expect(length).toBeDefined();
    const withTitle = (titleLength: number) =>
      parseGithubActionInput(
        example.replace(/タイトル: .*$/mu, 'タイトル: ' + 'あ'.repeat(titleLength)),
      );
    expect(withTitle(Number(length))?.kind).toBe('create');
    expect(withTitle(Number(length) + 1)?.kind).toBe('incomplete');
  });

  it('shows comment-only instructions in chat without opening approval or contacting GitHub', async () => {
    const withTitle = commentInput.replace('本文:', 'タイトル: 再現報告\n本文:');
    expect(parseGithubActionInput(withTitle)).toEqual({ kind: 'incomplete', action: 'comment' });

    const h = harness(withTitle);
    await h.registerIpc().start();
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledWith(
      'task-1',
      'turn-1',
      'completed',
      githubInputHelp('comment'),
    );
    expect(githubInputHelp('comment')).toContain('GitHub IssueのURL');
    expect(githubInputHelp('comment')).not.toContain('タイトル');
  });
});

describe('GitHub comments and pull requests', () => {
  it.each(['#issuecomment-123456', '?view=compact#issuecomment-123456'])(
    'uses the containing Issue when its link ends in %s',
    (suffix) => {
      const linked = commentInput.replace('/issues/42', '/issues/42' + suffix);
      expect(parseGithubActionInput(linked)).toEqual(parseGithubActionInput(commentInput));
      expect(parseGithubActionInput(linked)?.kind).toBe('create');
    },
  );

  it('still explains how to complete an explicit Issue comment request', () => {
    for (const text of [
      'https://github.com/team/repo/issues/42 にコメントして',
      'GitHubのIssueにコメントして',
      'GitHubにコメントして',
      'Issueにコメントを投稿してください',
    ]) {
      expect(parseGithubActionInput(text)).toEqual({ kind: 'incomplete', action: 'comment' });
    }
  });

  it('shows the destination and body, checks the Issue, then posts the exact comment', async () => {
    const issue = `${endpoint}/issues/42`;
    showMessageBox.mockResolvedValue({ response: 1 });
    request
      .mockResolvedValueOnce(new Response(JSON.stringify({ number: 42, repository_url: endpoint })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 11, issue_url: issue }), { status: 201 }),
      );
    const h = harness(commentInput);
    await h.registerIpc().start();
    expect(showMessageBox.mock.calls[0]?.[1].detail).toContain(
      'https://github.com/team/repo/issues/42\n\n本文:\nWindowsでも再現しました。',
    );
    expect(request).toHaveBeenNthCalledWith(
      1,
      issue,
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      `${issue}/comments`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ body: 'Windowsでも再現しました。' }),
      }),
    );
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(
      'task-1',
      'turn-1',
      'completed',
      expect.stringContaining('/issues/42#issuecomment-11'),
    );
  });

  it('does not post a comment to a pull request', async () => {
    showMessageBox.mockResolvedValue({ response: 1 });
    request.mockResolvedValueOnce(
      new Response(JSON.stringify({ number: 42, repository_url: endpoint, pull_request: {} })),
    );
    const h = harness(commentInput);
    await h.start();
    expect(request).toHaveBeenCalledOnce();
    expect(h.finish).toHaveBeenCalledWith(
      'task-1',
      'turn-1',
      'failed',
      expect.stringContaining('投稿していません'),
    );
  });

  it('rechecks the Task authority after reading the Issue and skips the write if it changed', async () => {
    showMessageBox.mockResolvedValue({ response: 1 });
    const h = harness(commentInput);
    request.mockImplementationOnce(async () => {
      h.changePolicy();
      return new Response(JSON.stringify({ number: 42, repository_url: endpoint }));
    });
    await h.start();
    expect(request).toHaveBeenCalledOnce();
    expect(h.finish).toHaveBeenCalledWith(
      'task-1',
      'turn-1',
      'failed',
      expect.stringContaining('投稿していません'),
    );
  });

  it('shows the repository and branch direction, then creates one PR', async () => {
    showMessageBox.mockResolvedValue({ response: 1 });
    request.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          number: 19,
          head: { ref: 'fix/settings', repo: { full_name: 'team/repo' } },
          base: { ref: 'main', repo: { full_name: 'team/repo' } },
        }),
        { status: 201 },
      ),
    );
    const h = harness(pullInput);
    await h.registerIpc().start();
    expect(showMessageBox.mock.calls[0]?.[1].detail).toContain(
      '元ブランチ: fix/settings\n\n先ブランチ: main',
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `${endpoint}/pulls`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          title: '設定の修正',
          body: '設定画面を修正しました。',
          head: 'fix/settings',
          base: 'main',
        }),
      }),
    );
    expect(h.finish).toHaveBeenCalledWith(
      'task-1',
      'turn-1',
      'completed',
      expect.stringContaining('/pull/19'),
    );
  });

  it.each([commentInput, pullInput])(
    'does not access GitHub when approval is canceled',
    async (text) => {
      showMessageBox.mockResolvedValue({ response: 0 });
      await harness(text).start();
      expect(login).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('rejects cross-repository PR branch syntax before approval', async () => {
    await harness(pullInput.replace('fix/settings', 'other:fix/settings')).start();
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('only attempts one PR write for concurrent delivery and an uncertain response', async () => {
    let approve!: (result: { response: number }) => void;
    showMessageBox.mockImplementation(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    );
    request.mockRejectedValue(new Error('timeout'));
    const h = harness(pullInput);
    const pending = h.start();
    await h.start();
    expect(showMessageBox).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    approve({ response: 1 });
    await pending;
    expect(request).toHaveBeenCalledOnce();
    expect(h.finish).toHaveBeenCalledWith(
      'task-1',
      'turn-1',
      'failed',
      expect.stringContaining('PR一覧'),
    );
  });
});

describe('Local commit push in normal chat', () => {
  it.each(['push して', 'GitHubにpushして'])(
    'shows the existing push example for %s with no approval or side effects',
    async (text) => {
      const h = harness(text);
      await h.registerIpc().start();
      expect(h.finish).toHaveBeenCalledWith(
        'task-1',
        'turn-1',
        'completed',
        expect.stringContaining(GITHUB_PUSH_INPUT_EXAMPLE),
      );
      expect(h.prepareLocalGithubPush).not.toHaveBeenCalled();
      expect(showMessageBox).not.toHaveBeenCalled();
      expect(login).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    },
  );

  const commitOid = 'a'.repeat(40);
  const parent = 'b'.repeat(40);
  const requestText =
    'https://github.com/team/repo に push して\nブランチ: main\nコミット: ' + commitOid;
  const prepare = () => {
    const h = harness(requestText);
    const prepared = Object.freeze({
      commitOid,
      commit: Object.freeze({ parent }),
      paths: Object.freeze(['readme.md']),
    });
    const isStillAuthorized = vi.fn(() => true);
    h.prepareLocalGithubPush.mockResolvedValue({ prepared, isStillAuthorized });
    return { h, prepared, isStillAuthorized };
  };

  it.each([
    ['deletion_not_supported', '削除を含む'],
    ['uncomparable_parent', 'ファイル構成を確認できませんでした'],
  ] as const)('explains %s without opening approval or contacting GitHub', async (code, reason) => {
    const { h } = prepare();
    h.prepareLocalGithubPush.mockRejectedValue(new LocalGithubPushError(code));
    await h.registerIpc().start();
    expect(h.finish).toHaveBeenCalledWith(
      'task-1',
      'turn-1',
      'failed',
      expect.stringContaining(reason),
    );
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('never sends on cancellation and hands the exact frozen bytes to the transport after approval', async () => {
    const canceled = prepare();
    showMessageBox.mockResolvedValueOnce({ response: 0 });
    await canceled.h.registerIpc().start();
    expect(push).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();

    const approved = prepare();
    showMessageBox.mockImplementationOnce(async () => {
      expect(push).not.toHaveBeenCalled();
      return { response: 1 };
    });
    push.mockResolvedValue('https://github.com/team/repo/tree/main');
    await approved.h.registerIpc().start();
    expect(approved.h.prepareLocalGithubPush).toHaveBeenCalledWith(
      expect.objectContaining({
        rootId: 'root',
        taskId: 'task-1',
        turnId: 'turn-1',
        commitOid,
      }),
    );
    expect(showMessageBox.mock.calls.at(-1)?.[1].detail).toContain('readme.md');
    expect(showMessageBox.mock.calls.at(-1)?.[1].detail).toContain(parent);
    expect(push).toHaveBeenCalledOnce();
    expect(push.mock.calls[0]?.[0].prepared).toBe(approved.prepared);
    expect(approved.h.finish).toHaveBeenCalledWith(
      'task-1',
      'turn-1',
      'completed',
      expect.stringContaining('/tree/main'),
    );
  });

  it('after upload has begun, stores a result warning when the user stops the Turn', async () => {
    const { h } = prepare();
    showMessageBox.mockResolvedValueOnce({ response: 1 });
    push.mockImplementation(async ({ signal, onPostStarted }) => {
      onPostStarted('確認先のブランチを再送前に確認してください。');
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const ipc = h.registerIpc();
    const pending = ipc.start();
    await vi.waitFor(() => expect(push).toHaveBeenCalledOnce());
    await ipc.cancel();
    await pending;
    expect(h.cancelTurnAndFinishGoal).toHaveBeenCalledWith(
      'task-1',
      'turn-1',
      '確認先のブランチを再送前に確認してください。',
    );
  });
});
