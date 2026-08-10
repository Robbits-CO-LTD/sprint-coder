import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    attachmentBusyByTask: {},
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

    await useAppStore.getState().startTurn(taskId, '  画像を確認して  ', undefined, [second.id]);
    expect(start).toHaveBeenCalledWith({
      taskId,
      text: '画像を確認して',
      skills: [],
      attachmentIds: [second.id],
      attachmentSelectionIdentity: 'selection-1',
    });
    expect(useAppStore.getState().messagesByTask[taskId]?.[0]?.attachments).toEqual([second]);

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
          content: '画像を確認して',
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
