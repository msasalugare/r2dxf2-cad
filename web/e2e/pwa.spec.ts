import { expect, test } from '@playwright/test';
import { E2E_PASSWORD, E2E_USERNAME } from './helpers';

test('PWA exposes a valid manifest and install icons', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');

  const response = await page.request.get('/manifest.webmanifest');
  expect(response.ok()).toBeTruthy();
  expect(response.headers()['content-type']).toContain('application/manifest+json');
  const manifest = await response.json();
  expect(manifest.name).toBe('RasterFit CAD Studio');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/');
  expect(manifest.scope).toBe('/');

  for (const icon of manifest.icons) {
    const iconResponse = await page.request.get(icon.src);
    expect(iconResponse.ok(), icon.src).toBeTruthy();
    expect(iconResponse.headers()['content-type']).toContain(icon.type);
  }
});

test('PWA controls the page, opens its shell offline and never caches API responses', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.active) throw new Error('Service worker nije aktivan.');
  });

  await page.reload();
  await expect(page.locator('#auth-screen')).toBeVisible();
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBeTruthy();

  await page.locator('#auth-screen input[name="username"]').fill(E2E_USERNAME);
  await page.locator('#auth-screen input[name="password"]').fill(E2E_PASSWORD);
  await page.locator('#auth-screen button[type="submit"]').click();
  await expect(page.locator('.start-card')).toBeVisible();

  const cachedUrls = await page.evaluate(async () => {
    const names = await caches.keys();
    const requests = await Promise.all(names.map(async (name) => (await caches.open(name)).keys()));
    return requests.flat().map((request) => request.url);
  });
  expect(cachedUrls.some((url) => new URL(url).pathname.startsWith('/api/'))).toBeFalsy();
  expect(cachedUrls.some((url) => url.endsWith('/index.html'))).toBeTruthy();

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');
  await expect(page.locator('#auth-screen')).toBeVisible();
  await context.setOffline(false);
});
