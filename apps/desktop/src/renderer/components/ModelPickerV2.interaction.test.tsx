// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ModelCatalogQueryResult,
  ModelSelection,
  ProviderModel,
} from '@sprint-coder/contracts';
import { ModelPickerV2 } from './ModelPickerV2';
import { useAppStore } from '../store/appStore';
import { OPEN_PROVIDER_SETTINGS_EVENT } from '../lib/settings-navigation';

const initial = useAppStore.getInitialState();
const SONNET_SELECTION: ModelSelection = {
  connectionId: 'builtin:claude-cli',
  requestedProvider: 'anthropic',
  requestedModel: 'sonnet',
};

const unknown = { value: null, source: 'unknown' as const };

function model(overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    connectionId: 'builtin:claude-cli',
    connectionDisplayName: 'Claude Code',
    providerId: 'anthropic',
    modelId: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    available: true,
    availabilityCheckedAt: '2026-07-29T00:00:00.000Z',
    contextWindow: unknown,
    maxOutputTokens: unknown,
    toolCalling: unknown,
    structuredOutput: unknown,
    multimodalInput: unknown,
    reasoning: unknown,
    ...overrides,
  };
}

function catalogResult(
  items: readonly ProviderModel[],
  selection: ModelSelection = SONNET_SELECTION,
): ModelCatalogQueryResult {
  return {
    revision: 1,
    total: items.length,
    items: [...items],
    nextCursor: null,
    selection,
    multiProviderModelPickerV2: true,
  };
}

function showSelection(selection: ModelSelection | null) {
  useAppStore.setState({
    modelPicker: { taskId: 'task-a', enabled: true, selection },
  });
}

let container: HTMLDivElement;
let root: Root;
let query: ReturnType<typeof vi.fn<(input: unknown) => Promise<ModelCatalogQueryResult>>>;

function triggerText(): string {
  const element = container.querySelector<HTMLElement>('[data-testid="model-picker-v2-trigger"]');
  expect(element).not.toBeNull();
  return element?.textContent ?? '';
}

async function flush() {
  await act(async () => {});
}

