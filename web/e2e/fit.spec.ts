import { expect, test } from '@playwright/test';

test('fits a sketch to the raster via WASM ridge + fitter', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');

  await page.locator('#sketch-btn').click();
  await expect(page.locator('#sketch-panel')).toBeVisible();

  // Draw a segment along the sample's horizontal centre line (raster y=600).
  const toScreen = (u: number, v: number): { x: number; y: number } => ({
    x: u * 0.56 + 192,
    y: v * 0.56 + 24,
  });
  const a = toScreen(300, 600);
  const b = toScreen(700, 600);
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
  await page.mouse.move(360, 360);
  await page.mouse.down();
  await page.mouse.move(560, 360, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('html')).toHaveAttribute('data-mask-strokes', '1');

  // Draw a segment and fit (exercises fit_sketch_masked).
  await page.locator('#sketch-btn').click();
  await page.mouse.click(360, 360);
  await page.mouse.click(560, 360);
  await page.locator('#sketch-fit').click();
  await expect(page.locator('#sketch-result')).toContainText('RMS', { timeout: 15000 });
});
