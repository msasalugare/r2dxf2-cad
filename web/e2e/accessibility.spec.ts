import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login } from './helpers';

function seriousViolations(results: Awaited<ReturnType<AxeBuilder['analyze']>>) {
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

test('signed-out auth screen has no serious axe violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#auth-screen input[name="username"]')).toBeVisible();
  expect(seriousViolations(await new AxeBuilder({ page }).analyze())).toEqual([]);
});

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('start screen has no serious axe violations', async ({ page }) => {
    await page.goto('/');
    expect(seriousViolations(await new AxeBuilder({ page }).analyze())).toEqual([]);
  });

  test('loaded viewer has no serious axe violations', async ({ page }) => {
    await page.goto('/');
    await page.locator('#sample-btn').click();
    await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
    expect(seriousViolations(await new AxeBuilder({ page }).analyze())).toEqual([]);
  });

  test('sketch panel has no serious axe violations', async ({ page }) => {
    await page.goto('/');
    await page.locator('#sample-btn').click();
    await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
    await page.locator('#sketch-btn').click();
    await expect(page.locator('#sketch-panel')).toBeVisible();
    expect(seriousViolations(await new AxeBuilder({ page }).analyze())).toEqual([]);
  });
});
