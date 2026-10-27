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

test('draws a tangent arc in a polyline via the 3-point rim method', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
  await page.locator('#sketch-btn').click();
  await expect(page.locator('#sketch-panel')).toBeVisible();

  await page.locator('#sketch-tool-polyline').click();
  // First line segment (two clicks).
  await page.mouse.click(300, 500);
  await page.mouse.click(500, 500);

  // Cycle to tangent-arc mode: line -> perp -> tangent -> arc (3×M).
  await page.keyboard.press('m');
  await page.keyboard.press('m');
  await page.keyboard.press('m');
  await expect(page.locator('#status')).toContainText('tangent');

  // Second endpoint, then the rim point (3-point definition).
  await page.mouse.click(650, 380);
  await expect(page.locator('#status')).toContainText('rim');
  await page.mouse.click(575, 320);

  // The arc is created (not a guessed radius) and the chain continues.
  await expect(page.locator('#sketch-panel')).toContainText('Arc #');
  await page.keyboard.press('Escape');
});

test('mirrors selected geometry across a line axis', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
  await page.locator('#sketch-btn').click();
  await expect(page.locator('#sketch-panel')).toBeVisible();

  // Vertical axis line, then a shape line.
  await page.locator('#sketch-tool-line').click();
  await page.mouse.click(640, 150);
  await page.mouse.click(640, 550); // axis
  await page.mouse.click(700, 200);
  await page.mouse.click(800, 300); // shape

  // Select the shape line (click to select), then mirror across the axis.
  await page.locator('#sketch-tool-select').click();
  await page.mouse.click(750, 250);
  await expect(page.locator('#sketch-panel .cal-hint')).toContainText('Ln#');

  await page.locator('#sketch-tool-mirror').click();
  await page.mouse.click(640, 350);

  // A mirrored copy is created.
  await expect(page.locator('#sketch-panel')).toContainText('Line #3');
});
