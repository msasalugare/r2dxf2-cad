// Calibration solvers, mirrored from `rf-core::calibration` so the browser can
// solve calibration locally (a cheap closed-form least-squares that never needed
// the server-side compute).
//
// Numerics follow the Rust implementation exactly (IEEE 754 f64); the shared
// acceptance vectors in `calibration.test.ts` and the Rust `calibration` tests
// keep the two implementations in lockstep within the project's 1e-9 relative
// reproducibility tolerance.

export type SegmentOrientation =
  | { type: 'free' }
  | { type: 'horizontal' }
  | { type: 'vertical' }
  | { type: 'angle'; angle: number };

export interface CalibrationSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Known world length in millimetres (> 0). */
  length: number;
  orientation: SegmentOrientation;
}

export interface CalibrationPoint {
  rx: number;
  ry: number;
  wx: number;
  wy: number;
}

export interface SegmentResidual {
  predictedMm: number;
  residualMm: number;
  residualPct: number;
}

export type CalibrationWarning =
  | 'too-few-segments'
  | 'high-max-residual'
  | 'nearly-parallel'
  | 'short-segment';

const PI = Math.PI;
const FRAC_PI_2 = Math.PI / 2;

export function normalizeAngle(a: number): number {
  let out = a;
  while (out > PI) out -= 2 * PI;
  while (out <= -PI) out += 2 * PI;
  return out;
}