async function renderPicker(key: string) {
  await act(async () => {
    root.render(<ModelPickerV2 key={key} taskId="task-a" />);
  });
  await flush();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useAppStore.setState(initial, true);
  showSelection(SONNET_SELECTION);
  query = vi.fn<(input: unknown) => Promise<ModelCatalogQueryResult>>();
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: { models: { query } },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.setState(initial, true);
  Reflect.deleteProperty(window, 'sprintCoder');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ModelPickerV2 next-page recovery', () => {
  const firstItems = Array.from({ length: 50 }, (_, index) =>
    model({ modelId: `page-${index}`, displayName: `Model ${index}` }),
  );
  const nextItems = Array.from({ length: 50 }, (_, index) =>
    model({ modelId: `page-${index + 50}`, displayName: `Model ${index + 50}` }),
  );
  const firstPage = { ...catalogResult(firstItems), total: 100, nextCursor: 'c50' };
  const lastPage = { ...catalogResult(nextItems), total: 100 };
  async function scrollEnd() {
    const list = container.querySelector<HTMLElement>('[role="listbox"]')!;
    await act(async () => {
      list.scrollTop = 44 * 46;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  }
  async function failNext() {
    showSelection(null);
    query.mockResolvedValueOnce(firstPage).mockRejectedValueOnce(new Error('page unavailable'));
    await renderPicker('paging');
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="model-picker-v2-trigger"]')!
        .click(),
    );
    await scrollEnd();
  }
  const retry = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="model-picker-v2-next-retry"]');
  const count = () => container.querySelector('[data-testid="model-picker-v2-count"]')?.textContent;

  it('keeps loaded rows, reports the failed page and retries the same cursor only once', async () => {
    await failNext();
    expect(count()).toBe('100件中50件を読み込み済み');
    expect(container.textContent).toContain('続きを読み込めませんでした');
    expect(retry()).not.toBeNull();
    await scrollEnd();
    expect(query).toHaveBeenCalledTimes(2);
    let resolve!: (value: ModelCatalogQueryResult) => void;
    query.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const button = retry()!;
    button.focus();
    await act(async () => {
      button.click();
      button.click();
    });
    await scrollEnd();
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2]?.[0]).toEqual(query.mock.calls[1]?.[0]);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button);
    await act(async () => resolve(lastPage));
    expect(count()).toBe('100件中100件を読み込み済み');
    expect(retry()).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="model-picker-v2-search"]'),
    );
  });

  it('does not fetch a consumed cursor from a scroll event before the success render commits', async () => {
    await failNext();
    query.mockResolvedValue(lastPage);
    const list = container.querySelector<HTMLElement>('[role="listbox"]')!;
    await act(async () => {
      retry()!.click();
      // IPC resolves while React still exposes the previous page's handlers.
      await Promise.resolve();
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(count()).toBe('100件中100件を読み込み済み');
  });

  it('does not automatically retry a failed cursor before its error render commits', async () => {
    showSelection(null);
    query.mockResolvedValueOnce(firstPage).mockRejectedValue(new Error('page unavailable'));
    await renderPicker('automatic-failure');
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="model-picker-v2-trigger"]')!
        .click(),
    );
    const list = container.querySelector<HTMLElement>('[role="listbox"]')!;
    await act(async () => {
      list.scrollTop = 44 * 46;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
      await Promise.resolve();
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(retry()).not.toBeNull();
  });

  it('does not append a successful automatic next page twice before React commits', async () => {
    showSelection(null);
    query.mockResolvedValueOnce(firstPage).mockResolvedValue(lastPage);
    await renderPicker('automatic-page');
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="model-picker-v2-trigger"]')!
        .click(),
    );
    const list = container.querySelector<HTMLElement>('[role="listbox"]')!;
    await act(async () => {
      list.scrollTop = 44 * 46;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
      await Promise.resolve();
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(count()).toBe('100件中100件を読み込み済み');
  });

  it('retains the same retry after a repeated failure and replaces changed catalog revisions', async () => {
    await failNext();
    query.mockRejectedValueOnce(new Error('still unavailable'));
    expect(retry()).not.toBeNull();
    const button = retry()!;
    button.focus();
    await act(async () => button.click());
    expect(count()).toBe('100件中50件を読み込み済み');
    expect(document.activeElement).toBe(button);
    query.mockResolvedValueOnce({
      ...catalogResult([
        model({ connectionId: 'connection-one', modelId: 'same', displayName: 'Fresh one' }),
        model({ connectionId: 'connection-two', modelId: 'same', displayName: 'Fresh two' }),
      ]),
      revision: 2,
    });
    await act(async () => button.click());
    expect(count()).toBe('2件中2件を読み込み済み');
    expect(container.textContent).toContain('Fresh one');
    expect(container.textContent).toContain('Fresh two');
    expect(retry()).toBeNull();
  });
  async function changeSearch(text: string) {
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="model-picker-v2-search"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it.each(['search', 'access', 'reopen', 'unmount'] as const)(
    'ignores stale retry success and failure after %s',
    async (change) => {
      vi.useFakeTimers();
      await failNext();
      let resolve!: (value: ModelCatalogQueryResult) => void;
      query.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      );
      await act(async () => retry()!.click());
      const fresh = {
        ...catalogResult([model({ modelId: 'fresh', displayName: 'Fresh result' })]),
        revision: 9,
      };
      query.mockResolvedValueOnce(fresh);
      if (change === 'search') {
        await changeSearch('fresh');
        // An old response during the debounce interval must not append rows or hide the new loading state.
        await act(async () => resolve(lastPage));
        expect(count()).not.toBe('100件中100件を読み込み済み');
        await act(async () => vi.advanceTimersByTimeAsync(200));
      } else if (change === 'access') {
        await act(async () =>
          container
            .querySelector<HTMLButtonElement>('[data-testid="model-picker-v2-access-api"]')!
            .click(),
        );
      } else if (change === 'reopen') {
        const trigger = container.querySelector<HTMLButtonElement>(
          '[data-testid="model-picker-v2-trigger"]',
        )!;
        await act(async () => trigger.click());
        await act(async () => trigger.click());
      } else {
        await renderPicker('replacement');
        await act(async () =>
          container
            .querySelector<HTMLButtonElement>('[data-testid="model-picker-v2-trigger"]')!
            .click(),
        );
      }
      await act(async () => resolve(lastPage));
      expect(count()).toBe('1件中1件を読み込み済み');
      expect(container.textContent).toContain('Fresh result');
      expect(retry()).toBeNull();
    },
  );

  it('does not let an obsolete failure release a newer request or steal focus', async () => {
    vi.useFakeTimers();
    await failNext();
    let reject!: (reason: Error) => void;
    query.mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    await act(async () => retry()!.click());
    let resolve!: (value: ModelCatalogQueryResult) => void;
    query.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="model-picker-v2-access-api"]')!
        .click(),
    );
    await act(async () => reject(new Error('late failure')));
    expect(count()).toBe('検索中');
    expect(retry()).toBeNull();
    await act(async () => resolve(catalogResult([])));
    expect(count()).toBe('0件中0件を読み込み済み');
  });

  it('refreshes the original query when typing is reverted before debounce', async () => {
    vi.useFakeTimers();
    await failNext();
    query.mockResolvedValueOnce(firstPage);
    await changeSearch('x');
    await changeSearch('');
    expect(query).toHaveBeenCalledTimes(3);
    expect(count()).toBe('100件中50件を読み込み済み');
    expect(retry()).toBeNull();
  });
});

