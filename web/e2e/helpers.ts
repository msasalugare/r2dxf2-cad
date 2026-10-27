import { expect, type Page } from '@playwright/test';

export const E2E_USERNAME = 'superadmin';
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? 'rasterfit-e2e';

/** Sign in as the superadmin so the server-only app allows import/compute. */
export async function login(page: Page): Promise<void> {
  const res = await page.request.post('/api/auth/login', {
    data: { username: E2E_USERNAME, password: E2E_PASSWORD },
  });
  expect(res.ok(), 'e2e login failed').toBeTruthy();
}