export function pixelLength(seg: CalibrationSegment): number {
  const dx = seg.bx - seg.ax;
  const dy = seg.by - seg.ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Angle of the raster vector, measured y-down: atan2(dv, du). */
export function rasterAngle(seg: CalibrationSegment): number {
  return Math.atan2(seg.by - seg.ay, seg.bx - seg.ax);
}

/** Known world orientation in radians, or null for a free segment. */
export function worldOrientation(seg: CalibrationSegment): number | null {
  switch (seg.orientation.type) {
    case 'free':
      return null;
    case 'horizontal':
      return 0;
    case 'vertical':
      return FRAC_PI_2;
    case 'angle':
      return seg.orientation.angle;
  }
}

/** Isotropic scale: Σ(d/L) / Σ(d²/L²). */
export function solveIsotropic(segments: CalibrationSegment[]): number | null {
  let num = 0;
  let den = 0;
  for (const seg of segments) {
    const d = pixelLength(seg);
    const l = seg.length;
    if (l <= 0 || d <= 0) continue;
    num += d / l;
    den += (d * d) / (l * l);
  }
  if (den <= 0) return null;
  return num / den;
}

/** Fold an angle into (-π/2, π/2] so undirected lines (A→B vs B→A) never flip 180°. */
export function foldHalfTurn(a: number): number {
  let out = normalizeAngle(a);
  if (out > FRAC_PI_2) out -= PI;
  if (out <= -FRAC_PI_2) out += PI;
  return out;
}

/** Rotation θ from H/V/angle segments (length-weighted circular mean). */
export function solveRotation(segments: CalibrationSegment[]): number | null {
  let sinSum = 0;
  let cosSum = 0;
  let weightSum = 0;
  for (const seg of segments) {
    const phi = worldOrientation(seg);
    if (phi === null) continue;
    const d = pixelLength(seg);
    if (d <= 0) continue;
    const rawTheta = phi + rasterAngle(seg);
    const thetaK =
      seg.orientation.type === 'horizontal' || seg.orientation.type === 'vertical'
        ? foldHalfTurn(rawTheta)
        : normalizeAngle(rawTheta);
    sinSum += d * Math.sin(thetaK);
    cosSum += d * Math.cos(thetaK);
    weightSum += d;
  }
  if (weightSum <= 0) return null;
  return normalizeAngle(Math.atan2(sinSum, cosSum));
}

/** Anisotropic scale (sx, sy) from ≥1 H and ≥1 V segment, given θ. */
export function solveAnisotropic(
  segments: CalibrationSegment[],
  theta: number,
): [number, number] | null {
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  let hasH = false;
  let hasV = false;

  let m00 = 0;
  let m01 = 0;
  let m11 = 0;
  let b0 = 0;
  let b1 = 0;

  for (const seg of segments) {
    const d = pixelLength(seg);
    if (d <= 0) continue;

    let du: number;
    let dv: number;
    let bx: number;
    let by: number;
    if (seg.orientation.type === 'horizontal') {
      [du, dv] = orient(seg, cosT, sinT);
      hasH = true;
      bx = seg.length;
      by = 0;
    } else if (seg.orientation.type === 'vertical') {
      [du, dv] = orient(seg, -sinT, -cosT);
      hasV = true;
      bx = 0;
      by = seg.length;
    } else {
      continue;
    }

    const r1x = cosT * du;
    const r1y = sinT * dv;
    const r2x = sinT * du;
    const r2y = -cosT * dv;

    m00 += r1x * r1x + r2x * r2x;
    m01 += r1x * r1y + r2x * r2y;
    m11 += r1y * r1y + r2y * r2y;
    b0 += r1x * bx + r2x * by;
    b1 += r1y * bx + r2y * by;
  }

  if (!hasH || !hasV) return null;

  const det = m00 * m11 - m01 * m01;
  if (Math.abs(det) <= Number.EPSILON || !Number.isFinite(det)) return null;
  const sx = (b0 * m11 - b1 * m01) / det;
  const sy = (m00 * b1 - m01 * b0) / det;
  if (sx <= 0 || sy <= 0 || !Number.isFinite(sx) || !Number.isFinite(sy)) return null;
  return [sx, sy];
}

function orient(seg: CalibrationSegment, dx: number, dy: number): [number, number] {
  let du = seg.bx - seg.ax;
  let dv = seg.by - seg.ay;
  if (du * dx + dv * dy < 0) {
    du = -du;
    dv = -dv;
  }
  return [du, dv];
}

/** Affine 2×3 least-squares fit; returns [a, b, c, d, tx, ty]. */
export function solveAffine(points: CalibrationPoint[]): [number, number, number, number, number, number] | null {
  if (points.length < 3) return null;
  const n = points.length;

  let u0 = 0;
  let v0 = 0;
  let x0 = 0;
  let y0 = 0;
  for (const p of points) {
    u0 += p.rx;
    v0 += p.ry;
    x0 += p.wx;
    y0 += p.wy;
  }
  u0 /= n;
  v0 /= n;
  x0 /= n;
  y0 /= n;

  let cuu = 0;
  let cuv = 0;
  let cvv = 0;
  let bxu = 0;
  let bxv = 0;
  let byu = 0;
  let byv = 0;
  for (const p of points) {
    const du = p.rx - u0;
    const dv = p.ry - v0;
    const dx = p.wx - x0;
    const dy = p.wy - y0;
    cuu += du * du;
    cuv += du * dv;
    cvv += dv * dv;
    bxu += dx * du;
    bxv += dx * dv;
    byu += dy * du;
    byv += dy * dv;
  }

  const detC = cuu * cvv - cuv * cuv;
  if (Math.abs(detC) <= Number.EPSILON || !Number.isFinite(detC)) return null;
  const a = (bxu * cvv - bxv * cuv) / detC;
  const c = (cuu * bxv - cuv * bxu) / detC;
  const b = (byu * cvv - byv * cuv) / detC;
  const d = (cuu * byv - cuv * byu) / detC;

  return [a, b, c, d, x0 - (a * u0 + c * v0), y0 - (b * u0 + d * v0)];
}

/** Apply an affine [a, b, c, d, tx, ty] to a raster point. */
export function applyAffine(
  t: [number, number, number, number, number, number],
  u: number,
  v: number,
): { x: number; y: number } {
  return { x: t[0] * u + t[2] * v + t[4], y: t[1] * u + t[3] * v + t[5] };
}

/** `R(θ)·diag(sx, −sy)` as an affine (no translation). */
export function rotationScaleMatrix(
  theta: number,
  sx: number,
  sy: number,
): [number, number, number, number, number, number] {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [sx * c, sx * s, sy * s, -sy * c, 0, 0];
}

export function segmentResiduals(
  segments: CalibrationSegment[],
  theta: number,
  sx: number,
  sy: number,
): SegmentResidual[] {
  const a = rotationScaleMatrix(theta, sx, sy);
  return segments.map((seg) => {
    const world = applyAffine(a, seg.bx - seg.ax, seg.by - seg.ay);
    const predicted = Math.sqrt(world.x * world.x + world.y * world.y);
    const residualMm = predicted - seg.length;
    return {
      predictedMm: predicted,
      residualMm,
      residualPct: seg.length !== 0 ? (residualMm / seg.length) * 100 : 0,
    };
  });
}

export function leaveOneOutIsotropic(segments: CalibrationSegment[]): number[] {
  return segments.map((_, i) => {
    const subset = segments.filter((_, j) => j !== i);
    return solveIsotropic(subset) ?? Number.NaN;
  });
}

function angularDistance(a: number, b: number): number {
  const d = ((a - b) % PI + PI) % PI;
  return Math.min(d, PI - d);
}

function maxAngularSpread(angles: number[]): number {
  let max = 0;
  for (let i = 0; i < angles.length; i += 1) {
    for (let j = i + 1; j < angles.length; j += 1) {
      max = Math.max(max, angularDistance(angles[i], angles[j]));
    }
  }
  return max;
}

export function isotropicWarnings(
  segments: CalibrationSegment[],
  residuals: SegmentResidual[],
  pageDiagonal: number,
): CalibrationWarning[] {
  const usable = segments.filter((s) => pixelLength(s) > 0 && s.length > 0).length;
  const warnings: CalibrationWarning[] = [];

  if (usable < 2) warnings.push('too-few-segments');

  const maxPct = residuals.reduce((m, r) => Math.max(m, Math.abs(r.residualPct)), 0);
  if (maxPct > 0.3) warnings.push('high-max-residual');

  const angles = segments
    .filter((s) => pixelLength(s) > 0 && s.length > 0)
    .map(rasterAngle);
  if (angles.length >= 2 && maxAngularSpread(angles) < (5 * Math.PI) / 180) {
    warnings.push('nearly-parallel');
  }

  if (
    pageDiagonal > 0 &&
    segments.some((s) => pixelLength(s) > 0 && pixelLength(s) < 0.3 * pageDiagonal)
  ) {
    warnings.push('short-segment');
  }

  return warnings;
}
