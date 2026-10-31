import { beforeEach, describe, expect, it } from 'vitest';
import { GuideController } from './guide-ui';
import type { RasterViewer } from './viewer';
import { partToRasterPoint, rasterToPartPoint } from './coordinate-system';

function viewerMock(rotated = false): RasterViewer {
  const angle = rotated ? Math.PI / 4 : 0;
  const transform: [number, number, number, number, number, number] = [
    Math.cos(angle),
    Math.sin(angle),
    -Math.sin(angle),
    Math.cos(angle),
    0,
    0,
  ];
  const origin = { x: 0, y: 100 };
  const scale = { sx: 1, sy: 1 };
  return {
    rasterToScreen: (x: number, y: number) => ({
      x: 2 * (transform[0] * x + transform[2] * y) + 10,
      y: 2 * (transform[1] * x + transform[3] * y) + 20,
    }),
    rasterToPart: (x: number, y: number) => rasterToPartPoint({ x, y }, origin, scale, transform),
    partToRaster: (x: number, y: number) => partToRasterPoint({ x, y }, origin, scale, transform),
    requestRender: () => undefined,
  } as unknown as RasterViewer;
}

describe('GuideController.snapToGuide', () => {
  beforeEach(() => {
    Object.assign(globalThis, { document: { documentElement: { dataset: {} } } });
  });

  it('snaps a nearby point to vertical and horizontal guides', () => {
    const controller = new GuideController(viewerMock());
    controller.importState([
      { id: 1, kind: 'vertical', value: 50 },
      { id: 2, kind: 'horizontal', value: 30 },
    ]);

    expect(controller.snapToGuide({ x: 51, y: 40 }, 8).snapped).toBe(true);
    expect(controller.snapToGuide({ x: 20, y: 69 }, 8).snapped).toBe(true);
    expect(controller.snapToGuide({ x: 60, y: 40 }, 8).snapped).toBe(false);
  });

  it('returns the original point when no guide is near', () => {
    const controller = new GuideController(viewerMock());
    expect(controller.snapToGuide({ x: 1, y: 2 })).toEqual({ x: 1, y: 2, snapped: false });
  });

  it('uses perpendicular distance and preserves the other Part coordinate after rotation', () => {
    const viewer = viewerMock(true);
    const controller = new GuideController(viewer);
    controller.importState([{ id: 1, kind: 'vertical', value: 50 }]);
    const raster = viewer.partToRaster(51, 20)!;
    const snapped = controller.snapToGuide(raster, 3);
    expect(snapped.snapped).toBe(true);
    const part = viewer.rasterToPart(snapped.x, snapped.y);
    expect(part.x).toBeCloseTo(50);
    expect(part.y).toBeCloseTo(20);

    const far = viewer.partToRaster(60, 20)!;
    expect(controller.snapToGuide(far, 3).snapped).toBe(false);
  });
});
