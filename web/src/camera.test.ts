import { describe, expect, it } from 'vitest';
import { bestLevel, clampZoom, fitCamera, panBy, screenToWorld, worldToScreen, zoomAt } from './camera';

const EPS = 1e-9;

describe('zoomAt', () => {
  it('keeps the cursor world point fixed', () => {
    const cam = { zoom: 1, x: 0, y: 0 };
    const before = screenToWorld(cam, 200, 100);
    const next = zoomAt(cam, 200, 100, 2);
    const after = screenToWorld(next, 200, 100);
    expect(Math.abs(before.x - after.x)).toBeLessThan(EPS);
    expect(Math.abs(before.y - after.y)).toBeLessThan(EPS);
    expect(next.zoom).toBe(2);
  });

  it('clamps zoom to the allowed range', () => {
    expect(zoomAt({ zoom: 1, x: 0, y: 0 }, 0, 0, 1e6).zoom).toBeLessThanOrEqual(64);
    expect(zoomAt({ zoom: 1, x: 0, y: 0 }, 0, 0, 1e-9).zoom).toBeGreaterThanOrEqual(1e-4);
  });
});

describe('panBy', () => {
  it('translates the camera', () => {
    expect(panBy({ zoom: 2, x: 10, y: 20 }, 5, -3)).toEqual({ zoom: 2, x: 15, y: 17 });
  });
});

describe('screenToWorld / worldToScreen', () => {
  it('round-trips', () => {
    const cam = { zoom: 1.5, x: 30, y: -20 };
    const w = screenToWorld(cam, 100, 200);
    const s = worldToScreen(cam, w.x, w.y);
    expect(Math.abs(s.x - 100)).toBeLessThan(EPS);
    expect(Math.abs(s.y - 200)).toBeLessThan(EPS);
  });
});

describe('fitCamera', () => {
  it('centers and fits without distortion', () => {
    const cam = fitCamera(1000, 800, 2000, 1000, 24);
    // Both dimensions fit within the padded viewport.
    expect(cam.zoom * 2000).toBeLessThanOrEqual(1000 - 48);
    expect(cam.zoom * 1000).toBeLessThanOrEqual(800 - 48);
    // Centered horizontally.
    expect(cam.x).toBeCloseTo((1000 - 2000 * cam.zoom) / 2, 9);
  });
});

describe('bestLevel', () => {
  it('uses full resolution when zoomed in', () => {
    expect(bestLevel(2, 5)).toBe(0);
  });

  it('picks a coarser level when zoomed out', () => {
    expect(bestLevel(0.25, 5)).toBe(2);
    expect(bestLevel(0.1, 5)).toBe(3);
  });

  it('clamps to the deepest level', () => {
    expect(bestLevel(0.001, 3)).toBe(3);
  });
});

describe('clampZoom', () => {
  it('enforces bounds', () => {
    expect(clampZoom(1000)).toBe(64);
    expect(clampZoom(0)).toBe(1e-4);
    expect(clampZoom(1.5)).toBe(1.5);
  });
});
