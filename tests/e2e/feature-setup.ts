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

export async function completeSetupForFeatureTest(page: FeatureSetupPage): Promise<void> {
  // DOMContentLoaded precedes React's first render; absence of the wizard is not yet a shell.
  await page.waitForFunction(
    () =>
      document.querySelector(
        '[data-testid="setup-wizard"], [data-testid="sidebar-new-task-button"]',
      ) !== null,
  );
  if ((await page.getByTestId('setup-wizard').count()) === 0) return;
  await page.evaluate(() => window.localStorage.setItem('sprint-coder:setup-complete-v1', '1'));
  await page.reload();
  await page.getByTestId('sidebar-new-task-button').waitFor({ state: 'visible' });
}
