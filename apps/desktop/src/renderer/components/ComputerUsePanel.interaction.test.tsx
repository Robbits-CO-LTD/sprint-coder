// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ComputerUseOnboarding,
  ComputerUseSessionRail,
  type ComputerUseProfileView,
  type ComputerUseProviderView,
} from './ComputerUsePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const profile: ComputerUseProfileView = {
  id: 'profile-1',
  revision: 4,
  displayName: 'TextEdit',
  identityLabel: 'TextEdit · com.apple.TextEdit',
  metadata: '登録確認 2026-08-29',
  available: true,
  unavailableReason: null,
  mode: 'full_access_app',
  connectionId: 'connection-1',
  modelId: 'vision-model',
  providerEgressConsent: true,
  remember: true,
  policyLanguage: 'en',
  maximumMode: 'full_access_app',
};

const provider: ComputerUseProviderView = {
  connectionId: 'connection-1',
  modelId: 'vision-model',
  label: 'OpenAI',
  detail: 'Vision Model',
  capabilityStatus: 'confirmed',
};

const alternateProvider: ComputerUseProviderView = {
  connectionId: 'connection-2',
  modelId: 'vision-model-2',
  label: 'Anthropic',
  detail: 'Vision Model 2',
  capabilityStatus: 'unknown',
};

const targetWindow = {
  id: 'window-1',
  revision: 7,
  profileRevision: 5,
  label: 'Untitled',
  detail: 'メインウィンドウ',
  policyLanguage: 'en' as const,
  maximumMode: 'full_access_app' as const,
};

type OnboardingProps = ComponentProps<typeof ComputerUseOnboarding>;
type Mounted = Readonly<{
  container: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
  dialog: HTMLDialogElement;
}>;

const mounted: Mounted[] = [];
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

beforeAll(() => {
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
  restoreDescriptor(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  restoreDescriptor(HTMLDialogElement.prototype, 'close', originalClose);
});

afterEach(async () => {
  for (const item of mounted.splice(0)) {
    await act(async () => item.root.unmount());
    item.container.remove();
  }
});

async function renderOnboarding(overrides: Partial<OnboardingProps> = {}): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const props: OnboardingProps = {
    profiles: [profile],
    providers: [provider],
    controlAvailable: true,
    busy: false,
    onClose: () => {},
    onRegister: async () => {},
    onResolveWindows: async () => [targetWindow],
    onStart: async () => {},
    ...overrides,
  };
  await act(async () => root.render(<ComputerUseOnboarding {...props} />));
  const dialog = required(container.querySelector<HTMLDialogElement>('dialog'));
  const item = { container, root, dialog };
  mounted.push(item);
  return item;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function submitWithEnter(container: HTMLElement, buttonLabel: string): Promise<void> {
  const form = required(container.querySelector<HTMLFormElement>('form'));
  const button = required(
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent?.trim() === buttonLabel,
    ),
  );
  button.focus();
  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await act(async () => {
    form.requestSubmit(button);
    await Promise.resolve();
  });
  await flush();
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Required test element is missing');
  return value;
}

function restoreDescriptor(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) Reflect.deleteProperty(target, key);
  else Object.defineProperty(target, key, descriptor);
}

