import { expect, test } from '@playwright/test';

test('draws a sketch and solves it via WASM', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');

  await page.locator('#sketch-btn').click();
  await expect(page.locator('#sketch-panel')).toBeVisible();

  // Two points on the canvas (same fit mapping as the calibration e2e):
  // a slightly tilted segment.
  const toScreen = (u: number, v: number): { x: number; y: number } => ({
    x: u * 0.56 + 192,
    y: v * 0.56 + 24,
  });
  const a = toScreen(300, 700);
  const b = toScreen(900, 720);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);

  await page.locator('#sketch-solve').click();
  await expect(page.locator('#sketch-result')).toContainText('Solved');
});
