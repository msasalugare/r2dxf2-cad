import { describe, expect, it } from 'vitest';
import {
  rotationScaleMatrix,
  solveAffine,
  solveAnisotropic,
  solveIsotropic,
  solveRotation,
  isotropicWarnings,
  segmentResiduals,
  type CalibrationSegment,
  type SegmentOrientation,
} from './calibration';

const H: SegmentOrientation = { type: 'horizontal' };
const V: SegmentOrientation = { type: 'vertical' };
const FREE: SegmentOrientation = { type: 'free' };

function seg(ax: number, ay: number, bx: number, by: number, length: number, o: SegmentOrientation): CalibrationSegment {
  return { ax, ay, bx, by, length, orientation: o };
}

/** Build a raster segment from world endpoints by inverting R(θ)·diag(sx, −sy). */
function segFromWorld(
  w0: [number, number],
  w1: [number, number],
  theta: number,
  sx: number,
  sy: number,
): CalibrationSegment {
  const a = rotationScaleMatrix(theta, sx, sy);
  const [a00, a01, a10, a11] = [a[0], a[2], a[1], a[3]];
  const det = a00 * a11 - a01 * a10;
  const inv = [a11 / det, -a01 / det, -a10 / det, a00 / det];
  const toRaster = (w: [number, number]): [number, number] => [
    inv[0] * w[0] + inv[1] * w[1],
    inv[2] * w[0] + inv[3] * w[1],
  ];
  const [ax, ay] = toRaster(w0);
  const [bx, by] = toRaster(w1);
  const dx = w1[0] - w0[0];
  const dy = w1[1] - w0[1];
  return {
    ax,
    ay,
    bx,
    by,
    length: Math.sqrt(dx * dx + dy * dy),
    orientation: Math.abs(dx) > Math.abs(dy) ? H : V,
  };
}

describe('solveIsotropic', () => {
  it('recovers a known scale', () => {
    expect(solveIsotropic([seg(0, 0, 1000, 0, 100, FREE)])!).toBeCloseTo(0.1, 12);
  });

  it('matches the analytic weighted formula', () => {
    const a = seg(0, 0, 500, 0, 50, FREE);
    const b = seg(0, 0, 300, 0, 20, FREE);
    const expected = (500 / 50 + 300 / 20) / (500 ** 2 / 50 ** 2 + 300 ** 2 / 20 ** 2);
    expect(solveIsotropic([a, b])!).toBeCloseTo(expected, 12);
  });
});

describe('solveRotation', () => {
  it('recovers a small angle and ignores free segments', () => {
    const theta = (0.3 * Math.PI) / 180;
    const s = seg(0, 0, 1000 * Math.cos(theta), 1000 * Math.sin(theta), 100, H);
    const free = seg(0, 0, 500, 500, 70, FREE);
    expect(solveRotation([s, free])!).toBeCloseTo(theta, 12);
  });
});

describe('solveAnisotropic', () => {
  it('recovers sx and sy', () => {
    const theta = (0.5 * Math.PI) / 180;
    const sx = 0.1;
    const sy = 0.08;
    const h = segFromWorld([0, 0], [100, 0], theta, sx, sy);
    const v = segFromWorld([0, 0], [0, 50], theta, sx, sy);
    const thetaEst = solveRotation([h, v])!;
    const [sxEst, syEst] = solveAnisotropic([h, v], thetaEst)!;
    expect(sxEst).toBeCloseTo(sx, 4);
    expect(syEst).toBeCloseTo(sy, 4);
  });
});

describe('T1 acceptance', () => {
  it('three segments (H, V, diagonal) recover scale < 0.05 % and rotation < 0.02°', () => {
    const theta = (0.5 * Math.PI) / 180;
    const s = 0.1;
    const h = segFromWorld([0, 0], [100, 0], theta, s, s);
    const v = segFromWorld([0, 0], [0, 80], theta, s, s);
    const diag = { ...segFromWorld([0, 0], [60, 60], theta, s, s), orientation: FREE };

    const scale = solveIsotropic([h, v, diag])!;
    expect(Math.abs(scale - s) / s).toBeLessThan(5e-4);

    const thetaEst = solveRotation([h, v, diag])!;
    expect(Math.abs(thetaEst - theta)).toBeLessThan((0.02 * Math.PI) / 180);

    const [sx, sy] = solveAnisotropic([h, v, diag], thetaEst)!;
    expect(Math.abs(sx - s) / s).toBeLessThan(5e-4);
    expect(Math.abs(sy - s) / s).toBeLessThan(5e-4);
  });
});

describe('solveAffine', () => {
  it('recovers an exact transform and rejects collinear points', () => {
    const t: [number, number, number, number, number, number] = [2, 0.5, -0.3, 3, 10, -7];
    const raster = [
      [0, 0],
      [1, 0],
      [0, 1],
      [2, 3],
    ] as const;
    const points = raster.map(([rx, ry]) => {
      const w = {
        x: t[0] * rx + t[2] * ry + t[4],
        y: t[1] * rx + t[3] * ry + t[5],
      };
      return { rx, ry, wx: w.x, wy: w.y };
    });
    const recovered = solveAffine(points)!;
    for (let i = 0; i < 6; i += 1) {
      expect(recovered[i]).toBeCloseTo(t[i], 9);
    }

    const collinear = [
      { rx: 0, ry: 0, wx: 0, wy: 0 },
      { rx: 1, ry: 1, wx: 2, wy: 2 },
      { rx: 2, ry: 2, wx: 4, wy: 4 },
    ];
    expect(solveAffine(collinear)).toBeNull();
  });
});

describe('isotropicWarnings', () => {
  it('flags too-few and short segments', () => {
    const onlyOne = [seg(0, 0, 100, 0, 10, FREE)];
    const residuals = segmentResiduals(onlyOne, 0, 0.1, 0.1);
    const warnings = isotropicWarnings(onlyOne, residuals, 1000);
    expect(warnings).toContain('too-few-segments');
    expect(warnings).toContain('short-segment');
  });
});

// Parity note: the exact values asserted above (0.1 mm/px, 0.5° rotation,
// isotropic sx=sy=0.1) are the same ground-truth constants the Rust
// `rf-core::calibration` tests recover, keeping the two implementations in
// lockstep within the project's reproducibility tolerance.
