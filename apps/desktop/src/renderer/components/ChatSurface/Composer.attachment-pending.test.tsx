// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { attachmentDraftIsUnresolved, useAppStore } from '../../store/appStore';
import type { ImageAttachmentMetadata } from '../../types/sprint-coder';

const taskId = 'attachment-pending';
const image: ImageAttachmentMetadata = {
  id: 'image-one',
  fileName: 'one.png',
  mimeType: 'image/png',
  byteLength: 100,
  createdAt: '2026-10-27T00:00:00.000Z',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let container: HTMLDivElement;
let root: Root;
let paste: ReturnType<typeof deferred<ImageAttachmentMetadata | null>>;
let listDraft: ReturnType<typeof vi.fn>;
let start: ReturnType<typeof vi.fn>;
let goalsStart: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  paste = deferred();
  listDraft = vi.fn().mockResolvedValue([image]);
  start = vi.fn().mockResolvedValue({ turnId: 'accepted' });
  goalsStart = vi.fn();
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: {
      tasks: {},
      goals: { start: goalsStart },
      turns: { start, cancel: vi.fn().mockResolvedValue(undefined) },
      attachments: {
        paste: vi.fn().mockReturnValue(paste.promise),
        listDraft,
        capability: vi.fn().mockResolvedValue({
          status: 'supported',
          reason: null,
          selectionIdentity: 'selection-one',
        }),
      },
    },
  });
  useAppStore.setState(
    {
      ...useAppStore.getInitialState(),
      selectedTaskId: taskId,
      draftByTask: { [taskId]: 'describe image' },
      attachmentCapabilityByTask: {
        [taskId]: { status: 'supported', reason: null, selectionIdentity: 'selection-one' },
      },
    },
    true,
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Composer taskId={taskId} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.getState().dismissToast();
  useAppStore.setState(useAppStore.getInitialState(), true);
  Reflect.deleteProperty(window, 'sprintCoder');
  vi.unstubAllGlobals();
});
const send = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="composer-send-button"]')!;

it('blocks click, Enter and store admission until the displayed image metadata is ready', async () => {
  let operation!: Promise<void>;
  await act(async () => {
    operation = useAppStore.getState().pasteDraftAttachment(taskId);
  });
  expect(send().disabled).toBe(true);
  expect(container.textContent).toContain('画像を準備しています');
  await act(async () => {
    send().click();
    container
      .querySelector('textarea')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await useAppStore.getState().startTurn(taskId, 'direct');
    await useAppStore.getState().startGoal(taskId, 'direct goal');
  });
  expect(start).not.toHaveBeenCalled();
  expect(goalsStart).not.toHaveBeenCalled();
  expect(useAppStore.getState().draftByTask[taskId]).toBe('describe image');
  await act(async () => {
    paste.resolve(image);
    await operation;
  });
  expect(send().disabled).toBe(false);
  await act(async () => send().click());
  expect(start).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      attachmentIds: [image.id],
      attachmentSelectionIdentity: 'selection-one',
    }),
  );
  expect(useAppStore.getState().messagesByTask[taskId]?.[0]?.attachments).toEqual([image]);
});

it('does not let superseded hydration release protection and permits an explicit retry after failure', async () => {
  const old = deferred<ImageAttachmentMetadata[]>();
  const latest = deferred<ImageAttachmentMetadata[]>();
  listDraft.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
  let operation!: Promise<void>;
  await act(async () => {
    operation = useAppStore.getState().pasteDraftAttachment(taskId);
    paste.resolve(image);
  });
  let refresh!: Promise<void>;
  await act(async () => {
    refresh = useAppStore.getState().refreshDraftAttachments(taskId);
  });
  await act(async () => {
    old.resolve([image]);
    await operation;
  });
  expect(send().disabled).toBe(true);
  await act(async () => {
    latest.reject(new Error('metadata offline'));
    await refresh;
  });
  expect(send().disabled).toBe(true);
  const retry = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === '画像の状態を再読み込み',
  );
  expect(retry?.disabled).toBe(false);
  await act(async () => retry!.click());
  expect(send().disabled).toBe(false);
  expect(useAppStore.getState().draftAttachmentsByTask[taskId]).toEqual([image]);
  expect(start).not.toHaveBeenCalled();
});

