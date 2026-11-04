// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputerUseSessionRail, type ComputerUseSessionView } from './ComputerUsePanel';
import { foregroundHandoffActivationIntent } from '../../computer-use-activation-intent';
import { createTrustedComputerUseUiActivationGate } from '../../computer-use-activation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const session: ComputerUseSessionView = {
  sessionId: 'session-1',
  appName: 'メモ帳',
  windowLabel: '文書',
  mode: 'supervised',
  providerLabel: 'Local',
  state: 'paused',
  round: 1,
  maxRounds: 25,
  expiresAt: '2026-11-04T01:00:00.000Z',
  observedAt: null,
  pauseReason: null,
  resumable: false,
  inputDisplay: {
    sessionKind: 'background',
    handoff: {
      id: 'handoff-1',
      operation: 'click',
      expiresAt: '2026-11-04T00:01:00.000Z',
    },
  },
};
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  delete document.documentElement.dataset['theme'];
});

async function mount(onHandoff = vi.fn(async () => {})) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T00:00:00.000Z'));
  const container = document.createElement('div');
  const composer = document.createElement('textarea');
  document.body.append(composer, container);
  composer.focus();
  const root = createRoot(container);
  const draw = async (value = session, stopping = false, enabled = true) =>
    act(async () =>
      root.render(
        <ComputerUseSessionRail
          session={value}
          approval={null}
          stopping={stopping}
          onStop={() => {}}
          onApproval={() => {}}
          {...(enabled ? { onHandoff } : {})}
        />,
      ),
    );
  await draw();
  const button = (text: string) => {
    const found = [...container.querySelectorAll('button')].find((node) =>
      node.textContent?.includes(text),
    );
    if (!found) throw new Error(`Button missing: ${text}`);
    return found;
  };
  const open = async () => act(async () => button('前面への引渡しを確認').click());
  return {
    container,
    composer,
    draw,
    button,
    open,
    onHandoff,
    close: async () => act(async () => root.unmount()),
  };
}

describe('P6 foreground handoff interaction', () => {
  it.each(['light', 'dark'])(
    'shows route and risks without automatic card, activation or focus in %s',
    async (theme) => {
      document.documentElement.dataset['theme'] = theme;
      const f = await mount();
      try {
        expect(f.container.textContent).toContain('背景（対象を前面にせず操作する）');
        expect(f.container.querySelector('.computer-use-approval')).toBeNull();
        expect(document.activeElement).toBe(f.composer);
        await f.open();
        expect(document.activeElement).toBe(f.composer);
        expect(f.onHandoff).not.toHaveBeenCalled();
        for (const risk of [
          'メモ帳',
          '文書',
          '入力が中断',
          'カーソル',
          '前面化が遅れて',
          '操作の承認は別途',
        ])
          expect(f.container.textContent).toContain(risk);
        expect(f.container.querySelector('[autofocus]')).toBeNull();
        expect(f.container.querySelector('[aria-live="polite"]')).not.toBeNull();
        const control = f.button('対象を前面にして操作を続ける');
        expect(control.tabIndex).toBe(0);
        expect(f.button('拒否').tabIndex).toBe(0);
        control.focus();
        expect(document.activeElement).toBe(control);
        expect(control.dataset['computerUseIntent']).toBe(
          foregroundHandoffActivationIntent({
            sessionId: 'session-1',
            intentId: 'handoff-1',
            decision: 'continue',
          }),
        );
        await act(async () => control.click());
        expect(f.onHandoff).toHaveBeenCalledExactlyOnceWith({
          sessionId: 'session-1',
          intentId: 'handoff-1',
          decision: 'continue',
        });
        expect(f.container.querySelector('.computer-use-approval')).toBeNull();
      } finally {
        await f.close();
      }
    },
  );
  it('keeps gate-closed UI unchanged and distinguishes foreground sessions', async () => {
    const f = await mount();
    try {
      const { inputDisplay: _, ...closed } = session;
      await f.draw(closed);
      expect(f.container.textContent).not.toContain('操作の経路');
      expect(f.container.textContent).not.toContain('引渡し');
      await f.draw({ ...session, inputDisplay: { sessionKind: 'foreground', handoff: null } });
      expect(f.container.textContent).toContain('前面（対象を前面にして操作する）');
      expect(f.container.textContent).not.toContain('引渡し');
    } finally {
      await f.close();
    }
  });
  it.each(['expire', 'stop', 'deny', 'withdraw'] as const)(
    'removes the card on %s without consuming a continuation',
    async (reason) => {
      const f = await mount();
      try {
        await f.open();
        if (reason === 'expire') await act(async () => vi.advanceTimersByTime(60_000));
        if (reason === 'stop') await f.draw(session, true);
        if (reason === 'deny') await act(async () => f.button('拒否').click());
        if (reason === 'withdraw')
          await f.draw({ ...session, inputDisplay: { sessionKind: 'background', handoff: null } });
        expect(f.container.querySelector('.computer-use-approval')).toBeNull();
        expect(f.onHandoff).not.toHaveBeenCalledWith(
          expect.objectContaining({ decision: 'continue' }),
        );
        if (reason === 'deny')
          expect(f.onHandoff).toHaveBeenCalledExactlyOnceWith({
            sessionId: 'session-1',
            intentId: 'handoff-1',
            decision: 'deny',
          });
        expect(document.activeElement).toBe(f.composer);
      } finally {
        await f.close();
      }
    },
  );
  it('disables unavailable and pending decisions and reports failure without retrying', async () => {
    let reject!: (error: Error) => void;
    const onHandoff = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const f = await mount(onHandoff);
    try {
      await f.open();
      await f.draw(session, false, false);
      expect(f.button('対象を前面にして操作を続ける').disabled).toBe(true);
      await f.draw();
      await act(async () => f.button('対象を前面にして操作を続ける').click());
      expect(f.button('引渡しを確認中').disabled).toBe(true);
      expect(f.button('拒否').disabled).toBe(true);
      expect(f.button('停止').disabled).toBe(false);
      await act(async () => reject(new Error('private native error')));
      expect(f.container.querySelector('[role="alert"]')?.textContent).toContain(
        '引渡しを完了できません',
      );
      expect(f.container.textContent).not.toContain('private native error');
      expect(f.container.querySelector('.computer-use-approval')).toBeNull();
      expect(onHandoff).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
  it('rejects synthetic activation and separates handoff from approval', async () => {
    const f = await mount();
    try {
      await f.open();
      const target = f.button('対象を前面にして操作を続ける');
      const gate = createTrustedComputerUseUiActivationGate();
      expect(gate.observe({ target, isTrusted: false })).toBe(false);
      expect(gate.consume('foreground-handoff')).toBeNull();
      // Trusted event is a unit seam, not evidence of real OS input.
      gate.observe({ target, isTrusted: true });
      expect(gate.consume('approval')).toBeNull();
      gate.observe({ target, isTrusted: true });
      expect(gate.consume('foreground-handoff')?.intent).toBe(target.dataset['computerUseIntent']);
      expect(gate.consume('foreground-handoff')).toBeNull();
    } finally {
      await f.close();
    }
  });
});
