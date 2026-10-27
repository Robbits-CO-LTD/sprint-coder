// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import {
  SUBMODULE_DISCARD_WARNING,
  TeamRetainedWorktreesDialog,
  TeamRetainedWorktreesTrigger,
  retainedWorktreeDiscardWarning,
} from './TeamRetainedWorktrees';
import type {
  TeamDetail,
  TeamRetainedWorktree,
  TeamRetainedWorktreeCursor,
  TeamRetainedWorktreeInspection,
  TeamRetainedWorktreeList,
  TeamRetainedWorktreeRef,
} from '../types/sprint-coder';

const UNINTEGRATED_WARNING =
  'このworktreeの変更はWorkspaceに統合されていません。破棄すると元に戻せません。';
const INTEGRATED_WARNING = '変更はWorkspaceに統合済みです。残っている隔離worktreeを削除します。';

function worktree(overrides: Partial<TeamRetainedWorktree> = {}): TeamRetainedWorktree {
  return {
    executionId: 'execution-1',
    repositoryOrdinal: 1,
    agentId: 'worker-1',
    role: 'writer',
    repoPath: '/repo',
    worktreePath: '/worktrees/worktree-execution-1-1',
    baseHead: 'a'.repeat(40),
    workerHead: null,
    integratedHead: null,
    integration: 'none',
    submodules: false,
    changedFileCount: 0,
    reason: 'Worker failed after writing',
    executionState: 'failed',
    existsOnDisk: true,
    discardable: true,
    blockedReason: null,
    ...overrides,
  };
}

const failed = worktree();
const integrated = worktree({
  executionId: 'execution-2',
  role: 'finisher',
  workerHead: 'b'.repeat(40),
  integratedHead: 'c'.repeat(40),
  integration: 'confirmed',
  changedFileCount: 3,
  reason: 'Integrated repository worktree remained dirty during cleanup',
  executionState: 'completed',
  worktreePath: '/worktrees/worktree-execution-2-1',
});
const blocked = worktree({
  executionId: 'execution-3',
  role: 'waiting writer',
  executionState: 'waiting_resume',
  discardable: false,
  blockedReason: 'この実行はまだ終わっていないため破棄できません。再開や統合で使われます。',
  worktreePath: '/worktrees/worktree-execution-3-1',
});

const detail = { executions: [] } as unknown as TeamDetail;

type ListFn = (
  taskId: string,
  cursor?: TeamRetainedWorktreeCursor,
) => Promise<TeamRetainedWorktreeList>;
type InspectFn = (input: TeamRetainedWorktreeRef) => Promise<TeamRetainedWorktreeInspection>;
type OpenFn = (input: TeamRetainedWorktreeRef) => Promise<void>;
type DiscardFn = (input: TeamRetainedWorktreeRef) => Promise<TeamRetainedWorktreeList>;
type Api = {
  listRetainedWorktrees: Mock<ListFn>;
  inspectRetainedWorktree: Mock<InspectFn>;
  openRetainedWorktree: Mock<OpenFn>;
  discardRetainedWorktree: Mock<DiscardFn>;
};

let container: HTMLDivElement;
let root: Root;
let api: Api;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

beforeAll(() => {
  // jsdom has no modal dialogs; open and close them the way the browser reflects it.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.setAttribute('open', '');
      this.querySelector<HTMLElement>('[autofocus]')?.focus();
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.removeAttribute('open');
    },
  });
});

afterAll(() => {
  for (const [name, descriptor] of [
    ['showModal', originalShowModal],
    ['close', originalClose],
  ] as const) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    else Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
  }
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api = {
    listRetainedWorktrees: vi.fn<ListFn>(async () => ({
      worktrees: [failed, integrated, blocked],
      total: 3,
      nextCursor: null,
    })),
    inspectRetainedWorktree: vi.fn<InspectFn>(async (input) => ({
      executionId: input.executionId,
      repositoryOrdinal: input.repositoryOrdinal,
      head: 'd'.repeat(40),
      commitsSinceBase: 1,
      status: [{ code: '??', path: 'kept.txt' }],
      statusTruncated: false,
      changesFromBase: [{ status: 'M', path: 'README.md' }],
      changesFromBaseTruncated: false,
    })),
    openRetainedWorktree: vi.fn<OpenFn>(async () => undefined),
    discardRetainedWorktree: vi.fn<DiscardFn>(async () => ({
      worktrees: [integrated, blocked],
      total: 2,
      nextCursor: null,
    })),
  };
  Object.defineProperty(window, 'sprintCoder', { configurable: true, value: { teams: api } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, 'sprintCoder');
  vi.unstubAllGlobals();
});

