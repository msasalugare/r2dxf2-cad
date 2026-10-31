import { expect, test } from '@playwright/test';
import { login } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('CAD ribbon and left rail work with existing tools', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await expect(page.locator('.cad-ribbon-body')).toBeVisible();
  await expect(page.locator('#properties-panel')).toBeVisible();
  await expect(page.locator('.document-tabs')).toContainText('Drawing1');
  await expect(page.locator('.left-rail')).toBeVisible();
  await expect(page.locator('#properties-panel')).toContainText('Svojstva');
  await expect(page.locator('#properties-panel')).toContainText('Nema izbora');
  await expect(page.locator('[data-ribbon-group="draw"] .ribbon-label')).toHaveText('Crtanje');
  await expect(page.locator('#measure-btn')).toContainText('Merenje');
  const exportBox = await page.locator('#export-dxf-btn').boundingBox();
  const accountBox = await page.locator('#account-btn').boundingBox();
  const themeBox = await page.locator('#theme-btn').boundingBox();
  expect(exportBox).not.toBeNull();
  expect(accountBox).not.toBeNull();
  expect(themeBox).not.toBeNull();
  expect(exportBox!.height).toBeCloseTo(accountBox!.height, 3);
  expect(exportBox!.height).toBeCloseTo(themeBox!.height, 3);
  await expect(page.locator('.cad-ribbon-tabs')).toHaveCount(0);
  await expect(page.locator('.wcs-indicator')).toHaveCount(0);
  await expect(page.locator('.command-bar')).toHaveCount(0);
  await expect(page.locator('.layout-tabs')).toHaveCount(0);

  await page.locator('#properties-toggle').click();
  await expect(page.locator('#properties-panel')).toBeHidden();
  await expect(page.locator('#properties-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#properties-toggle').click();
  await expect(page.locator('#properties-panel')).toBeVisible();

  await page.locator('#measure-btn').click();
  await expect(page.locator('#measure-panel')).toBeVisible();
  await expect(page.locator('#properties-panel')).toBeHidden();
  await page.locator('#measure-tool-hatch').click();
  await expect(page.locator('#measure-tool-hatch')).toHaveClass(/btn-primary/);

  await page.locator('[data-sketch-tool="line"]').click();
  await expect(page.locator('#sketch-panel')).toBeVisible();
  await expect(page.locator('#sketch-tool-line')).toHaveClass(/btn-tool-active/);
});
