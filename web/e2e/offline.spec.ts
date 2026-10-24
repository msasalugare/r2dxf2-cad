import { expect, test } from '@playwright/test';

test('works offline after the page and WASM have loaded', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-wasm', 'loaded');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');

  // Block every subsequent network request (D7).
  await page.route('**/*', (route) => route.abort());

  // The sketch solve uses the already-loaded WASM core — no network needed.
  await page.locator('#sketch-btn').click();
  await page.mouse.click(360, 360);
  await page.mouse.click(560, 360);
  await page.locator('#sketch-solve').click();
  await expect(page.locator('#sketch-result')).toContainText('Solved');
});
