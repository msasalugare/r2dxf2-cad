import { expect, test } from '@playwright/test';
import { login } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('guide snapping pulls new geometry onto a guide and raster snap can be disabled', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
  const canvas = await page.locator('#viewer').boundingBox();
  if (!canvas) throw new Error('Viewer canvas is not visible');

  await page.mouse.move(canvas.x + 8, canvas.y + 180);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 400, canvas.y + 180, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('html')).toHaveAttribute('data-guides', '1');
  await page.mouse.move(canvas.x + 400, canvas.y + 300);
  const coords = await page.locator('#coords').textContent();
  const guideX = Number(coords?.match(/P x (-?\d+(?:\.\d+)?) mm/)?.[1]);
  expect(Number.isFinite(guideX)).toBe(true);

  await page.locator('#sketch-btn').click();
  await page.locator('#sketch-tool-line').click();
  const resized = await page.locator('#viewer').boundingBox();
  if (!resized) throw new Error('Viewer canvas is not visible');
  const guideScreenX = canvas.x + 400 + (resized.x - canvas.x);
  const start = { x: guideScreenX + 3, y: resized.y + 260 };
  const end = { x: guideScreenX + 120, y: resized.y + 360 };
  await page.mouse.click(start.x, start.y);
  await page.mouse.click(end.x, end.y);
  await page.locator('#sketch-tool-select').click();
  await page.mouse.click(guideScreenX + 60, resized.y + 310);
  const request = page.waitForRequest((req) => req.url().endsWith('/api/solve'));
  await page.locator('details[aria-label="Dimenziona ograničenja"] summary').click();
  await page.locator('[data-action="Distance"]').click();
  const payload = (await request).postDataJSON();
  expect(payload.points[0].x).toBeCloseTo(guideX, 1);

  await page.locator('#sketch-raster-snap').uncheck();
  await expect(page.locator('html')).toHaveAttribute('data-raster-snap', 'false');
  await page.locator('#sketch-raster-snap').check();
  await expect(page.locator('html')).toHaveAttribute('data-raster-snap', 'true');
});
