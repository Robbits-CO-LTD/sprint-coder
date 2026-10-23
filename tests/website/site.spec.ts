import { test, expect, type Page } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const siteRoot = resolve(__dirname, '../../website');
const routes = readdirSync(siteRoot, { recursive: true })
  .filter(
    (file): file is string =>
      typeof file === 'string' &&
      file.endsWith('.html') &&
      !file.replaceAll('\\', '/').startsWith('tools/'),
  )
  .map((file) => `/${file.replaceAll('\\', '/')}`.replace(/\/index\.html$/u, '/'))
  .sort();

const testWithNetwork = test.extend<{ errors: string[] }>({
  errors: [
    async ({ page, baseURL }, use) => {
      const errors: string[] = [];
      const origin = new URL(baseURL!).origin;
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol))
          await route.continue();
        else {
          errors.push(`Unexpected external request: ${url.origin}${url.pathname}`);
          await route.abort();
        }
      });
      page.on('pageerror', (error) => errors.push(`JavaScript: ${error.message}`));
      page.on('response', (response) => {
        if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`);
      });
      page.on('requestfailed', (request) => {
        const failure = request.failure()?.errorText;
        // Navigation and pausing a clip intentionally cancel in-flight resource transfers.
        if (failure !== 'net::ERR_ABORTED')
          errors.push(`Request failed: ${failure}: ${request.url()}`);
      });
      await use(errors);
      expect(errors, 'No JavaScript exceptions, missing resources, or external requests').toEqual(
        [],
      );
    },
    { auto: true },
  ],
});

async function open(page: Page, route: string) {
  const response = await page.goto(route, { waitUntil: 'load' });
  expect(response?.status()).toBe(200);
  await page.evaluate(() => document.fonts.ready);
}

testWithNetwork(
  'homepage controls play, pause, seek, and close the full-video dialog',
  async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open(page, '/');
    const motion = page.locator('[data-motion]');
    await expect(motion).toBeVisible();
    await motion.click();
    await expect(motion).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('html')).toHaveClass(/motion-off/u);
    await motion.click();
    await expect(motion).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('html')).not.toHaveClass(/motion-off/u);

    const play = page.locator('.p-play');
    await play.click();
    await expect(play).toHaveAttribute('aria-label', '一時停止');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(5);
    await play.click();
    await expect(play).toHaveAttribute('aria-label', '自動で再生');
    const position = page.getByRole('slider');
    await position.focus();
    await page.keyboard.press('ArrowRight');
    await expect(position).toHaveAttribute('aria-valuenow', '1');
    await page.keyboard.press('Home');
    await expect(position).toHaveAttribute('aria-valuenow', '0');

    const fullVideo = page.locator('[data-open-promo]:visible').first();
    await fullVideo.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(fullVideo).toBeFocused();
  },
);

for (const route of routes) {
  testWithNetwork(
    `renders ${route} with reduced motion and working download navigation`,
    async ({ page }) => {
      await open(page, route);
      await expect(page).toHaveTitle(/\S/u);
      await expect(
        page.getByRole('link', { name: 'Sprint Coder トップ', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
      await expect(page.locator('[data-motion]')).toBeHidden();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      expect(
        await page
          .locator('video')
          .evaluateAll((videos) =>
            videos.every((video) => video instanceof HTMLVideoElement && video.paused),
          ),
      ).toBe(true);
      const download = page.locator('.site-header a.btn-primary');
      await download.click();
      if (route === '/') {
        await expect(page).toHaveURL(/\/#start$/u);
        await expect(page.locator('#start')).toBeInViewport();
      } else {
        await expect(page).toHaveURL(/\/releases\/$/u);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      }
    },
  );
}
