// Pure geometry & selection helpers for the sketch editor.
// No DOM, no viewer, no controller state — safe to unit test in isolation.

export function toggleInArray(arr: number[], id: number): void {
  const idx = arr.indexOf(id);
  if (idx >= 0) arr.splice(idx, 1);
  else arr.push(id);
}

export function isAngleInArc(ang: number, start: number, end: number, tolRad = 0.2): boolean {
  const twoPi = Math.PI * 2;
  const sweep = ((end - start) % twoPi + twoPi) % twoPi || twoPi;
  const rel = ((ang - start) % twoPi + twoPi) % twoPi;
  return rel <= sweep + tolRad || rel >= twoPi - tolRad;
}

export function circumcircleArc(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
): { cx: number; cy: number; radius: number; startAngle: number; endAngle: number } | null {
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-5) return null;
  const s1 = x1 * x1 + y1 * y1;
  const s2 = x2 * x2 + y2 * y2;
  const s3 = x3 * x3 + y3 * y3;
  const cx = (s1 * (y2 - y3) + s2 * (y3 - y1) + s3 * (y1 - y2)) / d;
  const cy = (s1 * (x3 - x2) + s2 * (x1 - x3) + s3 * (x2 - x1)) / d;
  const radius = Math.hypot(x1 - cx, y1 - cy);
  if (!Number.isFinite(radius) || radius < 1 || radius > 1e6) return null;

  const twoPi = Math.PI * 2;
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  const a2 = Math.atan2(y2 - cy, x2 - cx);
  const a3 = Math.atan2(y3 - cy, x3 - cx);
  const sweep12 = ((a2 - a1) % twoPi + twoPi) % twoPi;
  const sweep13 = ((a3 - a1) % twoPi + twoPi) % twoPi;

  if (sweep13 <= sweep12) {
    return { cx, cy, radius, startAngle: a1, endAngle: a1 + sweep12 };
  }
  return { cx, cy, radius, startAngle: a2, endAngle: a2 + (twoPi - sweep12) };
}

export function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function projectPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { x: number; y: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return { x: ax, y: ay };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return { x: ax + t * dx, y: ay + t * dy };
}

/** Reflect a point across the line through `(ax, ay)` and `(bx, by)`. */
export function reflectPoint(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { x: number; y: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return { x: px, y: py };
  const t = ((px - ax) * dx + (py - ay) * dy) / len2;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { x: 2 * cx - px, y: 2 * cy - py };
}

export function segmentIntersectsRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  if (
    (ax >= minX && ax <= maxX && ay >= minY && ay <= maxY) ||
    (bx >= minX && bx <= maxX && by >= minY && by <= maxY)
  ) {
    return true;
  }
  return (
    segmentIntersectionT(ax, ay, bx, by, minX, minY, maxX, minY) !== null ||
    segmentIntersectionT(ax, ay, bx, by, maxX, minY, maxX, maxY) !== null ||
    segmentIntersectionT(ax, ay, bx, by, maxX, maxY, minX, maxY) !== null ||
    segmentIntersectionT(ax, ay, bx, by, minX, maxY, minX, minY) !== null
  );
}

export function segmentIntersectionT(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  x4: number,
  y4: number,
): number | null {
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return t;
  return null;
}
