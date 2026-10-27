import { expect, test } from '@playwright/test';
import { login } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('paints a mask stroke via drag', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');

  await page.locator('#mask-btn').click();
  await expect(page.locator('#mask-panel')).toBeVisible();

  // Drag a short stroke on the canvas.
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(500, 320, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator('html')).toHaveAttribute('data-mask-strokes', '1');
});