describe('Computer Use onboarding interaction', () => {
  it('completes both screens by keyboard with full access as the first default', async () => {
    const onResolveWindows = vi.fn(async () => [targetWindow]);
    const onStart = vi.fn(async () => {});
    const { container } = await renderOnboarding({
      profiles: [{ ...profile, providerEgressConsent: false, remember: false }],
      onResolveWindows,
      onStart,
    });

    const profileRadio = required(
      container.querySelector<HTMLInputElement>('input[name="computer-use-profile"]'),
    );
    expect(document.activeElement).toBe(profileRadio);

    await submitWithEnter(container, '次へ');
    expect(onResolveWindows).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('操作方法と送信先を確認');
    const windowSelect = required(container.querySelector<HTMLSelectElement>('select'));
    expect(windowSelect.value).toBe('window-1');
    expect(document.activeElement).toBe(windowSelect);
    expect(
      required(container.querySelector<HTMLInputElement>('input[value="full_access_app"]')).checked,
    ).toBe(true);
    const selects = [...container.querySelectorAll<HTMLSelectElement>('select')];
    expect(selects).toHaveLength(2);
    expect(selects[1]?.value).toBe('connection-1\0vision-model');

    const consent = required(
      [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) =>
        input.parentElement?.textContent?.includes('選択したProviderへ'),
      ),
    );
    const start = required(
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === '開始',
      ),
    );
    expect(consent.checked).toBe(false);
    expect(start.disabled).toBe(true);
    await act(async () => consent.click());
    expect(start.disabled).toBe(false);
    expect(start.dataset.computerUseIntent).toContain('"operation":"start"');
    expect(start.dataset.computerUseIntent).toContain('"windowId":"window-1"');
    expect(start.dataset.computerUseIntent).toContain('"expectedWindowRevision":7');

    await submitWithEnter(container, '開始');
    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledWith({
      profileId: 'profile-1',
      profileRevision: 5,
      windowCandidateId: 'window-1',
      mode: 'full_access_app',
      connectionId: 'connection-1',
      modelId: 'vision-model',
      remember: false,
      egressConfirmed: true,
    });
  });

  it('forces observe-only and disables control modes when native input is unavailable', async () => {
    const { container } = await renderOnboarding({ controlAvailable: false });

    await submitWithEnter(container, '次へ');
    const fullAccess = required(
      container.querySelector<HTMLInputElement>('input[value="full_access_app"]'),
    );
    const supervised = required(
      container.querySelector<HTMLInputElement>('input[value="supervised"]'),
    );
    const observeOnly = required(
      container.querySelector<HTMLInputElement>('input[value="observe_only"]'),
    );
    expect(fullAccess.disabled).toBe(true);
    expect(supervised.disabled).toBe(true);
    expect(observeOnly.disabled).toBe(false);
    expect(observeOnly.checked).toBe(true);
    expect(container.textContent).toContain('現在は「見るだけ」で開始できます');
  });

  it('makes an unattested selected target explicitly supervised and never quick-starts it', async () => {
    const onStart = vi.fn(async () => {});
    const { container } = await renderOnboarding({
      onResolveWindows: async () => [{ ...targetWindow, policyLanguage: 'unknown' }],
      onStart,
    });
    const quickStart = required(
      container.querySelector<HTMLButtonElement>('[data-computer-use-activation="start"]'),
    );

    await act(async () => {
      quickStart.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onStart).not.toHaveBeenCalled();
    expect(container.textContent).toContain('操作方法と送信先を確認');
    const fullAccess = required(
      container.querySelector<HTMLInputElement>('input[value="full_access_app"]'),
    );
    const supervised = required(
      container.querySelector<HTMLInputElement>('input[value="supervised"]'),
    );
    expect(fullAccess.disabled).toBe(true);
    expect(supervised.checked).toBe(true);
    expect(container.textContent).toContain('対象アプリと対象ウィンドウのUI言語');
  });

  it('explicitly disables modes above the app and window maximumMode', async () => {
    const { container } = await renderOnboarding({
      profiles: [{ ...profile, maximumMode: 'supervised' }],
      onResolveWindows: async () => [{ ...targetWindow, maximumMode: 'supervised' }],
    });
    await submitWithEnter(container, '次へ');

    expect(
      required(container.querySelector<HTMLInputElement>('input[value="full_access_app"]'))
        .disabled,
    ).toBe(true);
    expect(
      required(container.querySelector<HTMLInputElement>('input[value="supervised"]')).checked,
    ).toBe(true);
    expect(container.textContent).toContain('「確認あり」まで対応します');
  });

  it('keeps an observe-only app incapable of selecting either control mode', async () => {
    const { container } = await renderOnboarding({
      profiles: [{ ...profile, mode: 'observe_only', maximumMode: 'observe_only' }],
      onResolveWindows: async () => [{ ...targetWindow, maximumMode: 'observe_only' }],
    });
    await submitWithEnter(container, '次へ');

    expect(
      required(container.querySelector<HTMLInputElement>('input[value="full_access_app"]'))
        .disabled,
    ).toBe(true);
    expect(
      required(container.querySelector<HTMLInputElement>('input[value="supervised"]')).disabled,
    ).toBe(true);
    expect(
      required(container.querySelector<HTMLInputElement>('input[value="observe_only"]')).checked,
    ).toBe(true);
    expect(container.textContent).toContain('「見るだけ」に対応します');
  });

  it('uses one remembered-profile click for exactly one window lookup and one start', async () => {
    const calls: string[] = [];
    const onResolveWindows = vi.fn(async (_profileId: string) => {
      calls.push('list');
      return [targetWindow];
    });
    const onStart = vi.fn(async () => {
      calls.push('start');
    });
    const { container } = await renderOnboarding({ onResolveWindows, onStart });
    const quickStart = required(
      container.querySelector<HTMLButtonElement>('[data-computer-use-activation="start"]'),
    );
    expect(quickStart.dataset.computerUseIntent).toContain('"operation":"quick_start"');
    expect(quickStart.dataset.computerUseIntent).toContain('"profileId":"profile-1"');

    await act(async () => {
      quickStart.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(calls).toEqual(['list', 'start']);
    expect(onResolveWindows).toHaveBeenCalledOnce();
    expect(onResolveWindows).toHaveBeenCalledWith('profile-1');
    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ profileRevision: 5 }));
  });

  it('clears provider egress consent whenever the selected provider changes', async () => {
    const { container } = await renderOnboarding({ providers: [provider, alternateProvider] });

    await submitWithEnter(container, '次へ');
    const consent = required(
      [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) =>
        input.parentElement?.textContent?.includes('選択したProviderへ'),
      ),
    );
    expect(consent.checked).toBe(true);

    const providerSelect = required(container.querySelectorAll<HTMLSelectElement>('select')[1]);
    await act(async () => {
      providerSelect.value = 'connection-2\0vision-model-2';
      providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(consent.checked).toBe(false);
    expect(container.textContent).toContain('画像入力対応は未確認です');
  });

  it('keeps Start disabled with an actionable empty Provider state', async () => {
    const { container } = await renderOnboarding({ providers: [] });

    await submitWithEnter(container, '次へ');
    expect(container.textContent).toContain('画像対応のProvider / Modelがありません');
    expect(container.textContent).toContain('AI Connections');
    const start = required(
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === '開始',
      ),
    );
    expect(start.disabled).toBe(true);
  });

  it('requires fresh egress consent when the Provider/Model binding changes', async () => {
    const alternate: ComputerUseProviderView = {
      ...provider,
      connectionId: 'connection-2',
      modelId: 'alternate-model',
      label: 'Anthropic',
    };
    const { container } = await renderOnboarding({ providers: [provider, alternate] });
    await submitWithEnter(container, '次へ');
    const providerSelects = [...container.querySelectorAll<HTMLSelectElement>('select')];
    const providerSelect = required(providerSelects[1]);
    const consent = required(
      [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) =>
        input.parentElement?.textContent?.includes('選択したProviderへ'),
      ),
    );
    expect(consent.checked).toBe(true);
    await act(async () => {
      providerSelect.value = 'connection-2\0alternate-model';
      providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(consent.checked).toBe(false);
  });

  it('handles Escape cancellation and closes the native dialog during unmount cleanup', async () => {
    const onClose = vi.fn();
    const item = await renderOnboarding({ onClose });
    expect(item.dialog.open).toBe(true);

    const cancel = new Event('cancel', { bubbles: false, cancelable: true });
    item.dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();

    mounted.splice(mounted.indexOf(item), 1);
    await act(async () => item.root.unmount());
    expect(item.dialog.open).toBe(false);
    item.container.remove();
  });

  it('moves focus to the approval action and back to Stop when the card resolves', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const session = {
      sessionId: 'session-1',
      appName: 'TextEdit',
      windowLabel: 'Untitled',
      mode: 'supervised' as const,
      providerLabel: 'OpenAI · Vision Model',
      state: 'awaiting_approval' as const,
      round: 1,
      maxRounds: 25,
      expiresAt: '2026-08-30T00:00:00.000Z',
      observedAt: '2026-08-29T12:00:00.000Z',
      pauseReason: null,
    };
    const approval = {
      id: 'approval-1',
      actionLabel: 'ボタンを押す',
      targetLabel: '保存',
      impactLabel: '対象アプリ内を変更します',
      escapedPreview: null,
      allowedDecisions: ['allow_once', 'deny'] as const,
    };

    await act(async () =>
      root.render(
        <ComputerUseSessionRail
          session={session}
          approval={null}
          stopping={false}
          onStop={() => {}}
          onApproval={() => {}}
        />,
      ),
    );
    const stop = required(container.querySelector<HTMLButtonElement>('.computer-use-stop'));
    await act(async () =>
      root.render(
        <ComputerUseSessionRail
          session={session}
          approval={approval}
          stopping={false}
          onStop={() => {}}
          onApproval={() => {}}
        />,
      ),
    );
    expect(document.activeElement?.textContent?.trim()).toBe('今回のみ許可');

    await act(async () =>
      root.render(
        <ComputerUseSessionRail
          session={session}
          approval={null}
          stopping={false}
          onStop={() => {}}
          onApproval={() => {}}
        />,
      ),
    );
    expect(document.activeElement).toBe(stop);
    await act(async () => root.unmount());
    container.remove();
  });
});

describe('Computer Use responsive and theme CSS', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/index.css'), 'utf8');
  const computerUseCss = css.slice(css.indexOf('/* ---------- Computer Use preview ----------'));

  it('uses existing theme tokens and preserves a 44px Stop target', () => {
    expect(computerUseCss).toContain('background: var(--bg-elevated)');
    expect(computerUseCss).toContain('color: var(--text-primary)');
    expect(computerUseCss).toContain('background: var(--bg-panel)');
    expect(computerUseCss).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(computerUseCss).toMatch(
      /\.computer-use-stop[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px;/,
    );
  });

  it('keeps narrow/200%-zoom reflow and reduced motion explicit', () => {
    expect(computerUseCss).toContain('width: min(680px, calc(100vw - 32px))');
    expect(computerUseCss).toContain('max-height: min(760px, calc(100vh - 32px))');
    expect(computerUseCss).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.computer-use-mode-list,[\s\S]*?grid-template-columns: 1fr;/,
    );
    expect(computerUseCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.computer-use-dialog,[\s\S]*?transition: none;[\s\S]*?animation: none;/,
    );
  });
});
