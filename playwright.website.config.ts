import { defineConfig } from '@playwright/test';

const port = process.env.WEBSITE_TEST_PORT ?? '4175';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/website',
  outputDir: 'test-results/website',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/website/results.json' }]],
  use: {
    baseURL,
    browserName: 'chromium',
    contextOptions: { reducedMotion: 'reduce' },
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    {
      name: 'mobile',
      use: { viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: 'node ci-website.mjs serve',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