async function renderDialog(onClose: () => void = () => undefined): Promise<void> {
  await act(async () => {
    root.render(<TeamRetainedWorktreesDialog taskId="task-1" detail={detail} onClose={onClose} />);
  });
  await act(async () => {});
}

function items(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="team-retained-worktree"]')];
}

function button(item: HTMLElement, testId: string): HTMLButtonElement {
  const found = item.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(found).not.toBeNull();
  return found!;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await act(async () => {});
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Holds each inspect request until the test settles it, in the order they were made. */
function pendingInspections(): Deferred<TeamRetainedWorktreeInspection>[] {
  const pending: Deferred<TeamRetainedWorktreeInspection>[] = [];
  api.inspectRetainedWorktree.mockImplementation(() => {
    const next = deferred<TeamRetainedWorktreeInspection>();
    pending.push(next);
    return next.promise;
  });
  return pending;
}

function inspectionOf(
  target: Pick<TeamRetainedWorktree, 'executionId' | 'repositoryOrdinal'>,
  changedPath: string,
): TeamRetainedWorktreeInspection {
  return {
    executionId: target.executionId,
    repositoryOrdinal: target.repositoryOrdinal,
    head: 'e'.repeat(40),
    commitsSinceBase: 0,
    status: [{ code: '??', path: changedPath }],
    statusTruncated: false,
    changesFromBase: [],
    changesFromBaseTruncated: false,
  };
}

async function settle(run: () => void): Promise<void> {
  await act(async () => {
    run();
  });
  await act(async () => {});
}

function panel(item: HTMLElement): HTMLElement | null {
  return item.querySelector<HTMLElement>('[data-testid="team-retained-inspection"]');
}

describe('TeamRetainedWorktreesTrigger (issue #544)', () => {
  it('names how many worktrees are left and hides itself when none are', () => {
    expect(renderToStaticMarkup(<TeamRetainedWorktreesTrigger count={0} onOpen={() => {}} />)).toBe(
      '',
    );
    const html = renderToStaticMarkup(<TeamRetainedWorktreesTrigger count={2} onOpen={() => {}} />);
    expect(html).toContain('残っているworktree（2件）');
    expect(html).toContain('data-testid="team-retained-worktrees-open"');
    // It stays while its list is open, so focus can go back to it after the last discard.
    expect(
      renderToStaticMarkup(<TeamRetainedWorktreesTrigger count={0} open onOpen={() => {}} />),
    ).toContain('残っているworktree（0件）');
  });
});

describe('retainedWorktreeDiscardWarning (issue #544)', () => {
  it('warns plainly unless Main found the change in the Workspace history', () => {
    expect(retainedWorktreeDiscardWarning({ integration: 'none', submodules: false }).body).toBe(
      UNINTEGRATED_WARNING,
    );
    expect(
      retainedWorktreeDiscardWarning({ integration: 'confirmed', submodules: false }).body,
    ).toBe(INTEGRATED_WARNING);
    // Recorded as integrated but no longer found: the worktree may hold the only copy.
    const unconfirmed = retainedWorktreeDiscardWarning({
      integration: 'unconfirmed',
      submodules: false,
    });
    expect(unconfirmed.body).toBe(UNINTEGRATED_WARNING);
    expect(unconfirmed.note).toContain('今のWorkspaceの履歴には見つかりません');
    // A submodule takes the reassurance away from an integrated change and warns every case.
    const integratedWithSubmodule = retainedWorktreeDiscardWarning({
      integration: 'confirmed',
      submodules: true,
    });
    expect(integratedWithSubmodule.body).toBe(SUBMODULE_DISCARD_WARNING);
    expect(JSON.stringify(integratedWithSubmodule)).not.toContain('統合済みです');
    for (const integration of ['none', 'unconfirmed'] as const) {
      const warned = retainedWorktreeDiscardWarning({ integration, submodules: true });
      expect(warned.body).toBe(UNINTEGRATED_WARNING);
      expect(warned.submodule).toBe(SUBMODULE_DISCARD_WARNING);
    }
    for (const integration of ['none', 'confirmed', 'unconfirmed'] as const)
      expect(retainedWorktreeDiscardWarning({ integration, submodules: false }).submodule).toBe(
        null,
      );
  });
});

describe('TeamRetainedWorktreesDialog (issue #544)', () => {
  it('lists each worktree with its Worker, repository, state, reason and recorded changes', async () => {
    await renderDialog();

    expect(api.listRetainedWorktrees).toHaveBeenCalledWith('task-1');
    const dialog = container.querySelector('[data-testid="team-retained-worktrees-dialog"]');
    expect(dialog?.hasAttribute('open')).toBe(true);
    expect(dialog?.textContent).toContain('残っているworktree（3件）');
    const [first, second, third] = items();
    expect(first!.textContent).toContain('writer · Repo 1');
    expect(first!.textContent).toContain('/repo');
    expect(first!.textContent).toContain('失敗 · 未統合（変更を保持）');
    expect(first!.textContent).toContain('Worker failed after writing');
    expect(first!.textContent).toContain('0件');
    expect(second!.textContent).toContain('完了 · 統合済み（片付けに失敗）');
    expect(second!.textContent).toContain('3件');
    expect(button(first!, 'team-retained-discard').disabled).toBe(false);

    // A worktree Main will not discard has its button off, and says why next to it.
    const discard = button(third!, 'team-retained-discard');
    expect(discard.disabled).toBe(true);
    const reason = third!.querySelector('[data-testid="team-retained-blocked-reason"]');
    expect(reason?.textContent).toBe(`破棄できない理由: ${blocked.blockedReason}`);
    expect(discard.getAttribute('aria-describedby')).toBe(reason?.id);
  });

  it('disables discard for a Git lock or unknown lock state until a fresh list clears it (issue #578)', async () => {
    const locked = worktree({
      discardable: false,
      blockedReason:
        'このworktreeはGitでロックされているため破棄できません。ロックを解除した後に一覧を更新してください。',
    });
    const unknown = worktree({
      executionId: 'execution-lock-unknown',
      worktreePath: '/worktrees/worktree-execution-lock-unknown-1',
      discardable: false,
      blockedReason:
        'Gitのロック状態を確認できないため、ここからは破棄できません。一覧を更新して確認してください。',
    });
    api.listRetainedWorktrees
      .mockResolvedValueOnce({ worktrees: [locked, unknown], total: 2, nextCursor: null })
      .mockResolvedValueOnce({ worktrees: [failed], total: 1, nextCursor: null });
    await renderDialog();
    for (const item of items()) {
      expect(button(item, 'team-retained-discard').disabled).toBe(true);
      expect(
        item.querySelector('[data-testid="team-retained-blocked-reason"]')?.textContent,
      ).toContain('一覧を更新');
    }
    expect(api.discardRetainedWorktree).not.toHaveBeenCalled();
    await click(
      container.querySelector<HTMLButtonElement>('[data-testid="team-retained-refresh"]')!,
    );
    expect(button(items()[0]!, 'team-retained-discard').disabled).toBe(false);
    expect(api.discardRetainedWorktree).not.toHaveBeenCalled();
  });

  it('shows the current changes and opens the folder on request', async () => {
    await renderDialog();
    const [first] = items();

    const inspect = button(first!, 'team-retained-inspect');
    expect(inspect.getAttribute('aria-expanded')).toBe('false');
    await click(inspect);
    expect(api.inspectRetainedWorktree).toHaveBeenCalledWith({
      taskId: 'task-1',
      executionId: 'execution-1',
      repositoryOrdinal: 1,
    });
    expect(inspect.getAttribute('aria-expanded')).toBe('true');
    const panel = first!.querySelector('[data-testid="team-retained-inspection"]');
    expect(panel?.textContent).toContain('基準から1件のコミット');
    expect(panel?.querySelector('[data-testid="team-retained-status"]')?.textContent).toContain(
      '未追跡kept.txt',
    );
    expect(panel?.querySelector('[data-testid="team-retained-changes"]')?.textContent).toContain(
      '変更README.md',
    );
    await click(inspect);
    expect(first!.querySelector('[data-testid="team-retained-inspection"]')).toBeNull();

    await click(button(first!, 'team-retained-open-folder'));
    expect(api.openRetainedWorktree).toHaveBeenCalledWith({
      taskId: 'task-1',
      executionId: 'execution-1',
      repositoryOrdinal: 1,
    });
  });

  it('asks before discarding an unintegrated worktree and says it cannot be undone', async () => {
    await renderDialog();
    await click(button(items()[0]!, 'team-retained-discard'));

    const confirm = container.querySelector('[data-testid="team-retained-confirm"]');
    expect(confirm?.hasAttribute('open')).toBe(true);
    expect(confirm?.getAttribute('role')).toBe('alertdialog');
    expect(
      confirm?.querySelector('[data-testid="team-retained-confirm-warning"]')?.textContent,
    ).toBe(UNINTEGRATED_WARNING);
    expect(confirm?.textContent).toContain('/worktrees/worktree-execution-1-1');
    // Nothing is sent until the user confirms, and the safe choice holds focus.
    expect(api.discardRetainedWorktree).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'team-retained-confirm-cancel',
    );

    await click(
      confirm!.querySelector<HTMLButtonElement>('[data-testid="team-retained-confirm-discard"]')!,
    );
    expect(api.discardRetainedWorktree).toHaveBeenCalledWith({
      taskId: 'task-1',
      executionId: 'execution-1',
      repositoryOrdinal: 1,
    });
    expect(container.querySelector('[data-testid="team-retained-confirm"]')).toBeNull();
    expect(items()).toHaveLength(2);
    expect(container.textContent).toContain('残っているworktree（2件）');
    expect(container.querySelector('[data-testid="team-retained-notice"]')?.textContent).toContain(
      'worktreeを破棄しました',
    );
  });

  it('says an integrated worktree only removes what is left, and cancelling sends nothing', async () => {
    const onClose = vi.fn();
    await renderDialog(onClose);
    await click(button(items()[1]!, 'team-retained-discard'));

    const confirm = container.querySelector('[data-testid="team-retained-confirm"]');
    expect(
      confirm?.querySelector('[data-testid="team-retained-confirm-warning"]')?.textContent,
    ).toBe(INTEGRATED_WARNING);
    await click(
      confirm!.querySelector<HTMLButtonElement>('[data-testid="team-retained-confirm-cancel"]')!,
    );
    expect(container.querySelector('[data-testid="team-retained-confirm"]')).toBeNull();
    expect(api.discardRetainedWorktree).not.toHaveBeenCalled();
    // Closing the confirmation leaves the list open.
    expect(onClose).not.toHaveBeenCalled();
    expect(items()).toHaveLength(3);
  });

  it('treats a recorded integration Main could not find in the Workspace as unintegrated', async () => {
    const unverified = worktree({
      executionId: 'execution-4',
      workerHead: 'b'.repeat(40),
      integratedHead: 'c'.repeat(40),
      integration: 'unconfirmed',
      executionState: 'completed',
    });
    api.listRetainedWorktrees.mockResolvedValueOnce({
      worktrees: [unverified],
      total: 1,
      nextCursor: null,
    });
    await renderDialog();
    const [item] = items();
    expect(item!.querySelector('[data-testid="team-retained-state"]')?.textContent).toBe(
      '完了 · 統合を確認できません（Workspaceの履歴に見つかりません）',
    );
    await click(button(item!, 'team-retained-discard'));
    expect(
      container.querySelector('[data-testid="team-retained-confirm-warning"]')?.textContent,
    ).toBe(UNINTEGRATED_WARNING);
  });

  it('never calls a worktree with a submodule safely integrated, and warns about the submodule (issue #544)', async () => {
    const integratedWithSubmodule = worktree({
      executionId: 'execution-5',
      role: 'submodule writer',
      workerHead: 'b'.repeat(40),
      integratedHead: 'c'.repeat(40),
      integration: 'confirmed',
      submodules: true,
      executionState: 'completed',
    });
    const unintegratedWithSubmodule = worktree({
      executionId: 'execution-6',
      submodules: true,
    });
    api.listRetainedWorktrees.mockResolvedValueOnce({
      worktrees: [integratedWithSubmodule, unintegratedWithSubmodule, failed],
      total: 3,
      nextCursor: null,
    });
    await renderDialog();
    const [integratedItem, unintegratedItem, plainItem] = items();
    expect(integratedItem!.querySelector('[data-testid="team-retained-state"]')?.textContent).toBe(
      '完了 · 統合済み（片付けに失敗） · submoduleあり',
    );
    expect(plainItem!.querySelector('[data-testid="team-retained-state"]')?.textContent).toBe(
      '失敗 · 未統合（変更を保持）',
    );

    await click(button(integratedItem!, 'team-retained-discard'));
    let confirm = container.querySelector('[data-testid="team-retained-confirm"]');
    expect(confirm?.textContent).toContain('submoduleのあるworktreeを破棄しますか？');
    expect(
      confirm?.querySelector('[data-testid="team-retained-confirm-warning"]')?.textContent,
    ).toBe(SUBMODULE_DISCARD_WARNING);
    expect(confirm?.textContent).not.toContain(INTEGRATED_WARNING);
    expect(confirm?.textContent).not.toContain('統合済みです');
    await click(
      confirm!.querySelector<HTMLButtonElement>('[data-testid="team-retained-confirm-cancel"]')!,
    );

    // An unintegrated one keeps its own warning and gains the submodule one.
    await click(button(unintegratedItem!, 'team-retained-discard'));
    confirm = container.querySelector('[data-testid="team-retained-confirm"]');
    expect(
      confirm?.querySelector('[data-testid="team-retained-confirm-warning"]')?.textContent,
    ).toBe(UNINTEGRATED_WARNING);
    expect(
      confirm?.querySelector('[data-testid="team-retained-confirm-submodule"]')?.textContent,
    ).toBe(SUBMODULE_DISCARD_WARNING);
    await click(
      confirm!.querySelector<HTMLButtonElement>('[data-testid="team-retained-confirm-cancel"]')!,
    );

    // Without a submodule nothing changes.
    await click(button(plainItem!, 'team-retained-discard'));
    confirm = container.querySelector('[data-testid="team-retained-confirm"]');
    expect(confirm?.querySelector('[data-testid="team-retained-confirm-submodule"]')).toBeNull();
    expect(confirm?.textContent).not.toContain('submodule');
    expect(api.discardRetainedWorktree).not.toHaveBeenCalled();
  });

  it('does not call discarding a missing worktree record-only while its submodule commits remain (issue #580)', async () => {
    const goneWithSubmodule = worktree({
      executionId: 'execution-7',
      submodules: true,
      existsOnDisk: false,
      worktreePath: '/worktrees/worktree-execution-7-1',
    });
    const gone = worktree({
      executionId: 'execution-8',
      existsOnDisk: false,
      worktreePath: '/worktrees/worktree-execution-8-1',
    });
    api.listRetainedWorktrees.mockResolvedValueOnce({
      worktrees: [goneWithSubmodule, gone],
      total: 2,
      nextCursor: null,
    });
    await renderDialog();
    const [withSubmodule, plain] = items();
    expect(withSubmodule!.textContent).toContain(
      '（フォルダはもうありません。破棄すると、Gitの記録に残っているsubmoduleのコミットも削除されます）',
    );
    expect(withSubmodule!.textContent).not.toContain('記録だけを片付けます');
    expect(plain!.textContent).toContain(
      '（フォルダはもうありません。破棄すると記録だけを片付けます）',
    );
    expect(plain!.textContent).not.toContain('submoduleのコミット');

    // The confirmation gives the submodule warning, and nothing is sent before the user confirms.
    await click(button(withSubmodule!, 'team-retained-discard'));
    const confirm = container.querySelector('[data-testid="team-retained-confirm"]');
    expect(confirm?.hasAttribute('open')).toBe(true);
    expect(
      confirm?.querySelector('[data-testid="team-retained-confirm-submodule"]')?.textContent,
    ).toBe(SUBMODULE_DISCARD_WARNING);
    expect(api.discardRetainedWorktree).not.toHaveBeenCalled();
  });

  it("keeps the confirmation open with Main's reason when the discard is refused", async () => {
    api.discardRetainedWorktree.mockRejectedValueOnce(
      new Error('Workerの処理（CLI）が終了したことをまだ確認できていないため破棄できません。'),
    );
    await renderDialog();
    await click(button(items()[0]!, 'team-retained-discard'));
    const confirm = container.querySelector('[data-testid="team-retained-confirm"]');
    await click(
      confirm!.querySelector<HTMLButtonElement>('[data-testid="team-retained-confirm-discard"]')!,
    );

    expect(
      container.querySelector('[data-testid="team-retained-confirm-error"]')?.textContent,
    ).toContain('終了したことをまだ確認できていない');
    expect(container.querySelector('[data-testid="team-retained-confirm"]')).not.toBeNull();
    expect(items()).toHaveLength(3);
  });
});

