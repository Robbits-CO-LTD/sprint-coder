import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ComposerActionButtons,
  composerActionPolicy,
  composerMessageText,
  composerSubmitShortcut,
  imageRequestFailureRecovery,
} from './Composer';

const available = {
  canQueue: true,
  canStopAndSend: true,
  canCancel: true,
};

describe('Composer action policy', () => {
  it.each([
    {
      name: 'idle and empty',
      input: { turnStatus: 'idle' as const, hasDraft: false },
      kind: 'send',
      label: '送信',
      disabled: true,
    },
    {
      name: 'idle with a draft',
      input: { turnStatus: 'idle' as const, hasDraft: true },
      kind: 'send',
      label: '送信',
      disabled: false,
    },
    {
      name: 'running and empty',
      input: { turnStatus: 'running' as const, hasDraft: false },
      kind: 'cancel',
      label: '実行を停止',
      disabled: false,
    },
    {
      name: 'running with a draft',
      input: { turnStatus: 'running' as const, hasDraft: true },
      kind: 'queue',
      label: 'キューに追加',
      disabled: false,
    },
    {
      name: 'canceling and empty',
      input: { turnStatus: 'canceling' as const, hasDraft: false },
      kind: 'cancel',
      label: '実行を停止',
      disabled: true,
      busy: true,
    },
    {
      name: 'canceling with a draft',
      input: { turnStatus: 'canceling' as const, hasDraft: true },
      kind: 'cancel',
      label: '実行を停止',
      disabled: true,
      busy: true,
    },
  ])('$name', ({ input, kind, label, disabled, busy = false }) => {
    const policy = composerActionPolicy({
      ...input,
      ...available,
      actionPending: false,
      sendBlocked: false,
    });

    expect(policy.primary).toMatchObject({ kind, label, disabled, busy });
  });

  it('keeps unsupported actions visible and explains why they are unavailable', () => {
    const policy = composerActionPolicy({
      turnStatus: 'running',
      hasDraft: true,
      canQueue: false,
      canStopAndSend: false,
      canCancel: false,
      actionPending: false,
      sendBlocked: false,
    });

    expect(policy.primary).toMatchObject({
      kind: 'queue',
      disabled: true,
      label: 'キューに追加（この環境では利用できません）',
    });
    expect(policy.interrupt).toMatchObject({
      visible: true,
      disabled: true,
      label: '割り込んで送信（この環境では利用できません）',
    });
    const html = renderToStaticMarkup(
      <ComposerActionButtons policy={policy} onPrimary={vi.fn()} onInterrupt={vi.fn()} />,
    );
    expect(html).toContain('class="composer-action-unavailable"');
    expect(html).toContain('この環境ではキュー追加を利用できません');
    expect(html).toContain('この環境では割り込み送信を利用できません');
  });

  it('renders native, distinctly named controls with cancel busy state', () => {
    const html = renderToStaticMarkup(
      <ComposerActionButtons
        policy={composerActionPolicy({
          turnStatus: 'canceling',
          hasDraft: true,
          ...available,
          actionPending: true,
          sendBlocked: false,
        })}
        onPrimary={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );

    expect(html).toContain('<button');
    expect(html).toContain('aria-label="実行を停止"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('title="実行を停止しています"');
    expect(html).toContain('data-testid="composer-interrupt-button"');
    expect(html).toContain('割り込んで送信');
    expect(html).toContain('class="send-btn stop"');
  });

  it('gives the queue state a visible label as well as an accessible name', () => {
    const html = renderToStaticMarkup(
      <ComposerActionButtons
        policy={composerActionPolicy({
          turnStatus: 'running',
          hasDraft: true,
          ...available,
          actionPending: false,
          sendBlocked: false,
        })}
        onPrimary={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="キューに追加"');
    expect(html).toContain('class="send-btn-label">キュー</span>');
  });

  it('blocks every operation while one task action is pending', () => {
    const policy = composerActionPolicy({
      turnStatus: 'running',
      hasDraft: true,
      ...available,
      actionPending: true,
      sendBlocked: false,
    });

    expect(policy.primary.disabled).toBe(true);
    expect(policy.interrupt.disabled).toBe(true);
  });

  it('submits plain Enter but preserves IME composition and Shift+Enter newline', () => {
    expect(composerSubmitShortcut({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(
      'submit',
    );
    expect(composerSubmitShortcut({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(
      'none',
    );
    expect(composerSubmitShortcut({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(
      'none',
    );
  });

  it('uses the same image-generation modifier for every Composer send action', () => {
    expect(composerMessageText('画像を作る', false)).toBe('画像を作る');
    expect(composerMessageText('画像を作る', true)).toContain('画像を作る');
    expect(composerMessageText('画像を作る', true)).not.toBe('画像を作る');
  });

  it('restores a raw image draft without double-prefixing a retry', () => {
    const sentText = composerMessageText('画像を作る', true);
    const recovery = imageRequestFailureRecovery({
      currentDraft: sentText,
      rawDraft: '画像を作る',
      imageRequested: true,
      draftRestored: true,
      imageModeUnchanged: true,
    });

    expect(recovery).toEqual({ draft: '画像を作る', rearm: true });
    expect(composerMessageText(recovery.draft, recovery.rearm)).toBe(sentText);
    expect(
      imageRequestFailureRecovery({
        currentDraft: sentText,
        rawDraft: '画像を作る',
        imageRequested: true,
        draftRestored: false,
        imageModeUnchanged: true,
      }),
    ).toEqual({ draft: sentText, rearm: false });
    expect(
      imageRequestFailureRecovery({
        currentDraft: sentText,
        rawDraft: '画像を作る',
        imageRequested: true,
        draftRestored: true,
        imageModeUnchanged: false,
      }),
    ).toEqual({ draft: sentText, rearm: false });
  });
});
