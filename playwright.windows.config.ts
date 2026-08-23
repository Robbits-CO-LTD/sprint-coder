import { defineConfig } from '@playwright/test';

import { createPlaywrightConfig } from './playwright.base';

// Keep this list explicit. Windows CI must cover the local product flows below without silently
// adopting macOS-only lifecycle tests or opt-in tests that need a real CLI/provider credential.
export const WINDOWS_MAJOR_E2E_SPECS = [
  '**/keyboard-smoke.spec.ts',
  '**/setup-wizard.spec.ts',
  '**/composer-input-boundaries.spec.ts',
  '**/settings-dialog.spec.ts',
  '**/project-sidebar.spec.ts',
  '**/file-edits.spec.ts',
  '**/approval-flow.spec.ts',
  '**/team-flow.spec.ts',
] as const;

export default defineConfig(createPlaywrightConfig(), {
  testMatch: [...WINDOWS_MAJOR_E2E_SPECS],
  workers: 1,
  retries: 0,
  outputDir: 'test-results/windows-major-e2e',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
