import { expect, test } from '@playwright/test';
import { getSampleFit, login, samplePoint } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('calibration panel opens and reports the empty state', async ({ page }) => {
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');

  await page.locator('#calibrate-btn').click();
  await expect(page.locator('#calibration-panel')).toBeVisible();

  await page.locator('#cal-solve').click();
  await expect(page.locator('#status')).toContainText('Dodajte segmente');
});

test('places a segment and solves a calibration', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');

  const fit = await getSampleFit(page);
  await page.locator('#calibrate-btn').click();
  await expect(page.locator('#calibration-panel')).toBeVisible();

  // A horizontal segment in raster space, from (300, 800) to (1100, 800).
  const a = await samplePoint(page, fit, 300, 800);
  const b = await samplePoint(page, fit, 1100, 800);

  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);

  const lengthInput = page.locator('.cal-length').first();
  await lengthInput.fill('80');
  await page.locator('.cal-orientation').first().selectOption('horizontal');

  await page.locator('#cal-solve').click();
  await expect(page.locator('#cal-result')).toContainText('Rotacija');
  await expect(page.locator('#cal-result')).toContainText('Razmera');
});