describe('TeamRetainedWorktreesDialog inspection requests (issue #965)', () => {
  const firstRef = { taskId: 'task-1', executionId: 'execution-1', repositoryOrdinal: 1 };

  /** 中身を確認 → 中身を閉じる → 中身を確認 on the first worktree, both requests still held. */
  async function reopenWhileFirstIsHeld(): Promise<{
    item: HTMLElement;
    inspect: HTMLButtonElement;
    earlier: Deferred<TeamRetainedWorktreeInspection>;
    latest: Deferred<TeamRetainedWorktreeInspection>;
  }> {
    const pending = pendingInspections();
    await renderDialog();
    const [item] = items();
    const inspect = button(item!, 'team-retained-inspect');
    await click(inspect);
    await click(inspect);
    expect(panel(item!)).toBeNull();
    await click(inspect);
    expect(api.inspectRetainedWorktree).toHaveBeenCalledTimes(2);
    expect(api.inspectRetainedWorktree).toHaveBeenNthCalledWith(1, firstRef);
    expect(api.inspectRetainedWorktree).toHaveBeenNthCalledWith(2, firstRef);
    expect(panel(item!)?.textContent).toContain('読み込み中');
    return { item: item!, inspect, earlier: pending[0]!, latest: pending[1]! };
  }

  it('keeps the reopened result when the first request answers after it (AC-1)', async () => {
    const { item, inspect, earlier, latest } = await reopenWhileFirstIsHeld();

    await settle(() => latest.resolve(inspectionOf(failed, 'new-change.txt')));
    expect(panel(item)?.textContent).toContain('new-change.txt');

    await settle(() => earlier.resolve(inspectionOf(failed, 'old-change.txt')));
    expect(panel(item)?.textContent).toContain('new-change.txt');
    expect(panel(item)?.textContent).not.toContain('old-change.txt');
    expect(inspect.getAttribute('aria-expanded')).toBe('true');
    expect(inspect.textContent).toBe('中身を閉じる');
  });

  it('does not replace the reopened result with the first request failing late (AC-2)', async () => {
    const { item, earlier, latest } = await reopenWhileFirstIsHeld();

    await settle(() => latest.resolve(inspectionOf(failed, 'new-change.txt')));
    await settle(() => earlier.reject(new Error('first inspect failed')));
    expect(panel(item)?.textContent).toContain('new-change.txt');
    expect(panel(item)?.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('first inspect failed');
  });

  it('does not hide the reopened error behind the first request succeeding late (AC-2)', async () => {
    const { item, earlier, latest } = await reopenWhileFirstIsHeld();

    await settle(() => latest.reject(new Error('reopened inspect failed')));
    expect(panel(item)?.querySelector('[role="alert"]')?.textContent).toContain(
      'reopened inspect failed',
    );
    await settle(() => earlier.resolve(inspectionOf(failed, 'old-change.txt')));
    expect(panel(item)?.querySelector('[role="alert"]')?.textContent).toContain(
      'reopened inspect failed',
    );
    expect(panel(item)?.textContent).not.toContain('old-change.txt');
  });

  it('leaves a closed inspection closed and another worktree inspecting on its own (AC-3)', async () => {
    const pending = pendingInspections();
    await renderDialog();
    const [first, second] = items();
    const inspectFirst = button(first!, 'team-retained-inspect');
    const inspectSecond = button(second!, 'team-retained-inspect');
    await click(inspectFirst);
    await click(inspectSecond);
    await click(inspectFirst);

    await settle(() => pending[0]!.resolve(inspectionOf(failed, 'old-change.txt')));
    expect(panel(first!)).toBeNull();
    expect(inspectFirst.getAttribute('aria-expanded')).toBe('false');
    expect(inspectFirst.textContent).toBe('中身を確認');
    // Closing the first worktree's inspection leaves the second one's request standing.
    expect(panel(second!)?.textContent).toContain('読み込み中');
    await settle(() => pending[1]!.resolve(inspectionOf(integrated, 'second-change.txt')));
    expect(panel(second!)?.textContent).toContain('second-change.txt');

    // A failure for a closed inspection is dropped the same way.
    await click(inspectFirst);
    await click(inspectFirst);
    await settle(() => pending[2]!.reject(new Error('closed inspect failed')));
    expect(panel(first!)).toBeNull();
    expect(container.textContent).not.toContain('closed inspect failed');
    expect(panel(second!)?.textContent).toContain('second-change.txt');
  });

  it('ignores the answer for a discarded worktree even when the same worktree is listed again (AC-3)', async () => {
    const pending = pendingInspections();
    // Synthetic: Main lists a worktree under the same key again after the discard.
    api.discardRetainedWorktree.mockResolvedValueOnce({
      worktrees: [failed, integrated, blocked],
      total: 3,
      nextCursor: null,
    });
    await renderDialog();
    const inspect = button(items()[0]!, 'team-retained-inspect');
    // Two requests from before the discard: one closed, and the one still open at the discard.
    await click(inspect);
    await click(inspect);
    await click(inspect);
    await click(button(items()[0]!, 'team-retained-discard'));
    await click(
      container.querySelector<HTMLButtonElement>('[data-testid="team-retained-confirm-discard"]')!,
    );
    expect(api.discardRetainedWorktree).toHaveBeenCalledWith(firstRef);
    const [again] = items();
    expect(panel(again!)).toBeNull();

    await settle(() => pending[1]!.resolve(inspectionOf(failed, 'discarded-change.txt')));
    expect(panel(again!)).toBeNull();
    expect(button(again!, 'team-retained-inspect').getAttribute('aria-expanded')).toBe('false');

    await click(button(again!, 'team-retained-inspect'));
    await settle(() => pending[0]!.resolve(inspectionOf(failed, 'old-change.txt')));
    expect(panel(again!)?.textContent).toContain('読み込み中');
    expect(container.textContent).not.toContain('old-change.txt');
    expect(container.textContent).not.toContain('discarded-change.txt');
    await settle(() => pending[2]!.resolve(inspectionOf(failed, 'new-change.txt')));
    expect(panel(again!)?.textContent).toContain('new-change.txt');
  });

  it('drops an answer that arrives after the Task changes (AC-3)', async () => {
    const pending = pendingInspections();
    await renderDialog();
    await click(button(items()[0]!, 'team-retained-inspect'));

    await act(async () => {
      root.render(
        <TeamRetainedWorktreesDialog taskId="task-2" detail={detail} onClose={() => undefined} />,
      );
    });
    await act(async () => {});
    expect(api.listRetainedWorktrees).toHaveBeenLastCalledWith('task-2');
    // Synthetic: the other Task lists a worktree under the same key.
    const [first] = items();
    await settle(() => pending[0]!.resolve(inspectionOf(failed, 'old-change.txt')));
    expect(panel(first!)).toBeNull();
    expect(button(first!, 'team-retained-inspect').getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('old-change.txt');
  });

  it('drops an answer that arrives after the dialog is closed and opened again (AC-3)', async () => {
    const pending = pendingInspections();
    await renderDialog();
    await click(button(items()[0]!, 'team-retained-inspect'));
    await act(async () => {
      root.render(<></>);
    });

    await renderDialog();
    const [first] = items();
    expect(panel(first!)).toBeNull();
    await click(button(first!, 'team-retained-inspect'));
    await settle(() => pending[0]!.resolve(inspectionOf(failed, 'old-change.txt')));
    expect(panel(first!)?.textContent).toContain('読み込み中');
    expect(panel(first!)?.textContent).not.toContain('old-change.txt');
    await settle(() => pending[1]!.resolve(inspectionOf(failed, 'new-change.txt')));
    expect(panel(first!)?.textContent).toContain('new-change.txt');
  });
});

describe('retained worktree pagination (#966)', () => {
  const cursor: TeamRetainedWorktreeCursor = {
    taskId: 'task-1',
    teamId: 'team-1',
    assignedAt: '2026-10-27T00:00:00.000Z',
    executionId: 'entry-199',
    repositoryOrdinal: 1,
  };
  const first = Array.from({ length: 200 }, (_, i) =>
    worktree({ ...blocked, executionId: `entry-${i}` }),
  );
  const last = worktree({ executionId: 'entry-200', role: 'last worker' });
  const more = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="team-retained-load-more"]');
  it('shows and inspects entry201 without discarding any retained work', async () => {
    api.listRetainedWorktrees
      .mockResolvedValueOnce({ worktrees: first, total: 201, nextCursor: cursor })
      .mockResolvedValueOnce({ worktrees: [last], total: 201, nextCursor: null });
    await renderDialog();
    expect(more()).not.toBeNull();
    await act(async () => more()!.click());
    expect(api.listRetainedWorktrees).toHaveBeenLastCalledWith('task-1', cursor);
    expect(container.textContent).toContain('last worker');
    expect(more()).toBeNull();
    const button = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="team-retained-inspect"]',
    )[200];
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(api.inspectRetainedWorktree).toHaveBeenCalledWith({
      taskId: 'task-1',
      executionId: 'entry-200',
      repositoryOrdinal: 1,
    });
    expect(api.discardRetainedWorktree).not.toHaveBeenCalled();
  });
  it('ignores an older additional page after refresh and prevents same-tick duplicate requests', async () => {
    const pending = deferred<TeamRetainedWorktreeList>();
    api.listRetainedWorktrees
      .mockResolvedValueOnce({ worktrees: [failed], total: 201, nextCursor: cursor })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ worktrees: [integrated], total: 1, nextCursor: null });
    await renderDialog();
    await act(async () => {
      more()!.click();
      more()!.click();
    });
    expect(api.listRetainedWorktrees).toHaveBeenCalledTimes(2);
    // A canonical Team change refreshes the first page even while the old append is outstanding.
    await act(async () =>
      root.render(
        <TeamRetainedWorktreesDialog
          taskId="task-1"
          detail={
            {
              ...detail,
              executions: [
                {
                  id: 'changed',
                  state: 'failed',
                  isolation: { phase: 'quarantined', resumeKind: null, repositories: [] },
                },
              ],
            } as unknown as TeamDetail
          }
          onClose={() => {}}
        />,
      ),
    );
    await settle(() => pending.resolve({ worktrees: [last], total: 201, nextCursor: null }));
    expect(container.textContent).toContain('finisher');
    expect(container.textContent).not.toContain('last worker');
    expect(items()).toHaveLength(1);
  });

  it('invalidates additional-page errors when switching Tasks and keeps the new loading state', async () => {
    const oldPage = deferred<TeamRetainedWorktreeList>();
    const newPage = deferred<TeamRetainedWorktreeList>();
    api.listRetainedWorktrees
      .mockResolvedValueOnce({ worktrees: [failed], total: 201, nextCursor: cursor })
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newPage.promise);
    await renderDialog();
    await act(async () => more()!.click());
    await act(async () =>
      root.render(
        <TeamRetainedWorktreesDialog taskId="task-2" detail={detail} onClose={() => {}} />,
      ),
    );
    expect(items()).toHaveLength(0);
    await settle(() => oldPage.reject(new Error('obsolete error')));
    expect(container.textContent).not.toContain('obsolete error');
    expect(container.textContent).toContain('読み込み中');
    await settle(() => newPage.resolve({ worktrees: [integrated], total: 1, nextCursor: null }));
    expect(container.textContent).toContain('finisher');
  });

  it('retains rows and retry cursor after a failed additional page', async () => {
    api.listRetainedWorktrees
      .mockResolvedValueOnce({ worktrees: first, total: 201, nextCursor: cursor })
      .mockRejectedValueOnce(new Error('additional page failed'))
      .mockResolvedValueOnce({ worktrees: [last], total: 201, nextCursor: null });
    await renderDialog();
    await act(async () => more()!.click());
    expect(container.textContent).toContain('additional page failed');
    expect(container.querySelectorAll('[data-testid="team-retained-inspect"]')).toHaveLength(200);
    await act(async () => more()!.click());
    expect(api.listRetainedWorktrees.mock.calls[1]).toEqual(
      api.listRetainedWorktrees.mock.calls[2],
    );
    expect(container.textContent).toContain('last worker');
    expect(api.discardRetainedWorktree).not.toHaveBeenCalled();
  });
});
