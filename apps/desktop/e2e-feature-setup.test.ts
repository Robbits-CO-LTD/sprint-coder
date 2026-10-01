import { describe, expect, it, vi } from 'vitest';
import { completeSetupForFeatureTest } from '../../tests/e2e/feature-setup';
import type { FeatureSetupPage } from '../../tests/e2e/feature-setup';

function fixture(wizardInitiallyVisible = false) {
  let wizardVisible = wizardInitiallyVisible;
  let releaseRender: (() => void) | undefined;
  const rendered = new Promise<void>((resolve) => {
    releaseRender = resolve;
  });
  const count = vi.fn(async () => (wizardVisible ? 1 : 0));
  const visible = vi.fn(async () => undefined);
  const page: FeatureSetupPage = {
    waitForFunction: vi.fn(async () => rendered),
    getByTestId: (id) => ({
      count: id === 'setup-wizard' ? count : vi.fn(async () => 1),
      waitFor: visible,
    }),
    evaluate: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
  };
  return {
    page,
    count,
    visible,
    render(wizard: boolean) {
      wizardVisible = wizard;
      releaseRender?.();
    },
  };
}

describe('feature setup first-render boundary', () => {
  it('does not classify an empty pre-render DOM as completed setup', async () => {
    const f = fixture();
    let finished = false;
    const pending = completeSetupForFeatureTest(f.page).then(() => {
      finished = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(f.count).not.toHaveBeenCalled();
    f.render(true);
    await pending;
    expect(f.page.evaluate).toHaveBeenCalledOnce();
    expect(f.page.reload).toHaveBeenCalledOnce();
    expect(f.visible).toHaveBeenCalledWith({ state: 'visible' });
  });

  it('keeps an already completed shell and profile unchanged', async () => {
    const f = fixture();
    f.render(false);
    await completeSetupForFeatureTest(f.page);
    expect(f.page.evaluate).not.toHaveBeenCalled();
    expect(f.page.reload).not.toHaveBeenCalled();
  });

  it('completes a rendered wizard and waits for the shell after reload', async () => {
    const f = fixture(true);
    f.render(true);
    await completeSetupForFeatureTest(f.page);
    expect(f.page.evaluate).toHaveBeenCalledOnce();
    expect(f.page.reload).toHaveBeenCalledOnce();
    expect(f.visible).toHaveBeenCalledOnce();
  });

  it('propagates a first-render timeout without modifying setup', async () => {
    const f = fixture();
    const error = new Error('first render timeout');
    f.page.waitForFunction = vi.fn(async () => {
      throw error;
    });
    await expect(completeSetupForFeatureTest(f.page)).rejects.toBe(error);
    expect(f.count).not.toHaveBeenCalled();
    expect(f.page.evaluate).not.toHaveBeenCalled();
  });
});
