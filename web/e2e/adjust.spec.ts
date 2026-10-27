import { expect, test } from '@playwright/test';
import { login } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('image adjustments panel re-processes the raster server-side', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');

  await page.locator('#adjust-btn').click();
  await expect(page.locator('#adjust-panel')).toBeVisible();

  // Change contrast: the debounced server re-process runs and clears the
  // processing indicator when done, without an error status.
  await page.locator('#adjust-contrast').evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = '1.5';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#adjust-processing')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');

  // Opacity is display-only and applies immediately (no server round-trip).
  await page.locator('#adjust-opacity').evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = '0.4';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#adjust-opacity')).toHaveValue('0.4');

  // Reset returns server-side params to defaults.
  await page.locator('#adjust-reset').click();
  await expect(page.locator('#adjust-processing')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#adjust-contrast')).toHaveValue('1');
});
