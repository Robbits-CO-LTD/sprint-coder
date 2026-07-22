import { defineConfig } from '@playwright/test';
import path from 'node:path';

// Playwright Electron E2E for vibe-editor3 (docs/PRODUCT_AND_TECHNICAL_DESIGN.md §15.5 golden
// paths). Targets the packaged production app (electron-forge package), never the `npm start`
// dev server. See tests/e2e/helpers.ts and tests/e2e/global-setup.ts.
export default defineConfig({
  testDir: path.join(__dirname, 'tests/e2e'),
  globalSetup: path.join(__dirname, 'tests/e2e/global-setup.ts'),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
