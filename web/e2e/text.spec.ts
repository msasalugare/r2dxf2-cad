import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { login } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('places multiline text, exports it in Part DXF and restores it with the project', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');

  await page.locator('#text-btn').click();
  await expect(page.locator('#text-panel')).toBeVisible();
  await page.locator('#text-content').fill('Prvi red\nDrugi red');
  await page.locator('#text-height').fill('4');
  await page.locator('#text-height').press('Tab');
  await page.locator('#text-rotation').fill('15');
  await page.locator('#text-rotation').press('Tab');
  const canvas = await page.locator('#viewer').boundingBox();
  if (!canvas) throw new Error('Viewer canvas is not visible');
  await page.mouse.click(canvas.x + 400, canvas.y + 300);
  await expect(page.locator('html')).toHaveAttribute('data-texts', '1');
  await expect(page.locator('html')).toHaveAttribute('data-text-selected', '1');

  const dxfPromise = page.waitForEvent('download');
  await page.locator('#export-dxf-btn').click();
  const dxfDownload = await dxfPromise;
  const dxfPath = await dxfDownload.path();
  const dxf = await readFile(dxfPath!, 'utf8');
  expect(dxf).toContain('TEXT');
  expect(dxf).toContain('annotations');
  expect(dxf).toContain('Prvi red');
  expect(dxf).toContain('Drugi red');
  expect(dxf).toMatch(/40\n4(?:\.0+)?\n50\n-15(?:\.0+)?\n1\nPrvi red/);

  const projectPromise = page.waitForEvent('download');
  await page.locator('#save-project').click();
  const projectDownload = await projectPromise;
  const projectPath = testInfo.outputPath('text.rasterfit.zip');
  await projectDownload.saveAs(projectPath);
  await page.locator('#project-input').setInputFiles(projectPath);
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
  await expect(page.locator('html')).toHaveAttribute('data-texts', '1');

  await page.locator('#text-btn').click();
  const restoredCanvas = await page.locator('#viewer').boundingBox();
  if (!restoredCanvas) throw new Error('Viewer canvas is not visible');
  await page.mouse.click(restoredCanvas.x + 400, restoredCanvas.y + 300);
  await expect(page.locator('html')).toHaveAttribute('data-text-selected', '1');
  await expect(page.locator('#text-content')).toHaveValue('Prvi red\nDrugi red');
  await page.locator('#text-delete').click();
  await expect(page.locator('html')).toHaveAttribute('data-texts', '0');
});
