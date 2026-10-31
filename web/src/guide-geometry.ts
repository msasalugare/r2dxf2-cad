import type { Affine } from './viewer';

export interface GuidePoint {
  x: number;
  y: number;
}

export function niceRulerStep(target: number): number {
  if (!Number.isFinite(target) || target <= 0) return 1;
  const exponent = Math.floor(Math.log10(target));
  const magnitude = 10 ** exponent;
  const fraction = target / magnitude;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * magnitude;
}

export function rulerStepForScale(zoom: number, scale: number): number {
  const pixelsPerMm = zoom * scale;
  return niceRulerStep(40 / (pixelsPerMm > 1e-12 && Number.isFinite(pixelsPerMm) ? pixelsPerMm : 1));
}

export function rulerStepForRange(step: number, min: number, max: number): number {
  const span = Math.abs(max - min);
  let adjusted = step;
  while (span / adjusted < 4 && adjusted > 1e-9) adjusted /= 2;
  return adjusted;
}

export function invertAffinePoint(t: Affine, point: GuidePoint): GuidePoint {
  const determinant = t[0] * t[3] - t[2] * t[1];
  if (Math.abs(determinant) < 1e-12) return { ...point };
  const dx = point.x - t[4];
  const dy = point.y - t[5];
  return {
    x: (t[3] * dx - t[2] * dy) / determinant,
    y: (-t[1] * dx + t[0] * dy) / determinant,
  };
}
