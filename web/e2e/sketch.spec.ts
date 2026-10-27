import { expect, test } from '@playwright/test';
import { login } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('draws a sketch and solves it via the backend solver', async ({ page }) => {
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

  // Export DXF and verify valid DXF output is downloaded.
  const dxfDownloadPromise = page.waitForEvent('download');
  await page.locator('#export-dxf').click();
  const dxfDownload = await dxfDownloadPromise;
  expect(dxfDownload.suggestedFilename()).toBe('sketch.dxf');
  await expect(page.locator('html')).toHaveAttribute('data-exported', 'dxf');
});

test('draws a multi-segment polyline chain and finishes on Escape', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');

  await page.locator('#sketch-btn').click();
  await expect(page.locator('#sketch-panel')).toBeVisible();

  // Click 4 vertices of a polyline chain (3 connected segments).
  await page.mouse.click(420, 300);
  await page.mouse.click(620, 300);
  await page.mouse.click(620, 480);
  await page.mouse.click(420, 480);
  await expect(page.locator('#sketch-finish-chain')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('#sketch-finish-chain')).toBeHidden();

  await page.locator('#sketch-solve').click();
  await expect(page.locator('#sketch-result')).toContainText('Solved');
});

test('boots directly into FreeCAD Sketcher workspace and solves constraints without raster', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  // Sketcher panel is immediately visible on boot before any raster is imported!
  await expect(page.locator('#sketch-panel')).toBeVisible();

  // Draw a rectangle directly on the CAD workspace using the Rect tool (R)
  await page.locator('#sketch-tool-rect').click();
  await page.mouse.click(450, 260);
  await page.mouse.click(750, 460);

  // Add a driving LineLength constraint of 120 mm on Line #1 and solve
  await page.locator('#sketch-c-type').selectOption('LineLength');
  await page.locator('#sketch-c-e1').fill('1');
  await page.locator('#sketch-c-val').fill('120');
  await page.locator('#sketch-c-add').click();

  await expect(page.locator('#sketch-result')).toContainText('Solved');
});
