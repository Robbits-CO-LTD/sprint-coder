// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computerUseApprovalSchema, type ComputerUseApproval } from '@sprint-coder/contracts';
import { approvalView } from '../hooks/useComputerUse';
import { sanitizeNativeDisplayLabel } from '../../main/computer-use-native-display';
import { ComputerUseSessionRail, type ComputerUseSessionView } from './ComputerUsePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

const session: ComputerUseSessionView = {
  sessionId: 'session-1',
  appName: 'Form',
  windowLabel: 'Untitled',
  mode: 'supervised',
  providerLabel: 'Local Vision',
  state: 'awaiting_approval',
  round: 1,
  maxRounds: 25,
  expiresAt: '2026-08-30T00:00:00.000Z',
  observedAt: '2026-08-29T12:00:00.000Z',
  pauseReason: null,
};

function card(excerpt: string): ComputerUseApproval {
  return computerUseApprovalSchema.parse({
    id: 'approval-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    actionType: 'set_text',
    actionDigest: 'a'.repeat(64),
    targetLabel: 'control:field',
    preview: '{"type":"set_text","targetId":"field","artifactRef":"artifact-1"}',
    transfer: {
      sourceLabel: 'Notes',
      destinationLabel: 'Form',
      destinationTarget: 'control:field',
      sizeClass: 'le_256',
      excerpt,
    },
    risk: 'high',
    policyEpoch: 0,
    observationRevision: 1,
    eligibleForPlan: false,
    allowedDecisions: ['allow_once', 'deny'],
    state: 'pending',
    decision: null,
    revision: 0,
    challenge: 'challenge-0123456789',
    createdAt: '2026-08-29T12:00:00.000Z',
    expiresAt: '2026-08-29T13:00:00.000Z',
  });
}

const render = (approval: ComputerUseApproval): string =>
  renderToStaticMarkup(
    <ComputerUseSessionRail
      session={session}
      approval={approvalView(approval)}
      stopping={false}
      onStop={() => {}}
      onApproval={() => {}}
    />,
  );

const windowsCard = (
  effect:
    | 'supervised_action'
    | 'high_impact_confirmation'
    | 'download_open'
    | 'file_manager_open' = 'supervised_action',
): ComputerUseApproval =>
  computerUseApprovalSchema.parse({
    ...card('fixture'),
    actionType: 'invoke',
    transfer: undefined,
    preview: '',
    display: {
      effect,
      operation: 'invoke',
      targetLabel: effect === 'supervised_action' ? null : 'fixturefdp.txt',
      extension: effect.endsWith('_open') ? 'pdf' : null,
      externalApplication: effect.endsWith('_open') ? 'may_open' : 'not_applicable',
      unsignedWarning: 'main_image_only',
    },
  });

