// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ASSISTANT_PREFERENCES, type AssistantPreferences } from '@sprint-coder/contracts';
import { AssistantPreferencesSettings } from './AssistantPreferencesSettings';

let container: HTMLDivElement;
let root: Root;
let getAssistantPreferences: ReturnType<typeof vi.fn>;
let setAssistantPreferences: ReturnType<typeof vi.fn>;

function installBridge(settings: Record<string, unknown>): void {
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: { settings },
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  getAssistantPreferences = vi
    .fn()
    .mockResolvedValue({ configured: false, preferences: DEFAULT_ASSISTANT_PREFERENCES });
  setAssistantPreferences = vi.fn((preferences: AssistantPreferences) =>
    Promise.resolve({
      configured: true,
      preferences: { ...preferences, callName: preferences.callName.trim() },
    }),
  );
  installBridge({ getAssistantPreferences, setAssistantPreferences });
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

const input = (testId: string) =>
  container.querySelector<HTMLInputElement>(`[data-testid="${testId}"] input`)!;

async function renderLoaded(): Promise<void> {
  await act(async () => root.render(<AssistantPreferencesSettings active />));
}

describe('返事の仕方', () => {
  it('loads the stored values and saves each change right away with the full value', async () => {
    await renderLoaded();
    expect(getAssistantPreferences).toHaveBeenCalledOnce();
    expect(input('settings-assistant-tone-polite').checked).toBe(true);
    expect(input('settings-assistant-suggestNextSteps').checked).toBe(true);

    await act(async () => input('settings-assistant-tone-crisp').click());
    expect(setAssistantPreferences).toHaveBeenLastCalledWith({
      ...DEFAULT_ASSISTANT_PREFERENCES,
      tone: 'crisp',
    });
    expect(input('settings-assistant-tone-crisp').checked).toBe(true);

    await act(async () => input('settings-assistant-confirm-proceed').click());
    expect(setAssistantPreferences).toHaveBeenLastCalledWith({
      ...DEFAULT_ASSISTANT_PREFERENCES,
      tone: 'crisp',
      confirm: 'proceed',
    });

    await act(async () => input('settings-assistant-emoji').click());
    expect(setAssistantPreferences).toHaveBeenLastCalledWith({
      ...DEFAULT_ASSISTANT_PREFERENCES,
      tone: 'crisp',
      confirm: 'proceed',
      emoji: true,
    });
    expect(setAssistantPreferences).toHaveBeenCalledTimes(3);
  });

  it('saves the call name when typing ends, trimmed, and not again when unchanged', async () => {
    await renderLoaded();
    const field = container.querySelector<HTMLInputElement>(
      '[data-testid="settings-assistant-call-name"]',
    )!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(field, '  山田さん  ');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(setAssistantPreferences).not.toHaveBeenCalled();
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(setAssistantPreferences).toHaveBeenCalledExactlyOnceWith({
      ...DEFAULT_ASSISTANT_PREFERENCES,
      callName: '山田さん',
    });
    expect(field.value).toBe('山田さん');
    await act(async () => {
      field.focus();
      field.blur();
    });
    expect(setAssistantPreferences).toHaveBeenCalledOnce();
  });

  it('returns to the last stored value when a save fails', async () => {
    await renderLoaded();
    setAssistantPreferences.mockRejectedValueOnce(new Error('fixture failure'));
    await act(async () => input('settings-assistant-length-short').click());
    expect(input('settings-assistant-length-balanced').checked).toBe(true);
    expect(
      container.querySelector('[data-testid="settings-assistant-preferences-error"]')?.textContent,
    ).toContain('直前の値に戻しました');
  });

  it('keeps the controls disabled until the stored value arrives', async () => {
    let finishLoad!: (value: unknown) => void;
    getAssistantPreferences.mockReturnValueOnce(new Promise((resolve) => (finishLoad = resolve)));
    await renderLoaded();
    // Controls stay disabled until the stored value is known.
    expect(input('settings-assistant-tone-casual').disabled).toBe(true);
    await act(async () =>
      finishLoad({
        configured: true,
        preferences: { ...DEFAULT_ASSISTANT_PREFERENCES, tone: 'casual' },
      }),
    );
    expect(input('settings-assistant-tone-casual').checked).toBe(true);
  });

  it('renders no controls and does not throw when the bridge lacks the API', async () => {
    installBridge({});
    await renderLoaded();
    expect(container.querySelector('[data-testid="settings-assistant-preferences"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="settings-assistant-preferences-unavailable"]'),
    ).not.toBeNull();
    expect(container.querySelector('input')).toBeNull();
  });
});
