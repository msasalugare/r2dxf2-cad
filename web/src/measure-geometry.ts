export interface MeasurePoint {
  x: number;
  y: number;
}

export interface MeasureSegment {
  a: MeasurePoint;
  b: MeasurePoint;
}

const MAX_HATCH_LINES = 2000;

export function measureDistance(a: MeasurePoint, b: MeasurePoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function measureAngle(a: MeasurePoint, vertex: MeasurePoint, b: MeasurePoint): number {
  const ax = a.x - vertex.x;
  const ay = a.y - vertex.y;
  const bx = b.x - vertex.x;
  const by = b.y - vertex.y;
  if (Math.hypot(ax, ay) < 1e-12 || Math.hypot(bx, by) < 1e-12) return 0;
  return Math.atan2(Math.abs(ax * by - ay * bx), ax * bx + ay * by);
}

export function polygonArea(points: MeasurePoint[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

export function buildHatchSegments(
  points: MeasurePoint[],
  spacing: number,
  angleDeg: number,
): MeasureSegment[] {
  if (
    points.length < 3 ||
    !Number.isFinite(spacing) ||
    spacing <= 0 ||
    !Number.isFinite(angleDeg) ||
    Math.abs(polygonArea(points)) < 1e-12
  ) {
    return [];
  }

  const theta = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const rotated = points.map((p) => ({ x: cos * p.x + sin * p.y, y: -sin * p.x + cos * p.y }));
  const ys = rotated.map((p) => p.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const segments: MeasureSegment[] = [];
  const firstY = Math.ceil(minY / spacing) * spacing;

  for (let y = firstY; y <= maxY && segments.length < MAX_HATCH_LINES; y += spacing) {
    const intersections: number[] = [];
    for (let i = 0; i < rotated.length; i += 1) {
      const a = rotated[i];
      const b = rotated[(i + 1) % rotated.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        intersections.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const x1 = intersections[i];
      const x2 = intersections[i + 1];
      if (x2 - x1 < 1e-9) continue;
      segments.push({
        a: { x: cos * x1 - sin * y, y: sin * x1 + cos * y },
        b: { x: cos * x2 - sin * y, y: sin * x2 + cos * y },
      });
    }
  }
  return segments;
}
