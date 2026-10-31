import { expect, test } from '@playwright/test';
import { canvasPoint, getSampleFit, login, samplePoint } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('fits a sketch to the raster via backend ridge + fitter', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');

  const fit = await getSampleFit(page);
  await page.locator('#sketch-btn').click();
  await expect(page.locator('#sketch-panel')).toBeVisible();

  // Draw a segment along the sample's horizontal centre line (raster y=600).
  const a = await samplePoint(page, fit, 300, 600);
  const b = await samplePoint(page, fit, 700, 600);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);

  await page.locator('#sketch-fit').click();
  await expect(page.locator('#sketch-result')).toContainText('RMS', { timeout: 15000 });
});

test('fits with a mask stroke (masked fit path)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');

  // Paint a small include mask stroke.
  await page.locator('#mask-btn').click();
  const maskA = await canvasPoint(page, 0.3, 0.55);
  const maskB = await canvasPoint(page, 0.55, 0.55);
  await page.mouse.move(maskA.x, maskA.y);
  await page.mouse.down();
  await page.mouse.move(maskB.x, maskB.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('html')).toHaveAttribute('data-mask-strokes', '1');

  // Draw a segment and fit (exercises fit_sketch_masked).
  await page.locator('#sketch-btn').click();
  const a = await canvasPoint(page, 0.3, 0.55);
  const b = await canvasPoint(page, 0.55, 0.55);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await page.locator('#sketch-fit').click();
  await expect(page.locator('#sketch-result')).toContainText('RMS', { timeout: 15000 });
});
