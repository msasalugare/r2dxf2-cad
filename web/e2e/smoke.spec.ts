import { expect, test } from '@playwright/test';
import { E2E_PASSWORD, E2E_USERNAME, login } from './helpers';

test('signed-out users see the auth screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#auth-screen')).toBeVisible();
  await expect(page.locator('#auth-screen input[name="username"]')).toBeVisible();
  await expect(page.locator('.start-card')).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-auth', 'signed-out');
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');
});

test('signs in from the auth screen', async ({ page }) => {
  await page.goto('/');
  await page.locator('#auth-screen input[name="username"]').fill(E2E_USERNAME);
  await page.locator('#auth-screen input[name="password"]').fill(E2E_PASSWORD);
  await page.locator('#auth-screen button[type="submit"]').click();
  await expect(page.locator('.start-card')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-auth', 'signed-in');
});

test('no Content-Security-Policy violations', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (text.includes('Content Security Policy') || text.includes('Refused to')) {
        violations.push(text);
      }
    }
  });
  await login(page);
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
  expect(violations).toEqual([]);
});

test('signed-in users boot to the start screen', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('.start-card')).toBeVisible();
  await expect(page.locator('#open-btn')).toBeVisible();
  await expect(page.locator('#sample-btn')).toBeVisible();
  await expect(page.locator('#auth-screen')).toBeHidden();
  // Empty state: no toolbar or tool panel is open yet.
  await expect(page.locator('.toolbar')).toBeHidden();
  await expect(page.locator('#sketch-panel')).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-booted', 'true');
});