describe('ModelPickerV2 active option after manual scroll', () => {
  async function openMany() {
    showSelection(null);
    const setModelSelection = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ setModelSelection });
    const items = Array.from({ length: 1200 }, (_, i) =>
      model({ modelId: `model-${i}`, displayName: `Model ${i}` }),
    );
    query.mockResolvedValue(catalogResult(items));
    await renderPicker('large');
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="model-picker-v2-trigger"]',
    )!;
    await act(async () => trigger.click());
    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!;
    const list = container.querySelector<HTMLElement>('[role="listbox"]')!;
    return { input, list, trigger, setModelSelection };
  }
  async function scrollTo(list: HTMLElement, row: number) {
    await act(async () => {
      list.scrollTop = row * 46;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  }
  function activeRow(input: HTMLInputElement) {
    const id = input.getAttribute('aria-activedescendant');
    expect(id).not.toBeNull();
    const row = document.getElementById(id!);
    expect(row).not.toBeNull();
    expect(row?.classList.contains('active')).toBe(true);
    expect(container.querySelectorAll('[role="option"]').length).toBeLessThanOrEqual(10);
    return row;
  }
  it('keeps the visible active row, ARIA reference and Enter selection aligned without pulling scroll back', async () => {
    const { input, list, trigger, setModelSelection } = await openMany();
    await scrollTo(list, 44);
    expect(activeRow(input)?.dataset.testid).toBe('model-picker-v2-option-model-44');
    expect(list.scrollTop).toBe(44 * 46);
    expect(document.activeElement).toBe(input);
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(setModelSelection).toHaveBeenCalledExactlyOnceWith(
      'task-a',
      expect.objectContaining({ requestedModel: 'model-44' }),
    );
    expect(document.activeElement).toBe(trigger);
  });
  it('continues Arrow/Home/End navigation from the visible row through both scroll directions', async () => {
    const { input, list } = await openMany();
    await scrollTo(list, 44);
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    );
    expect(activeRow(input)?.dataset.testid).toBe('model-picker-v2-option-model-45');
    await scrollTo(list, 10);
    const row = activeRow(input)!;
    const index = Number(row.dataset.testid?.split('-').at(-1));
    expect(index).toBeGreaterThanOrEqual(10);
    expect(index).toBeLessThan(16);
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })),
    );
    expect(activeRow(input)?.dataset.testid).toBe('model-picker-v2-option-model-1199');
    await act(async () => list.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(activeRow(input)?.dataset.testid).toBe('model-picker-v2-option-model-1199');
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })),
    );
    expect(activeRow(input)?.dataset.testid).toBe('model-picker-v2-option-model-0');
    expect(list.scrollTop).toBe(0);
  });
});

describe('ModelPickerV2 trigger name after a remount', () => {
  it('preserves a retired local selection when its catalog row is absent', async () => {
    const selection: ModelSelection = {
      connectionId: 'managed-local:runtime',
      requestedProvider: 'sprint-managed-local',
      requestedModel: 'retired-local-model',
    };
    showSelection(selection);
    query.mockResolvedValue(catalogResult([], selection));
    await renderPicker('retired-local');
    expect(triggerText()).toBe('retired-local-model');
    expect(useAppStore.getState().modelPicker.selection).toEqual(selection);
  });

  it('shows the catalog display name on mount and again after a remount', async () => {
    query.mockResolvedValue(
      catalogResult([
        model({ modelId: 'sonnet-legacy', displayName: 'Sonnet Legacy' }),
        model({ modelId: 'sonnet', displayName: 'Sonnet 5' }),
      ]),
    );

    await renderPicker('mount-a');
    expect(triggerText()).toBe('Sonnet 5');
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'sonnet',
        connectionIds: ['builtin:claude-cli'],
      }),
    );

    await renderPicker('mount-b');
    expect(triggerText()).toBe('Sonnet 5');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('keeps the id when the only row with that model id is on another connection', async () => {
    query.mockResolvedValue(
      catalogResult([
        model({
          connectionId: 'openrouter-1',
          providerId: 'openrouter',
          modelId: 'sonnet',
          displayName: 'Other Sonnet',
        }),
      ]),
    );

    await renderPicker('other-connection');
    expect(query).toHaveBeenCalled();
    expect(triggerText()).toBe('sonnet');
  });

  it('keeps the id when the lookup fails or the catalog has no row', async () => {
    query.mockRejectedValue(new Error('catalog unavailable'));
    await renderPicker('reject');
    expect(query).toHaveBeenCalled();
    expect(triggerText()).toBe('sonnet');

    query.mockReset();
    query.mockResolvedValue(catalogResult([]));
    await renderPicker('empty');
    expect(query).toHaveBeenCalled();
    expect(triggerText()).toBe('sonnet');
  });

  it('ignores a display name that arrives after the selection has changed', async () => {
    const opus: ModelSelection = {
      connectionId: 'builtin:claude-cli',
      requestedProvider: 'anthropic',
      requestedModel: 'opus',
    };
    let resolveFirst: (value: ModelCatalogQueryResult) => void = () => {};
    const first = new Promise<ModelCatalogQueryResult>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    query.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return first;
      return Promise.resolve(catalogResult([], opus));
    });

    await renderPicker('late');
    expect(triggerText()).toBe('sonnet');

    await act(async () => {
      showSelection(opus);
    });
    await flush();
    expect(triggerText()).toBe('opus');

    await act(async () => {
      resolveFirst(catalogResult([model({ modelId: 'sonnet', displayName: 'Sonnet 5' })]));
    });
    await flush();
    expect(triggerText()).toBe('opus');
  });

  it('does not query, and shows auto, when the task has no selection', async () => {
    showSelection(null);
    await renderPicker('none');
    expect(query).not.toHaveBeenCalled();
    expect(triggerText()).toBe('自動');
  });
});

