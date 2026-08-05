import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  AttachmentDraftList,
  attachmentInteractionPolicy,
  focusAfterAttachmentRemoval,
} from './Composer';
import { ComposerMenu, focusComposerMenuTrigger } from './ComposerMenu';

describe('Composer attachment drafts', () => {
  it('shows metadata, current-Turn scope, and an accessible remove control', () => {
    const html = renderToStaticMarkup(
      <AttachmentDraftList
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
        status="画像添付の送信は準備中です。画像を削除すると通常のメッセージを送信できます。"
        errorId="attachment-error"
      />,
    );

    expect(html).toContain('参照範囲: この送信のみ');
    expect(html).toContain('設計図.png');
    expect(html).toContain('PNG · 1.5 MB');
    expect(html).toContain('aria-label="設計図.pngを削除"');
    expect(html).toContain('aria-describedby="attachment-error"');
    expect(html).toContain('画像添付の送信は準備中です');
  });

  it('blocks send and Goal for drafts and explains active-Turn and rollout states', () => {
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

  it('keeps a focused remove control focusable while its request is busy', () => {
    const html = renderToStaticMarkup(
      <AttachmentDraftList
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
