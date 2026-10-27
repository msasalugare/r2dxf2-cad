import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const tinyPng = path.join(here, 'fixtures', 'tiny.png');
const twoPagePdf = path.join(here, 'fixtures', 'two-page.pdf');

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('imports the bundled sample into the viewer', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.start-card')).toBeVisible();
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
  await expect(page.locator('.start-card')).toBeHidden();
  await expect(page.locator('.toolbar')).toBeVisible();
});

test('zoom controls change the reported zoom', async ({ page }) => {
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
  const before = await page.locator('#zoom').textContent();
  await page.locator('#zoom-in-btn').click();
  await expect(page.locator('#zoom')).not.toHaveText(before ?? '');
});

test('autosave offers Continue/Discard on reload after a file import', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(tinyPng);
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
  await expect(page.locator('html')).toHaveAttribute('data-autosaved', 'true');

  await page.reload();
  const prompt = page.locator('#autosave-prompt');
  await expect(prompt).toBeVisible();
  await page.locator('#discard-btn').click();
  await expect(prompt).toBeHidden();
});

test('imports a multi-page PDF and navigates between pages', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(twoPagePdf);
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
  await expect(page.locator('html')).toHaveAttribute('data-page-count', '2');
  await expect(page.locator('#status')).toContainText('Page 1/2');

  await page.locator('#next-btn').click();
  await expect(page.locator('#status')).toContainText('Page 2/2');
});
