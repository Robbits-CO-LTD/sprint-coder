import { describe, expect, it, vi } from 'vitest';
import {
  clickWithSidebarVector,
  completeSetupForFeatureTest,
  readSidebarClickVector,
} from '../../tests/e2e/feature-setup';
import type {
  FeatureSetupPage,
  SidebarClickVector,
  SidebarVectorPage,
} from '../../tests/e2e/feature-setup';

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
  it('does not accept the initial Sidebar before initialization reveals onboarding', async () => {
    const f = fixture();
    let initialized = false;
    const querySelector = vi.fn((selector: string) =>
      !selector.includes('data-app-initialized') || initialized ? {} : null,
    );
    vi.stubGlobal('document', { querySelector });
    const rendered = new Promise<void>((resolve) => {
      f.page.waitForFunction = vi.fn(async (predicate) => {
        if (!predicate())
          await new Promise<void>((ready) => {
            initialized = true;
            f.render(true);
            ready();
          });
        expect(predicate()).toBe(true);
        resolve();
      });
    });
    try {
      await completeSetupForFeatureTest(f.page);
      await rendered;
      expect(initialized).toBe(true);
      expect(f.page.evaluate).toHaveBeenCalledOnce();
      expect(f.page.reload).toHaveBeenCalledOnce();
      expect(f.visible).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

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

describe('Sidebar click bool vector (issue #714)', () => {
  const states = (vector: SidebarClickVector) => JSON.stringify(vector);

  function vectorPage(
    observed: unknown,
    closed = false,
  ): SidebarVectorPage & { evaluate: ReturnType<typeof vi.fn> } {
    return {
      isClosed: () => closed,
      evaluate: vi.fn(async () => observed),
    };
  }

  it('keeps a successful click free of any probe or artifact', async () => {
    const page = vectorPage({});
    const record = vi.fn(async () => undefined);
    await clickWithSidebarVector(page, async () => undefined, record);
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('records one all-false vector except the closed flag for a closed window, then rethrows', async () => {
    const page = vectorPage({ initialized: true }, true);
    const record = vi.fn(async () => undefined);
    const error = new Error('click timeout');
    await expect(
      clickWithSidebarVector(
        page,
        async () => {
          throw error;
        },
        record,
      ),
    ).rejects.toBe(error);
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({
      initialized: false,
      wizardPresent: false,
      sidebarPresent: false,
      sidebarVisible: false,
      pageClosed: true,
    });
  });

  it('separates an uninitialized wizard shell from a ready shell with a missing Sidebar', async () => {
    const stuck = await readSidebarClickVector(
      vectorPage({
        initialized: false,
        wizardPresent: true,
        sidebarPresent: false,
        sidebarVisible: false,
      }),
    );
    expect(stuck).toEqual({
      initialized: false,
      wizardPresent: true,
      sidebarPresent: false,
      sidebarVisible: false,
      pageClosed: false,
    });
    const ready = await readSidebarClickVector(
      vectorPage({
        initialized: true,
        wizardPresent: false,
        sidebarPresent: true,
        sidebarVisible: false,
      }),
    );
    expect(ready).toMatchObject({ initialized: true, sidebarPresent: true, sidebarVisible: false });
  });

  it('keeps only booleans even when the page returns private text or extra fields', async () => {
    const vector = await readSidebarClickVector(
      vectorPage({
        initialized: 'PRIVATE_TEXT',
        wizardPresent: 1,
        sidebarPresent: true,
        sidebarVisible: true,
        url: 'PRIVATE_URL',
        text: 'PRIVATE_BODY',
      }),
    );
    expect(Object.keys(vector).sort()).toEqual([
      'initialized',
      'pageClosed',
      'sidebarPresent',
      'sidebarVisible',
      'wizardPresent',
    ]);
    expect(states(vector)).not.toContain('PRIVATE_');
    expect(vector).toMatchObject({
      initialized: false,
      wizardPresent: false,
      sidebarVisible: true,
    });
  });

  it('stays bounded and false when the probe rejects or never answers', async () => {
    const rejecting = vectorPage({});
    rejecting.evaluate.mockRejectedValue(new Error('Target closed PRIVATE'));
    expect(await readSidebarClickVector(rejecting)).toEqual({
      initialized: false,
      wizardPresent: false,
      sidebarPresent: false,
      sidebarVisible: false,
      pageClosed: false,
    });
    vi.useFakeTimers();
    try {
      const hanging = vectorPage({});
      hanging.evaluate.mockReturnValue(new Promise(() => undefined));
      const pending = readSidebarClickVector(hanging);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await pending).toMatchObject({ sidebarPresent: false, pageClosed: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a failing recorder replace the click error', async () => {
    const error = new Error('click timeout');
    const record = vi.fn(async () => {
      throw new Error('disk PRIVATE');
    });
    await expect(
      clickWithSidebarVector(
        vectorPage({}),
        async () => {
          throw error;
        },
        record,
      ),
    ).rejects.toBe(error);
    expect(record).toHaveBeenCalledOnce();
  });
});
