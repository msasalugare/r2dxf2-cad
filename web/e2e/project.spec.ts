import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tinyPng = path.join(here, 'fixtures', 'tiny.png');

test('saves and opens a project zip', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(tinyPng);
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save-project').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('.rasterfit.zip');

  const savePath = testInfo.outputPath('project.rasterfit.zip');
  await download.saveAs(savePath);

  // Reload, then open the saved project.
  await page.reload();
  await page.locator('#project-input').setInputFiles(savePath);
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
});
