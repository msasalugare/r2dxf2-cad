import { expect, test } from '@playwright/test';
import { login } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('measures distance and angle and creates a persisted hatch polygon', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');

  await page.locator('#measure-btn').click();
  await expect(page.locator('#measure-panel')).toBeVisible();
  await page.mouse.click(500, 250);
  await page.mouse.click(650, 250);
  await expect(page.locator('html')).toHaveAttribute('data-measurements', '1');
  await expect(page.locator('#measure-panel')).toContainText(/D \d+\.\d{2} mm/);

  await page.locator('#measure-tool-angle').click();
  await page.mouse.click(500, 400);
  await page.mouse.click(650, 400);
  await page.mouse.click(650, 300);
  await expect(page.locator('html')).toHaveAttribute('data-measurements', '2');
  await expect(page.locator('#measure-panel')).toContainText('∠ 90.00°');

  await page.locator('#measure-tool-hatch').click();
  await page.locator('#measure-spacing').fill('3');
  await page.locator('#measure-hatch-angle').fill('45');
  await page.mouse.click(800, 250);
  await page.mouse.click(950, 250);
  await page.mouse.click(950, 400);
  await page.mouse.click(800, 400);
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-hatches', '1');
  await expect(page.locator('#measure-panel')).toContainText('▨ 45.0° · 3.00 mm');
});
