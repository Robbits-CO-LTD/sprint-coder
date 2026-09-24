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
  TeamRetainedWorktreesDialog,
  TeamRetainedWorktreesTrigger,
  retainedWorktreeDiscardWarning,
} from './TeamRetainedWorktrees';
import type {
  TeamDetail,
  TeamRetainedWorktree,
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

type ListFn = (taskId: string) => Promise<TeamRetainedWorktreeList>;
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
    expect(retainedWorktreeDiscardWarning({ integration: 'none' }).body).toBe(UNINTEGRATED_WARNING);
    expect(retainedWorktreeDiscardWarning({ integration: 'confirmed' }).body).toBe(
      INTEGRATED_WARNING,
    );
    // Recorded as integrated but no longer found: the worktree may hold the only copy.
    const unconfirmed = retainedWorktreeDiscardWarning({ integration: 'unconfirmed' });
    expect(unconfirmed.body).toBe(UNINTEGRATED_WARNING);
    expect(unconfirmed.note).toContain('今のWorkspaceの履歴には見つかりません');
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
    api.listRetainedWorktrees.mockResolvedValueOnce({ worktrees: [unverified], total: 1 });
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
