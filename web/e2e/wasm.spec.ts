import { expect, test } from '@playwright/test';

test('loads the Rust core via WASM', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-wasm', 'loaded');
  await expect(page.locator('html')).toHaveAttribute('data-core-version', '0.1.0');
});
