import { defineConfig } from '@playwright/test';
import path from 'node:path';

export function createPlaywrightConfig() {
  return defineConfig({
    testDir: path.join(__dirname, 'tests/e2e'),
    globalSetup: path.join(__dirname, 'tests/e2e/global-setup.ts'),
    timeout: 90_000,
    expect: { timeout: 15_000 },
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [['list']],
  });
}
