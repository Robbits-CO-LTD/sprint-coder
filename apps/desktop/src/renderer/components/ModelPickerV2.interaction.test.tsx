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
});

describe('ModelPickerV2 trigger name after a remount', () => {
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
