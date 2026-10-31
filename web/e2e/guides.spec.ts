import { expect, test } from '@playwright/test';
import { getSampleFit, login, samplePoint } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('creates guides from rulers and deletes a selected guide with Delete', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
  await expect(page.locator('html')).toHaveAttribute('data-rulers', 'true');

  const canvas = await page.locator('#viewer').boundingBox();
  if (!canvas) throw new Error('Viewer canvas is not visible');

  await page.mouse.move(canvas.x + 220, canvas.y + 8);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 220, canvas.y + 180, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('html')).toHaveAttribute('data-guides', '1');

  await page.mouse.move(canvas.x + 8, canvas.y + 180);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 400, canvas.y + 180, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('html')).toHaveAttribute('data-guides', '2');

  await page.locator('#sketch-btn').click();
  await expect(page.locator('#sketch-panel')).toBeVisible();
  await page.locator('#sketch-tool-select').click();
  const resized = await page.locator('#viewer').boundingBox();
  if (!resized) throw new Error('Viewer canvas is not visible after opening Sketch');
  await page.mouse.click(canvas.x + 400 + (resized.x - canvas.x), canvas.y + 300);
  await expect(page.locator('html')).toHaveAttribute('data-guide-selected', '2');

  await page.keyboard.press('Delete');
  await expect(page.locator('html')).toHaveAttribute('data-guides', '1');
  await expect(page.locator('html')).toHaveAttribute('data-guide-selected', '');
});

test('rulers keep millimetre units and recompute ticks after calibration', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
  const before = await page.locator('html').getAttribute('data-ruler-step-x');

  const fit = await getSampleFit(page);
  await page.locator('#calibrate-btn').click();
  const a = await samplePoint(page, fit, 300, 800);
  const b = await samplePoint(page, fit, 1100, 800);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await page.locator('.cal-length').first().fill('80');
  await page.locator('.cal-orientation').first().selectOption('horizontal');
  await page.locator('#cal-solve').click();
  await expect(page.locator('#cal-result')).toContainText('Razmera');
  await page.locator('#cal-apply').click();

  await expect(page.locator('html')).toHaveAttribute('data-ruler-units', 'mm');
  const afterText = await page.locator('html').getAttribute('data-ruler-step-x');
  expect(afterText).not.toBe(before);
  expect(Number(afterText)).toBeGreaterThan(0);
  expect(Number.isFinite(Number(afterText))).toBe(true);
});

test('guides remain selectable and removable after Part rotation', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
  await page.locator('#calibrate-btn').click();
  await page.locator('#cal-rot-input').fill('30');
  await page.locator('#cal-rot-input').press('Enter');
  await page.locator('#cal-close').click();

  const canvas = await page.locator('#viewer').boundingBox();
  if (!canvas) throw new Error('Viewer canvas is not visible');
  await page.mouse.move(canvas.x + 400, canvas.y + 8);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 400, canvas.y + 300, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('html')).toHaveAttribute('data-guides', '1');

  await page.locator('#sketch-btn').click();
  await page.locator('#sketch-tool-select').click();
  const resized = await page.locator('#viewer').boundingBox();
  if (!resized) throw new Error('Viewer canvas is not visible after opening Sketch');
  await page.mouse.click(resized.x + 400, resized.y + 300);
  await expect(page.locator('html')).toHaveAttribute('data-guide-selected', '1');
  await page.keyboard.press('Delete');
  await expect(page.locator('html')).toHaveAttribute('data-guides', '0');
  await expect(page.locator('html')).toHaveAttribute('data-guide-selected', '');
});
