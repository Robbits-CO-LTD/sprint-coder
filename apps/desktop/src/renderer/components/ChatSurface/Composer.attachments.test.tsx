import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  AttachmentDraftList,
  attachmentDraftStatus,
  attachmentInteractionPolicy,
  directTurnAttachmentIds,
  focusAfterAttachmentRemoval,
} from './Composer';
import { ComposerMenu, focusComposerMenuTrigger } from './ComposerMenu';

describe('Composer attachment drafts', () => {
  it('shows metadata, current-Turn scope, and an accessible remove control', () => {
    const html = renderToStaticMarkup(
      <AttachmentDraftList
        taskId="task-1"
        attachments={[
          {
            id: 'attachment-1',
            fileName: '設計図.png',
            mimeType: 'image/png',
            byteLength: 1_572_864,
            createdAt: '2026-08-05T00:00:00.000Z',
          },
        ]}
        busy={false}
        removeRefs={{ current: new Map<string, HTMLButtonElement>() }}
        onRemove={() => undefined}
        status="送信するとこの画像が参照されます"
        errorId="attachment-error"
      />,
    );

    expect(html).toContain('参照範囲: この送信のみ');
    expect(html).toContain('設計図.png · PNG · 1.5 MB');
    expect(html).toContain('aria-label="設計図.pngを削除"');
    expect(html).toContain('aria-describedby="attachment-error"');
    expect(html).toContain('送信するとこの画像が参照されます');
  });

  it('renders a thumbnail tile whose name, media type, and size stay accessible', () => {
    const html = renderToStaticMarkup(
      <AttachmentDraftList
        taskId="task-1"
        attachments={[
          {
            id: 'attachment-1',
            fileName: '貼り付け画像-20260822-134210.png',
            mimeType: 'image/png',
            byteLength: 204_800,
            createdAt: '2026-08-22T13:42:10.000Z',
          },
        ]}
        busy={false}
        removeRefs={{ current: new Map<string, HTMLButtonElement>() }}
        onRemove={() => undefined}
        status="送信するとこの画像が参照されます"
      />,
    );

    expect(html).toContain('title="貼り付け画像-20260822-134210.png · PNG · 200 KB"');
    expect(html).toContain('aria-label="貼り付け画像-20260822-134210.pngを削除"');
    // Main answers the thumbnail request asynchronously, so the first paint is the placeholder.
    expect(html).toContain('composer-attachment-thumb placeholder');
  });

  it('allows supported idle direct send but blocks active-Turn attachment queueing', () => {
    expect(
      attachmentInteractionPolicy({
        draftCount: 2,
        turnActive: false,
        goalRequested: false,
        capabilityStatus: 'supported',
        capabilityReason: '',
      }).sendBlocked,
    ).toBe(false);
    expect(
      attachmentInteractionPolicy({
        draftCount: 1,
        turnActive: true,
        goalRequested: false,
        capabilityStatus: 'supported',
        capabilityReason: '',
      }),
    ).toEqual({
      sendBlocked: true,
      goalBlocked: true,
      attachSupported: false,
      attachUnavailableReason: 'Turn実行中は画像を追加できません',
    });
    expect(
      attachmentInteractionPolicy({
        draftCount: 0,
        turnActive: false,
        goalRequested: false,
        capabilityStatus: 'unsupported',
        capabilityReason: '画像添付は送信機能の準備完了後に利用できます',
      }).attachUnavailableReason,
    ).toBe('画像添付は送信機能の準備完了後に利用できます');
  });

  it('never says attachments are unsendable while the policy allows sending them', () => {
    expect(
      attachmentDraftStatus({
        turnActive: false,
        goalRequested: false,
        capabilityStatus: 'supported',
        capabilityReason: '',
      }),
    ).toBe('送信するとこの画像が参照されます');
    expect(
      attachmentDraftStatus({
        turnActive: true,
        goalRequested: false,
        capabilityStatus: 'supported',
        capabilityReason: '',
      }),
    ).toContain('実行中のTurnにはキュー追加できません');
    expect(
      attachmentDraftStatus({
        turnActive: false,
        goalRequested: true,
        capabilityStatus: 'supported',
        capabilityReason: '',
      }),
    ).toContain('Goal入力中');
    expect(
      attachmentDraftStatus({
        turnActive: false,
        goalRequested: false,
        capabilityStatus: 'unsupported',
        capabilityReason: '画像添付はCodex CLI Runtimeで利用できます',
      }),
    ).toBe(
      '画像添付はCodex CLI Runtimeで利用できます。画像を削除すると通常のメッセージを送信できます',
    );
  });

  it('passes every draft ID to direct start in visible order', () => {
    expect(
      directTurnAttachmentIds([
        {
          id: 'second',
          fileName: 'second.webp',
          mimeType: 'image/webp',
          byteLength: 200,
          createdAt: '2026-08-05T00:00:01.000Z',
        },
        {
          id: 'first',
          fileName: 'first.png',
          mimeType: 'image/png',
          byteLength: 100,
          createdAt: '2026-08-05T00:00:00.000Z',
        },
      ]),
    ).toEqual(['second', 'first']);
  });

  it('keeps a focused remove control focusable while its request is busy', () => {
    const html = renderToStaticMarkup(
      <AttachmentDraftList
        taskId="task-1"
        attachments={[
          {
            id: 'attachment-1',
            fileName: 'one.png',
            mimeType: 'image/png',
            byteLength: 100,
            createdAt: '2026-08-05T00:00:00.000Z',
          },
        ]}
        busy
        removeRefs={{ current: new Map<string, HTMLButtonElement>() }}
        onRemove={() => undefined}
        status="処理中"
      />,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain(' disabled=""');
  });

  it('focuses next, previous, plus, then textarea after removal', () => {
    const next = { focus: vi.fn() };
    const previous = { focus: vi.fn() };
    const plus = { focus: vi.fn() };
    const textarea = { focus: vi.fn() };
    focusAfterAttachmentRemoval({
      nextId: 'next',
      previousId: 'previous',
      removeRefs: new Map([
        ['next', next],
        ['previous', previous],
      ]),
      plusTrigger: plus,
      textarea,
    });
    expect(next.focus).toHaveBeenCalledWith({ preventScroll: true });

    focusAfterAttachmentRemoval({
      nextId: undefined,
      previousId: 'previous',
      removeRefs: new Map([['previous', previous]]),
      plusTrigger: plus,
      textarea,
    });
    expect(previous.focus).toHaveBeenCalled();

    focusAfterAttachmentRemoval({
      nextId: undefined,
      previousId: undefined,
      removeRefs: new Map(),
      plusTrigger: plus,
      textarea,
    });
    expect(plus.focus).toHaveBeenCalled();

    focusAfterAttachmentRemoval({
      nextId: undefined,
      previousId: undefined,
      removeRefs: new Map(),
      plusTrigger: null,
      textarea,
    });
    expect(textarea.focus).toHaveBeenCalled();
  });

  it('returns focus to the plus trigger before picker completion or cancellation', () => {
    const trigger = { focus: vi.fn() };
    focusComposerMenuTrigger(trigger);
    expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('associates a persistent picker error with the plus trigger', () => {
    const html = renderToStaticMarkup(
      <ComposerMenu
        items={[]}
        triggerLabel="操作を追加"
        menuLabel="Composerの操作"
        triggerIcon={<span>+</span>}
        triggerTestId="composer-plus"
        triggerAriaDescribedBy="attachment-error"
      />,
    );
    expect(html).toContain('aria-describedby="attachment-error"');
  });
});