describe('Windows native approval display', () => {
  it.each(['light', 'dark'])('keeps semantic fields and focusable decisions in %s', (theme) => {
    document.documentElement.dataset['theme'] = theme;
    const container = document.createElement('div');
    container.innerHTML = render(windowsCard());
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="native測定情報"]')).not.toBeNull();
    expect(container.querySelector('[autofocus]')).toBeNull();
    expect(container.textContent).toContain('Tab / Shift+Tab');
    expect(container.querySelector('.computer-use-stop')).not.toBeNull();
    delete document.documentElement.dataset['theme'];
  });
  it('renders Main-sanitized RLO labels with the independently measured extension', () => {
    const sanitized = sanitizeNativeDisplayLabel('fixture\u202Efdp.txt');
    expect(sanitized.kind).toBe('verified');
    if (sanitized.kind !== 'verified') throw new Error('Expected a verified fixture');
    const approval = windowsCard('download_open');
    const html = render(
      computerUseApprovalSchema.parse({
        ...approval,
        display: { ...approval.display, targetLabel: sanitized.label },
      }),
    );
    expect(html).toContain('fixturefdp.txt');
    expect(html).not.toContain('\u202E');
    expect(html).toContain('<dt>拡張子（native測定）</dt><dd>pdf</dd>');
  });
  it('passes measured facts without changing activation intents', () => {
    const approval = windowsCard();
    expect(approvalView(approval)).toMatchObject({ display: approval.display });
    expect(approvalView(approval).activationIntents).toEqual(
      approvalView(card('fixture')).activationIntents,
    );
  });
  it.each([
    'supervised_action',
    'high_impact_confirmation',
    'download_open',
    'file_manager_open',
  ] as const)('shows measured %s facts and main-image-only warning', (effect) => {
    const html = render(windowsCard(effect));
    expect(html).toContain('native測定情報');
    expect(html).toContain('このアプリは署名で本人確認できません');
    expect(html).toContain('更新・変更後は再確認が必要');
    expect(html).toContain('DLL・プラグイン・スクリプト等の安全性は保証しません');
    expect(html).toContain('承認期限');
    if (effect === 'supervised_action') expect(html).toContain('ラベル未検証の一般操作');
    if (effect === 'high_impact_confirmation') expect(html).toContain('高リスク操作の確定');
    if (effect.endsWith('_open')) {
      expect(html).toContain('<dt>拡張子（native測定）</dt><dd>pdf</dd>');
      expect(html).toContain('fixturefdp.txt');
      expect(html).toContain('外部アプリが開く可能性があります');
      expect(html).toContain(
        effect === 'download_open'
          ? 'ダウンロードしたファイルを開く（E2）'
          : 'ファイルマネージャーから開く（E3）',
      );
    }
  });
  it('shows no Windows fields on macOS or unsigned warning on signed cards', () => {
    expect(render(card('fixture'))).not.toContain('native測定情報');
    const approval = windowsCard();
    expect(
      render(
        computerUseApprovalSchema.parse({
          ...approval,
          display: { ...approval.display, unsignedWarning: 'none' },
        }),
      ),
    ).not.toContain('このアプリは署名で本人確認できません');
  });
  it('disables expired and stopped decisions without stealing focus', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-29T12:59:59.000Z'));
    const container = document.createElement('div');
    const composer = document.createElement('textarea');
    document.body.append(container, composer);
    composer.focus();
    const root = createRoot(container);
    const onApproval = vi.fn();
    const draw = (stopping: boolean) =>
      root.render(
        <ComputerUseSessionRail
          session={session}
          approval={approvalView(windowsCard())}
          stopping={stopping}
          onStop={() => {}}
          onApproval={onApproval}
        />,
      );
    try {
      await act(async () => draw(false));
      expect(document.activeElement).toBe(composer);
      const button = container.querySelector<HTMLButtonElement>(
        '[data-computer-use-activation="approval"]',
      )!;
      expect(button.disabled).toBe(false);
      await act(async () => draw(true));
      expect(button.disabled).toBe(true);
      expect(container.textContent).toContain('停止中のため承認できません');
      await act(async () => draw(false));
      expect(button.disabled).toBe(false);
      await act(async () => vi.advanceTimersByTime(1000));
      expect(button.disabled).toBe(true);
      expect(container.textContent).toContain('承認期限切れ');
      await act(async () => button.click());
      expect(onApproval).not.toHaveBeenCalled();
      await act(async () => draw(true));
      expect(button.disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });
  it('allows explicit focus and denial, then removes the old card', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-29T12:30:00.000Z'));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onApproval = vi.fn();
    try {
      await act(async () =>
        root.render(
          <ComputerUseSessionRail
            session={session}
            approval={approvalView(windowsCard())}
            stopping={false}
            onStop={() => {}}
            onApproval={onApproval}
          />,
        ),
      );
      const buttons = container.querySelectorAll<HTMLButtonElement>(
        '[data-computer-use-activation="approval"]',
      );
      expect(buttons).toHaveLength(2);
      expect(buttons[0]!.tabIndex).toBe(0);
      expect(buttons[1]!.tabIndex).toBe(0);
      buttons[1]!.focus();
      expect(document.activeElement).toBe(buttons[1]);
      await act(async () => buttons[1]!.click());
      expect(onApproval).toHaveBeenCalledWith('deny');
      await act(async () =>
        root.render(
          <ComputerUseSessionRail
            session={session}
            approval={null}
            stopping={false}
            onStop={() => {}}
            onApproval={onApproval}
          />,
        ),
      );
      expect(container.querySelector('[data-computer-use-activation="approval"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });
});
