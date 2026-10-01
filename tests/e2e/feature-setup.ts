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
