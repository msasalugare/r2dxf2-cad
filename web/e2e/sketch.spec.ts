import { expect, test } from '@playwright/test';
import { canvasPoint, getSampleFit, login, samplePoint } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('draws a sketch and solves it via the backend solver', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');

  const fit = await getSampleFit(page);
  await page.locator('#sketch-btn').click();
  await expect(page.locator('#sketch-panel')).toBeVisible();

  // Two points on the canvas (same fit mapping as the calibration e2e):
  // a slightly tilted segment.
  const a = await samplePoint(page, fit, 300, 700);
  const b = await samplePoint(page, fit, 900, 720);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);

  await page.locator('#sketch-solve').click();
  await expect(page.locator('#sketch-result')).toContainText('Rešeno');

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
  await expect(page.locator('#sketch-result')).toContainText('Rešeno');
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
  const lineA = await canvasPoint(page, 0.25, 0.72);
  const lineB = await canvasPoint(page, 0.45, 0.72);
  await page.mouse.click(lineA.x, lineA.y);
  await page.mouse.click(lineB.x, lineB.y);

  // Cycle to tangent-arc mode: line -> perp -> tangent -> arc (3×M).
  await page.keyboard.press('m');
  await page.keyboard.press('m');
  await page.keyboard.press('m');
  await expect(page.locator('#status')).toContainText('tangenta');

  // Second endpoint, then the rim point (3-point definition).
  const end = await canvasPoint(page, 0.62, 0.52);
  const rim = await canvasPoint(page, 0.52, 0.42);
  await page.mouse.click(end.x, end.y);
  await expect(page.locator('#status')).toContainText('luku');
  await page.mouse.click(rim.x, rim.y);

  // The arc is created (not a guessed radius) and the chain continues.
  await expect(page.locator('#sketch-panel')).toContainText('Luk #');
  await page.keyboard.press('Escape');
});

test('mirrors selected geometry across a line axis', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
  await page.locator('#sketch-btn').click();
  await expect(page.locator('#sketch-panel')).toBeVisible();

  const canvas = await page.locator('#viewer').boundingBox();
  if (!canvas) throw new Error('Viewer canvas is not visible');
  const point = (fx: number, fy: number) => ({
    x: canvas.x + canvas.width * fx,
    y: canvas.y + canvas.height * fy,
  });
  const axisTop = point(0.5, 0.2);
  const axisBottom = point(0.5, 0.75);
  const shapeA = point(0.55, 0.28);
  const shapeB = point(0.65, 0.45);
  const shapeMid = point(0.6, 0.365);
  const axisMid = point(0.5, 0.5);

  // Vertical axis line, then a shape line.
  await page.locator('#sketch-tool-line').click();
  await page.mouse.click(axisTop.x, axisTop.y);
  await page.mouse.click(axisBottom.x, axisBottom.y);
  await page.mouse.click(shapeA.x, shapeA.y);
  await page.mouse.click(shapeB.x, shapeB.y);

  // Select the shape line (click to select), then mirror across the axis.
  await page.locator('#sketch-tool-select').click();
  await page.mouse.click(shapeMid.x, shapeMid.y);
  await expect(page.locator('#sketch-panel .cal-hint')).toContainText('Ln#');

  await page.locator('#sketch-tool-mirror').click();
  await page.mouse.click(axisMid.x, axisMid.y);

  // A mirrored copy is created.
  await expect(page.locator('#sketch-panel')).toContainText('Linija #3');
});

test('edits a dimension from its canvas badge and preserves geometry on conflict', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
  const fit = await page.locator('#viewer').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const zoom = Math.min(rect.width / 1600, rect.height / 1200);
    return {
      zoom,
      x: (rect.width - 1600 * zoom) / 2,
      y: (rect.height - 1200 * zoom) / 2,
    };
  });
  await page.locator('#sketch-btn').click();
  await expect(page.locator('#sketch-panel')).toBeVisible();

  const canvas = await page.locator('#viewer').boundingBox();
  if (!canvas) throw new Error('Viewer canvas is not visible');
  const toScreen = (u: number, v: number): { x: number; y: number } => ({
    x: canvas.x + fit.x + u * fit.zoom,
    y: canvas.y + fit.y + v * fit.zoom,
  });
  const a = toScreen(400, 700);
  const b = toScreen(500, 700);
  await page.locator('#sketch-tool-line').click();
  await page.keyboard.down('Alt');
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up('Alt');
  await page.locator('#sketch-tool-select').click();
  const midpoint = toScreen(450, 700);
  await page.mouse.click(midpoint.x, midpoint.y);
  await expect(page.locator('#sketch-panel .cal-hint')).toContainText('Ln#1');

  await page.locator('details[aria-label="Dimenziona ograničenja"] summary').click();
  const createdRequest = page.waitForRequest((req) => req.url().endsWith('/api/solve'));
  const createdResponse = page.waitForResponse((res) => res.url().endsWith('/api/solve'));
  await page.locator('[data-action="Distance"]').click();
  const createdPayload = (await createdRequest).postDataJSON();
  const [initialA, initialB] = createdPayload.points;
  const measured = Math.hypot(initialB.x - initialA.x, initialB.y - initialA.y);
  expect(createdPayload.constraints[0].LineLength[1]).toBeCloseTo(measured, 9);
  const created = await (await createdResponse).json();
  expect(created.converged).toBe(true);
  expect(Math.hypot(created.params[2] - created.params[0], created.params[3] - created.params[1])).toBeCloseTo(measured, 6);

  await page.mouse.click(midpoint.x, midpoint.y - 22);
  await expect(page.locator('#sketch-dimension-value')).toBeVisible();
  await page.locator('#sketch-dimension-value').fill('140');
  const editedResponse = page.waitForResponse((res) => res.url().endsWith('/api/solve'));
  await page.locator('#sketch-dimension-apply').click();
  const edited = await (await editedResponse).json();
  expect(edited.converged).toBe(true);
  expect(Math.hypot(edited.params[2] - edited.params[0], edited.params[3] - edited.params[1])).toBeCloseTo(140, 6);

  await page.locator('details[aria-label="Dimenziona ograničenja"] summary').click();
  await page.locator('#sketch-c-type').selectOption('LineLength');
  await page.locator('#sketch-c-e1').fill('1');
  await page.locator('#sketch-c-val').fill('200');
  const conflictResponse = page.waitForResponse((res) => res.url().endsWith('/api/solve'));
  await page.locator('#sketch-c-add').click();
  const conflict = await (await conflictResponse).json();
  expect(conflict.converged).toBe(false);
  await expect(page.locator('#sketch-remove-conflict')).toBeVisible();

  const solveRequest = page.waitForRequest((req) => req.url().endsWith('/api/solve'));
  await page.locator('#sketch-solve').click();
  const payload = (await solveRequest).postDataJSON();
  const [p1, p2] = payload.points;
  expect(Math.hypot(p2.x - p1.x, p2.y - p1.y)).toBeCloseTo(140, 6);
});
