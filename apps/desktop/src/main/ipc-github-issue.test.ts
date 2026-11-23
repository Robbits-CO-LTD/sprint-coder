import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcRouter } from './ipc';
import type { StartedTurn } from './persistence';
import { GITHUB_ISSUE_INPUT_EXAMPLE, parseGithubIssueInput } from '../github-issue-request';
import type * as GithubIssueModule from './github-issue';
import { IPC_CHANNELS } from '@sprint-coder/contracts';

const { showMessageBox, login, request } = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  login: vi.fn<() => Promise<string>>(),
  request: vi.fn<typeof fetch>(),
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
    createGithubIssue: (...args: Parameters<typeof actual.createGithubIssue>) =>
      actual.createGithubIssue(args[0], args[1], args[2], { readToken: login, fetch: request }),
  };
});

const input =
  'https://github.com/team/repo に Issue を起票して\nタイトル: 設定が開かない\n本文: ボタンを押しても応答しません。\nWindowsで再現。';
const endpoint = 'https://api.github.com/repos/team/repo';

function harness(text = input) {
  const localOnly = vi.fn(() => false);
  let activeTurn: string | null = 'turn-1';
  let policyEpoch = 1;
  const finish = vi.fn(() => {
    activeTurn = null;
  });
  const appendDelta = vi.fn();
  const persistence = {
    getActiveTurnId: () => activeTurn,
    getPermissionPolicy: () => ({ policyEpoch, revokedCapabilities: [] }),
    getTask: () => ({ localOnly: localOnly() }),
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
    start: () => router.startSelectedRuntime(started, true),
    async startViaIpc() {
      type Handler = (input: object, event: object, envelope: object) => Promise<unknown>;
      const handlers = new Map<string, Handler>();
      const register = (channel: string, _input: unknown, _output: unknown, handler: Handler) =>
        handlers.set(channel, handler);
      let running: Promise<void> | undefined;
      Object.assign(persistence, { startTurn: () => started });
      Object.assign(router, {
        handle: register,
        handleMutation: register,
        refreshTeamOfferWorkspace: vi.fn(),
        runMutation: (
          _event: unknown,
          _envelope: unknown,
          _taskId: unknown,
          _channel: unknown,
          run: () => unknown,
        ) => ({ executed: true, value: run() }),
        dispatchStarted: (turn: StartedTurn, isUserInput: boolean) => {
          running = router.startSelectedRuntime(turn, isUserInput);
        },
      });
      router.register();
      const accepted = await handlers.get(IPC_CHANNELS.turnsStart)!(
        { taskId: started.event.taskId, text, skills: [], attachmentIds: [] },
        {},
        {},
      );
      await running;
      return accepted;
    },
    changePolicy: () => {
      policyEpoch += 1;
    },
    localOnly,
    finish,
    appendDelta,
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
  it('leaves ordinary discussions alone and keeps the input example inert', () => {
    for (const text of [
      'GitHubでIssueを起票する方法は？',
      'Issueの起票内容を考えて',
      'Issueを起票してくださいという文章を添削して',
    ]) {
      expect(parseGithubIssueInput(text)).toBeNull();
    }
    expect(parseGithubIssueInput(GITHUB_ISSUE_INPUT_EXAMPLE)).toEqual({ kind: 'incomplete' });
    expect(parseGithubIssueInput('GitHub CLIで Issue を起票して')).toEqual({ kind: 'incomplete' });
    expect(parseGithubIssueInput(input.replace('github.com', 'example.com'))).toEqual({
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
    await expect(h.startViaIpc()).resolves.toEqual({ turnId: 'turn-1' });
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
