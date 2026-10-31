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

export interface SampleFit {
  zoom: number;
  x: number;
  y: number;
}

export async function getSampleFit(page: Page): Promise<SampleFit> {
  return page.locator('#viewer').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const zoom = Math.min(rect.width / 1600, rect.height / 1200);
    return {
      zoom,
      x: (rect.width - 1600 * zoom) / 2,
      y: (rect.height - 1200 * zoom) / 2,
    };
  });
}

export async function samplePoint(
  page: Page,
  fit: SampleFit,
  u: number,
  v: number,
): Promise<{ x: number; y: number }> {
  const rect = await page.locator('#viewer').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y };
  });
  return {
    x: rect.x + fit.x + u * fit.zoom,
    y: rect.y + fit.y + v * fit.zoom,
  };
}

export async function canvasPoint(
  page: Page,
  fx: number,
  fy: number,
): Promise<{ x: number; y: number }> {
  const rect = await page.locator('#viewer').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  });
  return { x: rect.x + rect.width * fx, y: rect.y + rect.height * fy };
}
