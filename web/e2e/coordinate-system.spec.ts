import { expect, test } from '@playwright/test';
import { login } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('Part origin and rotation do not change World coordinates', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  await page.locator('#sample-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-raster', 'loaded');
  const readCoordinates = async () => {
    const root = page.locator('html');
    const zoom = Number(await root.getAttribute('data-camera-zoom'));
    const cameraX = Number(await root.getAttribute('data-camera-x'));
    const cameraY = Number(await root.getAttribute('data-camera-y'));
    const transform = (await root.getAttribute('data-raster-transform'))!.split(',').map(Number);
    const canvas = await page.locator('#viewer').boundingBox();
    if (!canvas) throw new Error('Viewer canvas is not visible');
    const x = 900;
    const y = 550;
    const screenX = zoom * (transform[0] * x + transform[2] * y + transform[4]) + cameraX;
    const screenY = zoom * (transform[1] * x + transform[3] * y + transform[5]) + cameraY;
    await page.mouse.move(canvas.x + screenX, canvas.y + screenY);
    return {
      worldX: Number(await root.getAttribute('data-world-x')),
      worldY: Number(await root.getAttribute('data-world-y')),
      partX: Number(await root.getAttribute('data-part-x')),
      partY: Number(await root.getAttribute('data-part-y')),
    };
  };

  const before = await readCoordinates();
  await page.locator('#origin-tool-btn').click();
  await page.locator('#sketch-tool-origin').click();
  const canvas = await page.locator('#viewer').boundingBox();
  if (!canvas) throw new Error('Viewer canvas is not visible');
  await page.mouse.click(canvas.x + 520, canvas.y + 390);
  await page.locator('#sketch-close').click();

  const movedOrigin = await readCoordinates();
  expect(movedOrigin.worldX).toBeCloseTo(before.worldX, 8);
  expect(movedOrigin.worldY).toBeCloseTo(before.worldY, 8);
  expect(Math.hypot(movedOrigin.partX - before.partX, movedOrigin.partY - before.partY)).toBeGreaterThan(1);

  await page.locator('#calibrate-btn').click();
  await page.locator('#cal-rot-input').fill('30');
  await page.locator('#cal-rot-input').press('Enter');
  await page.locator('#cal-close').click();
  const rotated = await readCoordinates();
  expect(rotated.worldX).toBeCloseTo(before.worldX, 4);
  expect(rotated.worldY).toBeCloseTo(before.worldY, 4);
  expect(Math.hypot(rotated.partX - movedOrigin.partX, rotated.partY - movedOrigin.partY)).toBeGreaterThan(1);
});
