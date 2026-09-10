// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedLocalSpeculativeSettingsSetInput,
  ManagedLocalSpeculativeSettingsView,
} from '@sprint-coder/contracts';
import { ManagedLocalSpeculativeSettingsCard } from './ManagedLocalSpeculativeSettingsCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = 'a'.repeat(64);
const draftId = 'b'.repeat(64);
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  delete window.sprintCoder;
  document.body.innerHTML = '';
});

async function render(overrides: Partial<ManagedLocalSpeculativeSettingsView> = {}) {
  const view: ManagedLocalSpeculativeSettingsView = {
    modelId: id,
    configured: { type: 'off', draftModelId: null, draftTokensMax: 3 },
    baseModelId: 'owner/base',
    supported: true,
    reason: null,
    recoveryRequired: false,
    eligibleDrafts: [
      { id: draftId, sourceId: 'owner/draft', quantization: 'Q8_0', baseModelId: 'owner/base' },
    ],
    ...overrides,
  };
  const read = vi.fn(async () => view);
  const save = vi.fn(async (input: ManagedLocalSpeculativeSettingsSetInput) => ({
    ...view,
    configured: input.settings,
    recoveryRequired: false,
  }));
  window.sprintCoder = {
    localAI: { speculativeSettings: read, setSpeculativeSettings: save },
  } as unknown as NonNullable<Window['sprintCoder']>;
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<ManagedLocalSpeculativeSettingsCard modelId={id} runtime={null} />),
  );
  return { read, save, container };
}

async function expand(container: HTMLElement) {
  await act(async () => {
    const details = container.querySelector('details')!;
    details.open = true;
    details.dispatchEvent(new Event('toggle', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('ManagedLocalSpeculativeSettingsCard', () => {
  it('loads only the explicitly opened target, selects a compatible draft and saves typed settings', async () => {
    const { read, save, container } = await render();
    expect(read).not.toHaveBeenCalled();
    await expand(container);
    expect(read).toHaveBeenCalledWith(id);
    const mode = container.querySelector<HTMLSelectElement>(`#spec-mode-${id}`)!;
    await act(async () => {
      mode.value = 'draft-dflash';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const button = [...container.querySelectorAll('button')].find(
      (node) => node.textContent === '投機的デコード設定を保存',
    )!;
    await act(async () => button.click());
    expect(save).toHaveBeenCalledWith({
      modelId: id,
      settings: { type: 'draft-dflash', draftModelId: draftId, draftTokensMax: 3 },
    });
    expect(container.textContent).toContain('保存しました');
  });

  it('keeps unsupported DFlash disabled while allowing acknowledgement of recovered off settings', async () => {
    const { save, container } = await render({
      supported: false,
      eligibleDrafts: [],
      recoveryRequired: true,
      reason: 'Runtime未対応',
    });
    await expand(container);
    expect(
      container.querySelector<HTMLOptionElement>('option[value="draft-dflash"]')?.disabled,
    ).toBe(true);
    expect(container.textContent).toContain('オフに戻しました');
    const button = [...container.querySelectorAll('button')].find(
      (node) => node.textContent === '投機的デコード設定を保存',
    )!;
    await act(async () => button.click());
    expect(save).toHaveBeenCalledWith({
      modelId: id,
      settings: { type: 'off', draftModelId: null, draftTokensMax: 3 },
    });
  });

  it('shows an inline token range error and prevents invalid saves', async () => {
    const { save, container } = await render({
      configured: { type: 'draft-dflash', draftModelId: draftId, draftTokensMax: 3 },
    });
    await expand(container);
    const input = container.querySelector<HTMLInputElement>(`#spec-tokens-${id}`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '65');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('1〜64の整数');
    expect(
      [...container.querySelectorAll('button')].find(
        (node) => node.textContent === '投機的デコード設定を保存',
      )?.disabled,
    ).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
});
