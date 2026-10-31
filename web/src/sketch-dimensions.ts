import type { SavedSketchData } from './project';

export type DimensionKey =
  | 'Distance'
  | 'DistancePointLine'
  | 'HorizontalDistance'
  | 'VerticalDistance'
  | 'LineLength'
  | 'Radius'
  | 'Diameter'
  | 'ArcRadius'
  | 'Angle'
  | 'AngleLine';

export interface DimensionScale {
  sx: number;
  sy: number;
}

const DIMENSION_KEYS = new Set<string>([
  'Distance',
  'DistancePointLine',
  'HorizontalDistance',
  'VerticalDistance',
  'LineLength',
  'Radius',
  'Diameter',
  'ArcRadius',
  'Angle',
  'AngleLine',
]);

export function isDimensionKey(key: string): key is DimensionKey {
  return DIMENSION_KEYS.has(key);
}

export function isAngleDimension(key: string): boolean {
  return key === 'Angle' || key === 'AngleLine';
}

export function isValidDimensionValue(key: string, value: number): boolean {
  return Number.isFinite(value) && (isAngleDimension(key) || value > 0);
}

export function dimensionValueToRaster(key: DimensionKey, value: number, scale: DimensionScale): number {
  if (isAngleDimension(key)) return (value * Math.PI) / 180;
  const unitScale = key === 'VerticalDistance' ? scale.sy : scale.sx;
  return value / (unitScale > 0 ? unitScale : 1);
}

export function dimensionValueFromRaster(key: DimensionKey, value: number, scale: DimensionScale): number {
  if (isAngleDimension(key)) return (value * 180) / Math.PI;
  const unitScale = key === 'VerticalDistance' ? scale.sy : scale.sx;
  return value * (unitScale > 0 ? unitScale : 1);
}

export function measureDimension(
  constraint: Record<string, unknown>,
  sketch: SavedSketchData,
  scale: DimensionScale,
): number | null {
  const key = Object.keys(constraint)[0];
  if (!isDimensionKey(key)) return null;
  const values = (constraint as Record<string, unknown>)[key];
  if (!Array.isArray(values)) return null;

  const point = (id: number) => sketch.points.find((p) => p.id === id);
  const line = (id: number) => sketch.lines.find((l) => l.id === id);
  const lineDirection = (id: number): { dx: number; dy: number } | null => {
    const entity = line(id);
    if (!entity) return null;
    const a = point(entity.a);
    const b = point(entity.b);
    return a && b ? { dx: b.x - a.x, dy: b.y - a.y } : null;
  };
  const frame = sketch.frame ?? [1, 0, 0, 1];
  const frameX = (dx: number, dy: number): number => frame[0] * dx + frame[2] * dy;
  const frameY = (dx: number, dy: number): number => frame[1] * dx + frame[3] * dy;
  const sx = scale.sx > 0 ? scale.sx : 1;
  const sy = scale.sy > 0 ? scale.sy : 1;

  if (key === 'Distance') {
    const a = point(values[0] as number);
    const b = point(values[1] as number);
    return a && b ? Math.hypot(b.x - a.x, b.y - a.y) * sx : null;
  }
  if (key === 'HorizontalDistance' || key === 'VerticalDistance') {
    const a = point(values[0] as number);
    const b = point(values[1] as number);
    if (!a || !b) return null;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return key === 'HorizontalDistance' ? Math.abs(frameX(dx, dy)) * sx : Math.abs(frameY(dx, dy)) * sy;
  }
  if (key === 'DistancePointLine') {
    const pt = point(values[0] as number);
    const direction = lineDirection(values[1] as number);
    const entity = line(values[1] as number);
    const a = entity ? point(entity.a) : undefined;
    if (!pt || !direction || !a) return null;
    const length = Math.hypot(direction.dx, direction.dy);
    if (length < 1e-12) return null;
    const cross = direction.dx * (pt.y - a.y) - direction.dy * (pt.x - a.x);
    return (Math.abs(cross) / length) * sx;
  }
  if (key === 'LineLength') {
    const direction = lineDirection(values[0] as number);
    return direction ? Math.hypot(direction.dx, direction.dy) * sx : null;
  }
  if (key === 'Radius' || key === 'Diameter') {
    const circle = sketch.circles.find((c) => c.id === values[0]);
    if (!circle) return null;
    return circle.radius * sx * (key === 'Diameter' ? 2 : 1);
  }
  if (key === 'ArcRadius') {
    const arc = sketch.arcs.find((a) => a.id === values[0]);
    return arc ? arc.radius * sx : null;
  }
  if (key === 'AngleLine') {
    const direction = lineDirection(values[0] as number);
    if (!direction || Math.hypot(direction.dx, direction.dy) < 1e-12) return null;
    return (Math.atan2(frameY(direction.dx, direction.dy), frameX(direction.dx, direction.dy)) * 180) / Math.PI;
  }

  const first = lineDirection(values[0] as number);
  const second = lineDirection(values[1] as number);
  if (!first || !second || Math.hypot(first.dx, first.dy) < 1e-12 || Math.hypot(second.dx, second.dy) < 1e-12) {
    return null;
  }
  const cross = first.dx * second.dy - first.dy * second.dx;
  const dot = first.dx * second.dx + first.dy * second.dy;
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}
