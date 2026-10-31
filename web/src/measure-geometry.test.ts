import { describe, expect, it } from 'vitest';
import { buildHatchSegments, measureAngle, measureDistance, polygonArea } from './measure-geometry';

describe('measure geometry', () => {
  it('measures distance in world units', () => {
    expect(measureDistance({ x: 1, y: 2 }, { x: 4, y: 6 })).toBe(5);
  });

  it('measures the smaller angle at the vertex', () => {
    expect(measureAngle({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(Math.PI / 2);
    expect(measureAngle({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: -1, y: 1 })).toBeCloseTo((3 * Math.PI) / 4);
    expect(measureAngle({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBe(0);
  });
});

describe('hatch geometry', () => {
  const rectangle = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 20 },
    { x: 0, y: 20 },
  ];

  it('clips horizontal and vertical lines to the polygon', () => {
    const horizontal = buildHatchSegments(rectangle, 5, 0);
    expect(horizontal).toHaveLength(4);
    for (const segment of horizontal) {
      expect(segment.a.x).toBeCloseTo(0);
      expect(segment.b.x).toBeCloseTo(10);
      expect(segment.a.y).toBeCloseTo(segment.b.y);
    }

    const vertical = buildHatchSegments(rectangle, 5, 90);
    expect(vertical).toHaveLength(2);
    for (const segment of vertical) {
      expect(segment.a.y).toBeCloseTo(0);
      expect(segment.b.y).toBeCloseTo(20);
      expect(segment.a.x).toBeCloseTo(segment.b.x);
    }
  });

  it('generates rotated hatching inside the polygon', () => {
    const segments = buildHatchSegments(rectangle, 2, 45);
    expect(segments.length).toBeGreaterThan(5);
    for (const segment of segments) {
      const x = (segment.a.x + segment.b.x) / 2;
      const y = (segment.a.y + segment.b.y) / 2;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(10);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(20);
    }
  });

  it('rejects invalid polygons and spacing', () => {
    expect(buildHatchSegments(rectangle, 0, 45)).toEqual([]);
    expect(buildHatchSegments(rectangle, Number.NaN, 45)).toEqual([]);
    expect(buildHatchSegments([{ x: 0, y: 0 }, { x: 1, y: 1 }], 1, 45)).toEqual([]);
    expect(polygonArea(rectangle)).toBe(200);
  });
});
