import { describe, expect, it } from 'vitest';
import { invertAffinePoint, niceRulerStep, rulerStepForRange, rulerStepForScale } from './guide-geometry';

describe('niceRulerStep', () => {
  it('uses 1/2/5 multiples for readable ruler ticks', () => {
    expect(niceRulerStep(0.08)).toBe(0.1);
    expect(niceRulerStep(1.2)).toBe(2);
    expect(niceRulerStep(3)).toBe(5);
    expect(niceRulerStep(8)).toBe(10);
    expect(niceRulerStep(80)).toBe(100);
  });

  it('falls back safely for invalid targets', () => {
    expect(niceRulerStep(0)).toBe(1);
    expect(niceRulerStep(Number.NaN)).toBe(1);
  });
});

describe('rulerStepForScale', () => {
  it('recomputes millimetre ticks after calibration', () => {
    const before = rulerStepForScale(0.5, 1);
    const after = rulerStepForScale(0.5, 0.1);
    expect(before).toBe(100);
    expect(after).toBe(1000);
    expect(after).toBeGreaterThan(before);
    expect(rulerStepForScale(0.5, 0)).toBe(50);
  });
});

describe('rulerStepForRange', () => {
  it('keeps at least four intervals visible after a large scale change', () => {
    expect(rulerStepForRange(500, 0, 650)).toBe(125);
    expect(rulerStepForRange(100, 0, 1800)).toBe(100);
  });
});

describe('invertAffinePoint', () => {
  it('round-trips rotation and translation', () => {
    const theta = Math.PI / 6;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const point = { x: 25, y: -10 };
    const transformed = {
      x: c * point.x - s * point.y + 40,
      y: s * point.x + c * point.y - 15,
    };
    const restored = invertAffinePoint([c, s, -s, c, 40, -15], transformed);
    expect(restored.x).toBeCloseTo(point.x);
    expect(restored.y).toBeCloseTo(point.y);
  });

  it('returns the original point for a singular transform', () => {
    expect(invertAffinePoint([0, 0, 0, 0, 0, 0], { x: 4, y: 7 })).toEqual({ x: 4, y: 7 });
  });
});
