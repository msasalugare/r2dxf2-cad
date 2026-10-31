import { describe, expect, it } from 'vitest';
import {
  applyCoordinateTransform,
  partToRasterPoint,
  rasterToPartPoint,
  rasterToWorldPoint,
  worldToRasterPoint,
} from './coordinate-system';

const origin = { x: 40, y: 180 };
const worldOrigin = { x: 0, y: 200 };
const rotation = Math.PI / 6;
const transform: [number, number, number, number, number, number] = [
  Math.cos(rotation),
  Math.sin(rotation),
  -Math.sin(rotation),
  Math.cos(rotation),
  12,
  -8,
];

describe('World and Part coordinate systems', () => {
  it('shares calibration scale but keeps World independent of Part origin and rotation', () => {
    const point = { x: 140, y: 80 };
    const before = rasterToWorldPoint(point, worldOrigin, { sx: 0.1, sy: 0.1 });
    const after = rasterToWorldPoint(point, worldOrigin, { sx: 0.25, sy: 0.25 });
    expect(before).toEqual({ x: 14, y: 12 });
    expect(after).toEqual({ x: 35, y: 30 });
    expect(rasterToWorldPoint(point, origin, { sx: 0.1, sy: 0.1 })).not.toEqual(before);

    const part = rasterToPartPoint(point, origin, { sx: 0.1, sy: 0.1 }, transform);
    const expected = rasterToWorldPoint(
      applyCoordinateTransform(transform, point),
      applyCoordinateTransform(transform, origin),
      { sx: 0.1, sy: 0.1 },
    );
    expect(part.x).toBeCloseTo(expected.x);
    expect(part.y).toBeCloseTo(expected.y);
  });

  it('round-trips Part coordinates through rotation, translation and scale', () => {
    const point = { x: 25, y: -40 };
    const raster = partToRasterPoint(point, origin, { sx: 0.2, sy: 0.25 }, transform);
    expect(raster).not.toBeNull();
    const restored = rasterToPartPoint(raster!, origin, { sx: 0.2, sy: 0.25 }, transform);
    expect(restored.x).toBeCloseTo(point.x);
    expect(restored.y).toBeCloseTo(point.y);
  });

  it('round-trips World coordinates independently', () => {
    const point = { x: 30, y: 50 };
    const raster = worldToRasterPoint(point, worldOrigin, { sx: 0.2, sy: 0.25 });
    expect(rasterToWorldPoint(raster, worldOrigin, { sx: 0.2, sy: 0.25 })).toEqual(point);
  });
});
