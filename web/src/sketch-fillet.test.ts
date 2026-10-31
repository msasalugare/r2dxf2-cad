import { describe, expect, it } from 'vitest';
import { cornerChamferGeometry, cornerFilletGeometry } from './sketch-fillet';

describe('cornerFilletGeometry', () => {
  it('computes a tangent arc for a right angle', () => {
    const result = cornerFilletGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }, 10)!;
    expect(result.first.x).toBeCloseTo(10);
    expect(result.first.y).toBeCloseTo(0);
    expect(result.second.x).toBeCloseTo(0);
    expect(result.second.y).toBeCloseTo(10);
    expect(result.center.x).toBeCloseTo(10);
    expect(result.center.y).toBeCloseTo(10);
    expect(Math.hypot(result.first.x - result.center.x, result.first.y - result.center.y)).toBeCloseTo(10);
    expect(Math.hypot(result.second.x - result.center.x, result.second.y - result.center.y)).toBeCloseTo(10);
    expect(result.end - result.start).toBeCloseTo(Math.PI / 2);
  });

  it('computes the correct center distance for an acute angle', () => {
    const result = cornerFilletGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 50 * Math.sqrt(3) }, 10)!;
    expect(result.first.x).toBeCloseTo(10 / Math.tan(Math.PI / 6));
    expect(result.first.y).toBeCloseTo(0);
    expect(result.center.x).toBeCloseTo(10 * Math.sqrt(3));
    expect(result.center.y).toBeCloseTo(10);
  });

  it('rejects degenerate geometry', () => {
    expect(cornerFilletGeometry({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, 10)).toBeNull();
    expect(cornerFilletGeometry({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, 0)).toBeNull();
  });
});

describe('cornerChamferGeometry', () => {
  it('uses two independent distances along the supporting lines', () => {
    const result = cornerChamferGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }, 10, 20)!;
    expect(result.first).toEqual({ x: 10, y: 0 });
    expect(result.second).toEqual({ x: 0, y: 20 });
  });

  it('rejects distances beyond line length or invalid values', () => {
    expect(cornerChamferGeometry({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 100 }, 10, 20)).toBeNull();
    expect(cornerChamferGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }, -1, 20)).toBeNull();
  });
});