describe('ModelPickerV2 IME keyboard boundary', () => {
  async function openChoices() {
    const setModelSelection = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ setModelSelection });
    query.mockResolvedValue(
      catalogResult([
        model({ modelId: 'sonnet', displayName: 'Sonnet' }),
        model({ modelId: 'opus', displayName: 'Opus' }),
      ]),
    );
    await renderPicker('ime');
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="model-picker-v2-trigger"]',
    )!;
    await act(async () => trigger.click());
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="model-picker-v2-search"]',
    )!;
    return { trigger, input, setModelSelection };
  }

  it.each(['Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End'])(
    'leaves composing %s to the IME without selecting, moving or closing',
    async (key) => {
      const { input, setModelSelection } = await openChoices();
      const active = input.getAttribute('aria-activedescendant');
      const event = new KeyboardEvent('keydown', {
        key,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, 'keyCode', { value: 229 });
      await act(async () => input.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      expect(setModelSelection).not.toHaveBeenCalled();
      expect(container.contains(input)).toBe(true);
      expect(input.getAttribute('aria-activedescendant')).toBe(active);
      expect(document.activeElement).toBe(input);
    },
  );

  it('selects once with normal Arrow/Enter after composition and returns focus', async () => {
    const { input, trigger, setModelSelection } = await openChoices();
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
      ),
    );
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
    );
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(setModelSelection).toHaveBeenCalledExactlyOnceWith('task-a', {
      connectionId: 'builtin:claude-cli',
      requestedProvider: 'anthropic',
      requestedModel: 'opus',
    });
    expect(container.contains(input)).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('closes without selecting on normal Escape', async () => {
    const { input, trigger, setModelSelection } = await openChoices();
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(setModelSelection).not.toHaveBeenCalled();
    expect(container.contains(input)).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});

describe('local catalog Provider-settings destination', () => {
  async function showLocalCatalog() {
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="model-picker-v2-trigger"]',
    )!;
    await act(async () => trigger.click());
    await flush();
    const local = container.querySelector<HTMLButtonElement>(
      '[data-testid="model-picker-v2-access-local"]',
    )!;
    await act(async () => local.click());
    await flush();
    return trigger;
  }

  it('offers the Provider destination and restores the durable opener before navigation', async () => {
    query.mockResolvedValue(catalogResult([]));
    await renderPicker('local-empty');
    const trigger = await showLocalCatalog();
    const requested = vi.fn();
    window.addEventListener(OPEN_PROVIDER_SETTINGS_EVENT, requested);
    try {
      const add = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === 'プロバイダー接続を追加',
      )!;
      expect(add).toBeDefined();
      expect(container.textContent).not.toContain('Local AI Selector');
      add.focus();
      await act(async () => add.click());
      expect(requested).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(trigger);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(query).toHaveBeenCalledWith(expect.objectContaining({ accessTypes: ['local'] }));
    } finally {
      window.removeEventListener(OPEN_PROVIDER_SETTINGS_EVENT, requested);
    }
  });

  it('keeps a failed local listing distinct from an empty local catalog', async () => {
    query.mockRejectedValue(new Error('fixture unavailable'));
    await renderPicker('local-error');
    await showLocalCatalog();
    expect(container.textContent).toContain('モデル一覧を取得できませんでした');
    expect(container.textContent).not.toContain('プロバイダー接続を追加');
  });
});
