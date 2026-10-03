/** The small Page surface also permits deterministic first-render regression tests. */
export type FeatureSetupPage = {
  waitForFunction: (predicate: () => boolean) => Promise<unknown>;
  getByTestId: (id: string) => {
    count: () => Promise<number>;
    waitFor: (options: { state: 'visible' }) => Promise<unknown>;
  };
  evaluate: (callback: () => void) => Promise<unknown>;
  reload: () => Promise<unknown>;
};

/**
 * Issue #714: five booleans taken once when the first Sidebar click fails. They separate a shell
 * stuck before initialization/onboarding from a locator or closed-window failure after the shell
 * was ready. Nothing but booleans is read: no DOM text, URL, screenshot or element attribute.
 */
export type SidebarClickVector = {
  initialized: boolean;
  wizardPresent: boolean;
  sidebarPresent: boolean;
  sidebarVisible: boolean;
  pageClosed: boolean;
};

export type SidebarVectorPage = {
  isClosed: () => boolean;
  evaluate: (callback: () => Omit<SidebarClickVector, 'pageClosed'>) => Promise<unknown>;
};

const SIDEBAR_VECTOR_PROBE_TIMEOUT_MS = 3_000;
const SIDEBAR_VECTOR_KEYS = [
  'initialized',
  'wizardPresent',
  'sidebarPresent',
  'sidebarVisible',
] as const;

/** Never rejects and never waits longer than the probe bound; unreadable facts are false. */
export async function readSidebarClickVector(page: SidebarVectorPage): Promise<SidebarClickVector> {
  const vector: SidebarClickVector = {
    initialized: false,
    wizardPresent: false,
    sidebarPresent: false,
    sidebarVisible: false,
    pageClosed: false,
  };
  try {
    vector.pageClosed = page.isClosed();
    if (vector.pageClosed) return vector;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), SIDEBAR_VECTOR_PROBE_TIMEOUT_MS);
    });
    const probe = page
      .evaluate(() => {
        const sidebar = document.querySelector('[data-testid="sidebar-new-task-button"]');
        const box = sidebar?.getBoundingClientRect();
        return {
          initialized: document.querySelector('[data-app-initialized="true"]') !== null,
          wizardPresent: document.querySelector('[data-testid="setup-wizard"]') !== null,
          sidebarPresent: sidebar !== null && sidebar !== undefined,
          sidebarVisible: box !== undefined && box.width > 0 && box.height > 0,
        };
      })
      .catch(() => undefined);
    const observed = await Promise.race([probe, timedOut]);
    if (timer !== undefined) clearTimeout(timer);
    if (typeof observed === 'object' && observed !== null) {
      for (const key of SIDEBAR_VECTOR_KEYS) vector[key] = Reflect.get(observed, key) === true;
    }
    vector.pageClosed = page.isClosed();
  } catch {
    // A diagnostic must never replace the click failure it observes.
  }
  return vector;
}

/**
 * Runs the unchanged click. If it fails, the vector is recorded exactly once and the original
 * error is rethrown untouched; a failing recorder cannot replace it.
 */
export async function clickWithSidebarVector(
  page: SidebarVectorPage,
  click: () => Promise<unknown>,
  record: (vector: SidebarClickVector) => Promise<unknown>,
): Promise<void> {
  try {
    await click();
  } catch (error) {
    try {
      await record(await readSidebarClickVector(page));
    } catch {
      // Optional diagnostics must not replace the original failure.
    }
    throw error;
  }
}

/** Feature specs start beyond first-run onboarding; setup-wizard.spec.ts owns that boundary. */
export async function completeSetupForFeatureTest(page: FeatureSetupPage): Promise<void> {
  // The first React render exposes Sidebar before async initialization can select onboarding.
  await page.waitForFunction(
    () =>
      document.querySelector(
        '[data-app-initialized="true"] [data-testid="setup-wizard"], [data-app-initialized="true"] [data-testid="sidebar-new-task-button"]',
      ) !== null,
  );
  if ((await page.getByTestId('setup-wizard').count()) === 0) return;
  await page.evaluate(() => window.localStorage.setItem('sprint-coder:setup-complete-v1', '1'));
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector('[data-app-initialized="true"]') !== null,
  );
  await page.getByTestId('sidebar-new-task-button').waitFor({ state: 'visible' });
}
