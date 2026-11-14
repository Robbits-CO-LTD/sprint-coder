import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachmentInteractionPolicy,
  composerActionPolicy,
  directTurnAttachmentIds,
} from '../components/ChatSurface/Composer';
import type { ImageAttachmentMetadata } from '../types/sprint-coder';
import { handleTurnEvent, removeAcceptedAttachmentDrafts, useAppStore } from './appStore';

const taskId = 'task-attachments';
const first: ImageAttachmentMetadata = {
  id: 'attachment-1',
  fileName: 'one.png',
  mimeType: 'image/png',
  byteLength: 100,
  createdAt: '2026-08-05T00:00:00.000Z',
};
const second: ImageAttachmentMetadata = {
  ...first,
  id: 'attachment-2',
  fileName: 'two.webp',
  mimeType: 'image/webp',
};

beforeEach(() => {
  useAppStore.setState({
    error: null,
    draftAttachmentsByTask: {},
    attachmentCapabilityByTask: {},
    attachmentRequestRevisionByTask: {},
    attachmentAcceptanceRevisionByTask: {},
    attachmentBusyByTask: {},
    attachmentReconciliationByTask: {},
    attachmentErrorByTask: {},
    attachmentAnnouncementByTask: {},
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('attachment draft store state', () => {
  it('removes only drafts named by the accepted user message', () => {
    expect(removeAcceptedAttachmentDrafts([first, second], [second])).toEqual([first]);
    expect(removeAcceptedAttachmentDrafts([first], [])).toEqual([first]);
  });

  it('passes ordered IDs and metadata optimistically, then preserves a concurrent draft on acceptance', async () => {
    const text = '  画像を確認して  ';
    const start = vi.fn().mockResolvedValue({ turnId: 'turn-1' });
    vi.stubGlobal('window', { sprintCoder: { tasks: {}, turns: { start } } });
    useAppStore.setState({
      messagesByTask: { [taskId]: [] },
      draftAttachmentsByTask: { [taskId]: [first, second] },
      attachmentCapabilityByTask: {
        [taskId]: { status: 'supported', reason: null, selectionIdentity: 'selection-1' },
      },
      sendingByTask: {},
      pendingOptimisticIdByTask: {},
      lastSeqByTask: { [taskId]: 0 },
      turnByTask: {},
    });

    await useAppStore.getState().startTurn(taskId, text, undefined, [second.id]);
    // Acceptance can happen while this Task has no event subscription.
    expect(useAppStore.getState().sendingByTask[taskId]).toBe(false);
    expect(start).toHaveBeenCalledWith({
      taskId,
      text,
      skills: [],
      attachmentIds: [second.id],
      attachmentSelectionIdentity: 'selection-1',
    });
    expect(useAppStore.getState().messagesByTask[taskId]?.[0]?.attachments).toEqual([second]);
    expect(useAppStore.getState().messagesByTask[taskId]?.[0]?.content).toBe(text);

    const concurrent = { ...first, id: 'attachment-3', fileName: 'three.png' };
    useAppStore.setState((state) => ({
      draftAttachmentsByTask: {
        ...state.draftAttachmentsByTask,
        [taskId]: [first, second, concurrent],
      },
    }));
    handleTurnEvent(
      taskId,
      {
        type: 'turn.accepted',
        taskId,
        turnId: 'turn-1',
        seq: 1,
        userMessage: {
          id: 'message-1',
          taskId,
          turnId: 'turn-1',
          author: 'user',
          content: text,
          attachments: [second],
          createdAt: '2026-08-05T00:00:02.000Z',
        },
      },
      (update) => useAppStore.setState((state) => update(state)),
    );

    expect(useAppStore.getState().draftAttachmentsByTask[taskId]).toEqual([first, concurrent]);
    expect(useAppStore.getState().messagesByTask[taskId]).toEqual([
      expect.objectContaining({ id: 'message-1', attachments: [second] }),
    ]);
  });

  it('discards an older hydrate answer after a newer request wins', async () => {
    let resolveOld!: (value: ImageAttachmentMetadata[]) => void;
    const oldList = new Promise<ImageAttachmentMetadata[]>((resolve) => {
      resolveOld = resolve;
    });
    const listDraft = vi.fn().mockReturnValueOnce(oldList).mockResolvedValueOnce([second]);
    vi.stubGlobal('window', {
      sprintCoder: {
        attachments: {
          capability: vi.fn().mockResolvedValue({
            status: 'unsupported',
            reason: '準備中',
            selectionIdentity: null,
          }),
          listDraft,
        },
      },
    });

    const older = useAppStore.getState().refreshDraftAttachments(taskId);
    const newer = useAppStore.getState().refreshDraftAttachments(taskId);
    await newer;
    resolveOld([first]);
    await older;

    expect(useAppStore.getState().draftAttachmentsByTask[taskId]).toEqual([second]);
  });

  it.each([false, true])(
    'reconciles a draft read overtaken by acceptance (pending mutation: %s)',
    async (pendingMutation) => {
      let finishCapability!: () => void;
      const capability = { status: 'supported', reason: null, selectionIdentity: 'selection-1' };
      const delayed = new Promise<typeof capability>((resolve) => {
        finishCapability = () => resolve(capability);
      });
      const listDraft = vi.fn().mockResolvedValueOnce([first, second]).mockResolvedValue([second]);
      vi.stubGlobal('window', {
        sprintCoder: {
          attachments: {
            capability: vi.fn().mockReturnValueOnce(delayed).mockResolvedValue(capability),
            listDraft,
          },
        },
      });
      useAppStore.setState({
        messagesByTask: {},
        turnByTask: {},
        draftAttachmentsByTask: { [taskId]: [first, second], other: [first] },
        attachmentReconciliationByTask: pendingMutation
          ? { [taskId]: { minimumRequestRevision: 1, status: 'loading' } }
          : {},
      });
      const loading = useAppStore.getState().refreshDraftAttachments(taskId);
      handleTurnEvent(
        taskId,
        {
          type: 'turn.accepted',
          taskId,
          turnId: 'turn-accepted',
          seq: 1,
          userMessage: {
            id: 'accepted-message',
            taskId,
            turnId: 'turn-accepted',
            author: 'user',
            content: '画像を確認',
            attachments: [first],
            createdAt: first.createdAt,
          },
        },
        (update) => useAppStore.setState((state) => update(state)),
      );
      expect(useAppStore.getState().draftAttachmentsByTask[taskId]).toEqual([second]);
      finishCapability();
      await loading;
      expect(useAppStore.getState().draftAttachmentsByTask[taskId]).toEqual([second]);
      expect(useAppStore.getState().draftAttachmentsByTask.other).toEqual([first]);
      expect(useAppStore.getState().attachmentReconciliationByTask[taskId]).toBeUndefined();
    },
  );

  it('reconciles accepted images when the start reply arrives without a subscribed event', async () => {
    let finishOld!: (value: ImageAttachmentMetadata[]) => void;
    const oldList = new Promise<ImageAttachmentMetadata[]>((resolve) => {
      finishOld = resolve;
    });
    const listDraft = vi.fn().mockReturnValueOnce(oldList).mockResolvedValue([second]);
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: {},
        turns: { start: vi.fn().mockResolvedValue({ turnId: 'unsubscribed' }) },
        attachments: {
          capability: vi
            .fn()
            .mockResolvedValue({ status: 'supported', reason: null, selectionIdentity: 's' }),
          listDraft,
        },
      },
    });
    useAppStore.setState({
      messagesByTask: {},
      turnByTask: {},
      draftAttachmentsByTask: { [taskId]: [first, second] },
    });
    const loading = useAppStore.getState().refreshDraftAttachments(taskId);
    await useAppStore.getState().startTurn(taskId, '画像を確認', undefined, [first.id]);
    await vi.waitFor(() => expect(listDraft).toHaveBeenCalledTimes(2));
    finishOld([first, second]);
    await loading;
    expect(useAppStore.getState().draftAttachmentsByTask[taskId]).toEqual([second]);
  });

  // Issue #1157: a read started before the send (for example by re-selecting the Task) captured
  // the image while it was still a draft, and only its capability answer is slow. The send's own
  // capability answer and acceptance arrive first. The late read must not put the sent image back.
  it.each([
    ['between the accepted event and the start reply', true, 'before reply'],
    ['after the accepted event and the start reply', true, 'after reply'],
    ['after a start reply without a subscribed event', false, 'after reply'],
  ] as const)(
    'keeps an accepted image out of the draft when an older read finishes late (%s)',
    async (_label, withEvent, lateReadFinishes) => {
      const capability = {
        status: 'supported' as const,
        reason: null,
        selectionIdentity: 'selection-1',
      };
      let finishSlowCapability!: () => void;
      const slowCapability = new Promise<typeof capability>((resolve) => {
        finishSlowCapability = () => resolve(capability);
      });
      const capabilityApi = vi
        .fn()
        .mockReturnValueOnce(slowCapability)
        .mockResolvedValue(capability);
      // Main moves the image to the message on acceptance; every read after that sees no draft.
      let mainDrafts: ImageAttachmentMetadata[] = [first];
      const listDraft = vi.fn(() => Promise.resolve([...mainDrafts]));
      const acceptedEvent = (turnId: string, attachments: ImageAttachmentMetadata[]) => ({
        type: 'turn.accepted' as const,
        taskId,
        turnId,
        seq: 1,
        userMessage: {
          id: `message-${turnId}`,
          taskId,
          turnId,
          author: 'user' as const,
          content: '画像を確認',
          attachments,
          createdAt: first.createdAt,
        },
      });
      let lateRead: Promise<void> = Promise.resolve();
      // Any moment, from Main's acceptance on, at which the Composer would show the sent image.
      let accepted = false;
      const resurrected: string[][] = [];
      const unsubscribe = useAppStore.subscribe((state) => {
        const ids = (state.draftAttachmentsByTask[taskId] ?? []).map(({ id }) => id);
        if (accepted && ids.includes(first.id)) resurrected.push(ids);
      });
      const start = vi.fn(async (request: { attachmentIds: readonly string[] }) => {
        if (request.attachmentIds.length > 0) {
          mainDrafts = mainDrafts.filter(({ id }) => !request.attachmentIds.includes(id));
          if (withEvent) {
            handleTurnEvent(taskId, acceptedEvent('turn-image', [first]), (update) =>
              useAppStore.setState((state) => update(state)),
            );
            accepted = true;
          }
          if (lateReadFinishes === 'before reply') {
            finishSlowCapability();
            await lateRead;
          }
        }
        return { turnId: request.attachmentIds.length > 0 ? 'turn-image' : 'turn-text' };
      });
      vi.stubGlobal('window', {
        sprintCoder: {
          tasks: {},
          turns: { start },
          attachments: { capability: capabilityApi, listDraft },
        },
      });
      useAppStore.setState({
        messagesByTask: { [taskId]: [] },
        sendingByTask: {},
        pendingOptimisticIdByTask: {},
        lastSeqByTask: { [taskId]: 0 },
        turnByTask: {},
        draftAttachmentsByTask: { [taskId]: [first] },
        attachmentCapabilityByTask: { [taskId]: capability },
      });

      lateRead = useAppStore.getState().refreshDraftAttachments(taskId);
      // The late read has already captured the image as a draft before the send.
      await vi.waitFor(() => expect(listDraft).toHaveBeenCalledTimes(1));
      expect(
        await useAppStore.getState().startTurn(taskId, '画像を確認', undefined, [first.id]),
      ).toBeNull();
      accepted = true;
      expect(useAppStore.getState().draftAttachmentsByTask[taskId]).toEqual([]);

      finishSlowCapability();
      await lateRead;
      // Let the follow-up read started by the accepted send settle as well.
      await new Promise((resolve) => setTimeout(resolve, 0));
      unsubscribe();
      const drafts = useAppStore.getState().draftAttachmentsByTask[taskId] ?? [];
      expect(drafts).toEqual([]);
      expect(resurrected).toEqual([]);
      expect(useAppStore.getState().attachmentCapabilityByTask[taskId]).toEqual(capability);

      // While the Turn runs, queueing and interrupting a text message stay available.
      const attachment = attachmentInteractionPolicy({
        draftCount: drafts.length,
        turnActive: true,
        goalRequested: false,
        capabilityStatus: 'supported',
        capabilityReason: '',
      });
      const running = composerActionPolicy({
        turnStatus: 'running',
        hasDraft: true,
        canQueue: true,
        canStopAndSend: true,
        canCancel: true,
        actionPending: false,
        sendBlocked: attachment.sendBlocked,
      });
      expect(running.primary).toMatchObject({ kind: 'queue', disabled: false });
      expect(running.interrupt.disabled).toBe(false);

      // After the Turn, the next text-only send carries no stale image ID.
      useAppStore.setState({ turnByTask: {} });
      expect(
        await useAppStore
          .getState()
          .startTurn(taskId, '次の質問', undefined, directTurnAttachmentIds(drafts)),
      ).toBeNull();
      expect(start).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: '次の質問', attachmentIds: [] }),
      );
    },
  );

  it('re-reads the draft from Main when Main rejects an image that is no longer a draft', async () => {
    const start = vi.fn().mockRejectedValue(new Error('添付画像が古くなっています'));
    const listDraft = vi.fn().mockResolvedValue([second]);
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: {},
        turns: { start },
        attachments: {
          capability: vi
            .fn()
            .mockResolvedValue({ status: 'supported', reason: null, selectionIdentity: 's' }),
          listDraft,
        },
      },
    });
    useAppStore.setState({
      messagesByTask: { [taskId]: [] },
      sendingByTask: {},
      pendingOptimisticIdByTask: {},
      turnByTask: {},
      draftAttachmentsByTask: { [taskId]: [first, second] },
    });

    const message = await useAppStore
      .getState()
      .startTurn(taskId, '画像を確認', undefined, [first.id, second.id]);
    await vi.waitFor(() =>
      expect(useAppStore.getState().draftAttachmentsByTask[taskId]).toEqual([second]),
    );
    expect(message).toContain('添付画像が古くなっています');
    expect(useAppStore.getState().draftByTask[taskId]).toBe('画像を確認');
  });

  it('refreshes from Main after pick and remove instead of clearing optimistically', async () => {
    const pick = vi.fn().mockResolvedValue(first);
    const remove = vi.fn().mockResolvedValue(undefined);
    const listDraft = vi.fn().mockResolvedValueOnce([first]).mockResolvedValueOnce([]);
    vi.stubGlobal('window', {
      sprintCoder: {
        attachments: {
          capability: vi.fn().mockResolvedValue({
            status: 'supported',
            reason: null,
            selectionIdentity: 'selection-1',
          }),
          pick,
          listDraft,
          remove,
        },
      },
    });

    await useAppStore.getState().pickDraftAttachment(taskId);
    expect(useAppStore.getState().draftAttachmentsByTask[taskId]).toEqual([first]);
    expect(useAppStore.getState().attachmentAnnouncementByTask[taskId]).toBe(
      'one.pngを追加しました',
    );
    expect(await useAppStore.getState().removeDraftAttachment(taskId, first.id)).toBe(true);
    expect(useAppStore.getState().draftAttachmentsByTask[taskId]).toEqual([]);
    expect(useAppStore.getState().attachmentAnnouncementByTask[taskId]).toBe(
      'one.pngを削除しました',
    );
    expect(remove).toHaveBeenCalledWith({ taskId, attachmentId: first.id });
  });

  it('adds a clipboard image and leaves the draft untouched when the clipboard held none', async () => {
    const paste = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(null);
    const listDraft = vi.fn().mockResolvedValue([first]);
    vi.stubGlobal('window', {
      sprintCoder: {
        attachments: {
          capability: vi.fn().mockResolvedValue({
            status: 'supported',
            reason: null,
            selectionIdentity: 'selection-1',
          }),
          paste,
          listDraft,
          remove: vi.fn(),
        },
      },
    });

    await useAppStore.getState().pasteDraftAttachment(taskId);
    expect(paste).toHaveBeenCalledWith(taskId);
    expect(useAppStore.getState().draftAttachmentsByTask[taskId]).toEqual([first]);
    expect(useAppStore.getState().attachmentAnnouncementByTask[taskId]).toBe(
      'one.pngを貼り付けました',
    );

    await useAppStore.getState().pasteDraftAttachment(taskId);
    expect(listDraft).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().draftAttachmentsByTask[taskId]).toEqual([first]);
    expect(useAppStore.getState().attachmentAnnouncementByTask[taskId]).toBe(
      'クリップボードに画像がありません',
    );
    expect(useAppStore.getState().attachmentErrorByTask[taskId]).toBeUndefined();
  });

  it('surfaces a rejected clipboard paste next to the attachment controls', async () => {
    vi.stubGlobal('window', {
      sprintCoder: {
        attachments: {
          capability: vi.fn(),
          paste: vi.fn().mockRejectedValue(new Error('コピーした画像が大きすぎます。')),
          listDraft: vi.fn(),
          remove: vi.fn(),
        },
      },
    });

    await useAppStore.getState().pasteDraftAttachment(taskId);

    expect(useAppStore.getState().attachmentErrorByTask[taskId]).toContain(
      'コピーした画像が大きすぎます。',
    );
    expect(useAppStore.getState().attachmentBusyByTask[taskId]).toBe(false);
  });

  it('keeps Task drafts isolated and announces picker cancellation', async () => {
    const otherTaskId = 'task-other';
    vi.stubGlobal('window', {
      sprintCoder: {
        attachments: {
          capability: vi.fn().mockResolvedValue({
            status: 'supported',
            reason: null,
            selectionIdentity: 'selection-1',
          }),
          pick: vi.fn().mockResolvedValue(null),
          listDraft: vi.fn((requestedTaskId: string) =>
            Promise.resolve(requestedTaskId === taskId ? [first] : [second]),
          ),
          remove: vi.fn(),
        },
      },
    });

    await Promise.all([
      useAppStore.getState().refreshDraftAttachments(taskId),
      useAppStore.getState().refreshDraftAttachments(otherTaskId),
    ]);
    await useAppStore.getState().pickDraftAttachment(taskId);

    expect(useAppStore.getState().draftAttachmentsByTask[taskId]).toEqual([first]);
    expect(useAppStore.getState().draftAttachmentsByTask[otherTaskId]).toEqual([second]);
    expect(useAppStore.getState().attachmentAnnouncementByTask[taskId]).toBe(
      '画像の選択をキャンセルしました',
    );
  });

  it('keeps hydrate failures adjacent to attachment controls', async () => {
    const capability = vi
      .fn()
      .mockRejectedValueOnce(new Error('画像draftを読み込めませんでした'))
      .mockResolvedValueOnce({
        status: 'unsupported',
        reason: '準備中',
        selectionIdentity: null,
      });
    vi.stubGlobal('window', {
      sprintCoder: {
        attachments: {
          capability,
          listDraft: vi.fn().mockResolvedValue([]),
        },
      },
    });

    await useAppStore.getState().refreshDraftAttachments(taskId);

    expect(useAppStore.getState().attachmentErrorByTask[taskId]).toBe(
      '画像draftを読み込めませんでした',
    );
    expect(useAppStore.getState().error).toBeNull();

    await useAppStore.getState().refreshDraftAttachments(taskId);
    expect(useAppStore.getState().attachmentErrorByTask[taskId]).toBeUndefined();
  });
});
