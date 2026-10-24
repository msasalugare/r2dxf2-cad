import { expect, test } from '@playwright/test';

test('boots to the start screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('.start-card')).toBeVisible();
  await expect(page.locator('#open-btn')).toBeVisible();
  await expect(page.locator('#sample-btn')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');
});