it('allows pure Stop while image processing is pending and leaves other Tasks independent', async () => {
  await act(async () =>
    useAppStore.setState({
      draftByTask: { [taskId]: '' },
      turnByTask: {
        [taskId]: {
          turnId: 'running-turn',
          stage: 'executing',
          reachedStageIndex: 2,
          status: 'running',
          startedAt: 1,
          streamingMessageId: null,
          streamingContent: '',
          runtimeStarting: false,
        },
      },
    }),
  );
  let operation!: Promise<void>;
  await act(async () => {
    operation = useAppStore.getState().pasteDraftAttachment(taskId);
  });
  expect(send().disabled).toBe(false);
  await act(async () => send().click());
  expect(window.sprintCoder?.turns.cancel).toHaveBeenCalledTimes(1);
  await act(async () => useAppStore.getState().startTurn('another-task', 'independent'));
  expect(start).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ taskId: 'another-task', attachmentIds: [] }),
  );
  await act(async () => {
    paste.resolve(null);
    await operation;
  });
  expect(attachmentDraftIsUnresolved(useAppStore.getState(), taskId)).toBe(false);
});

it.each(['pick', 'paste', 'remove'] as const)(
  'reconciles uncertain %s failures before allowing another send',
  async (kind) => {
    const metadata = deferred<ImageAttachmentMetadata[]>();
    listDraft.mockReturnValueOnce(metadata.promise);
    const rejected = vi.fn().mockRejectedValue(new Error('mutation failed'));
    Object.assign(window.sprintCoder!.attachments, { [kind]: rejected });
    let operation!: Promise<unknown>;
    await act(async () => {
      const store = useAppStore.getState();
      operation =
        kind === 'pick'
          ? store.pickDraftAttachment(taskId)
          : kind === 'paste'
            ? store.pasteDraftAttachment(taskId)
            : store.removeDraftAttachment(taskId, image.id);
    });
    expect(send().disabled).toBe(true);
    await act(async () => {
      metadata.resolve([]);
      await operation;
    });
    expect(send().disabled).toBe(false);
    expect(container.textContent).toContain('mutation failed');
    expect(useAppStore.getState().draftByTask[taskId]).toBe('describe image');
  },
);

it.each(['pick', 'paste'] as const)(
  'releases unchanged %s cancellation without losing the draft',
  async (kind) => {
    Object.assign(window.sprintCoder!.attachments, { [kind]: vi.fn().mockResolvedValue(null) });
    await act(async () =>
      kind === 'pick'
        ? useAppStore.getState().pickDraftAttachment(taskId)
        : useAppStore.getState().pasteDraftAttachment(taskId),
    );
    expect(send().disabled).toBe(false);
    expect(useAppStore.getState().draftByTask[taskId]).toBe('describe image');
    expect(listDraft).not.toHaveBeenCalled();
  },
);

it('ends the spinner on the newest hydration failure even while an old read is pending', async () => {
  const old = deferred<ImageAttachmentMetadata[]>();
  listDraft.mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error('new failure'));
  let operation!: Promise<void>;
  await act(async () => {
    operation = useAppStore.getState().pasteDraftAttachment(taskId);
    paste.resolve(image);
  });
  await act(async () => useAppStore.getState().refreshDraftAttachments(taskId));
  expect(container.textContent).not.toContain('画像を準備しています');
  expect(send().disabled).toBe(true);
  const retry = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === '画像の状態を再読み込み',
  )!;
  expect(retry.disabled).toBe(false);
  await act(async () => {
    old.resolve([image]);
    await operation;
  });
  expect(send().disabled).toBe(true);
  await act(async () => retry.click());
  expect(send().disabled).toBe(false);
});
