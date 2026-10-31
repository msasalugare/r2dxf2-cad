import { expect, test, type Page } from '@playwright/test';
import { canvasPoint, login } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
});

async function openSampleSketch(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
  await page.locator('#sketch-btn').click();
  await expect(page.locator('#sketch-panel')).toBeVisible();
}

async function drawCorner(page: Page): Promise<void> {
  const first = await canvasPoint(page, 0.3, 0.7);
  const corner = await canvasPoint(page, 0.5, 0.7);
  const second = await canvasPoint(page, 0.5, 0.4);
  await page.locator('#sketch-tool-polyline').click();
  await page.mouse.click(first.x, first.y);
  await page.mouse.click(corner.x, corner.y);
  await page.mouse.click(second.x, second.y);
}

test('fillet keeps supporting lines fixed and creates a tangent arc with requested radius', async ({ page }) => {
  await openSampleSketch(page);
  await drawCorner(page);
  await page.locator('#sketch-tool-fillet').click();
  await page.locator('#sketch-fillet-radius').fill('10');
  const corner = await canvasPoint(page, 0.5, 0.7);
  const response = page.waitForResponse((res) => res.url().endsWith('/api/solve'));
  await page.mouse.click(corner.x, corner.y);
  const result = await (await response).json();

  expect(result.converged).toBe(true);
  const constraints = result.residuals;
  expect(constraints.length).toBeGreaterThan(0);
  const panelText = await page.locator('#sketch-panel').textContent();
  expect(panelText).toContain('ArcRadius');
  expect(panelText).toContain('TangentLineArc');
  expect(panelText).toContain('FixedPoint');
});

test('chamfer uses two distances and adds a straight connecting line', async ({ page }) => {
  await openSampleSketch(page);
  await drawCorner(page);
  await page.locator('#sketch-tool-chamfer').click();
  await page.locator('#sketch-chamfer-d1').fill('10');
  await page.locator('#sketch-chamfer-d2').fill('20');
  const corner = await canvasPoint(page, 0.5, 0.7);
  const request = page.waitForRequest((req) => req.url().endsWith('/api/solve'));
  const response = page.waitForResponse((res) => res.url().endsWith('/api/solve'));
  await page.mouse.click(corner.x, corner.y);
  const payload = (await request).postDataJSON();
  const result = await (await response).json();

  expect(result.converged).toBe(true);
  expect(payload.lines).toHaveLength(3);
  expect(payload.arcs).toHaveLength(0);
  expect(payload.constraints.filter((c: Record<string, unknown>) => 'FixedPoint' in c)).toHaveLength(3);
});

test('rounded rectangle creates four lines and four tangent arcs', async ({ page }) => {
  await openSampleSketch(page);
  await page.locator('#sketch-tool-rounded-rect').click();
  await page.locator('#sketch-rounded-radius').fill('10');
  const a = await canvasPoint(page, 0.35, 0.35);
  const b = await canvasPoint(page, 0.6, 0.65);
  const request = page.waitForRequest((req) => req.url().endsWith('/api/solve'));
  const response = page.waitForResponse((res) => res.url().endsWith('/api/solve'));
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  const payload = (await request).postDataJSON();
  const result = await (await response).json();

  expect(result.converged).toBe(true);
  expect(payload.lines).toHaveLength(4);
  expect(payload.arcs).toHaveLength(4);
  expect(payload.constraints.filter((c: Record<string, unknown>) => 'ArcRadius' in c)).toHaveLength(4);
  expect(payload.constraints.filter((c: Record<string, unknown>) => 'TangentLineArc' in c)).toHaveLength(8);
});
