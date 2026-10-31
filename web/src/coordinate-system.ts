export interface CoordinatePoint {
  x: number;
  y: number;
}

export interface CoordinateScale {
  sx: number;
  sy: number;
}

export type CoordinateAffine = [number, number, number, number, number, number];

export function applyCoordinateTransform(
  transform: CoordinateAffine,
  point: CoordinatePoint,
): CoordinatePoint {
  return {
    x: transform[0] * point.x + transform[2] * point.y + transform[4],
    y: transform[1] * point.x + transform[3] * point.y + transform[5],
  };
}

export function invertCoordinateTransform(
  transform: CoordinateAffine,
  point: CoordinatePoint,
): CoordinatePoint | null {
  const determinant = transform[0] * transform[3] - transform[2] * transform[1];
  if (Math.abs(determinant) < 1e-12) return null;
  const dx = point.x - transform[4];
  const dy = point.y - transform[5];
  return {
    x: (transform[3] * dx - transform[2] * dy) / determinant,
    y: (-transform[1] * dx + transform[0] * dy) / determinant,
  };
}

export function rasterToWorldPoint(
  point: CoordinatePoint,
  origin: CoordinatePoint,
  scale: CoordinateScale,
): CoordinatePoint {
  return {
    x: (point.x - origin.x) * scale.sx,
    y: (origin.y - point.y) * scale.sy,
  };
}

export function worldToRasterPoint(
  point: CoordinatePoint,
  origin: CoordinatePoint,
  scale: CoordinateScale,
): CoordinatePoint {
  return {
    x: origin.x + point.x / (scale.sx || 1),
    y: origin.y - point.y / (scale.sy || 1),
  };
}

export function rasterToPartPoint(
  point: CoordinatePoint,
  origin: CoordinatePoint,
  scale: CoordinateScale,
  transform: CoordinateAffine,
): CoordinatePoint {
  return rasterToWorldPoint(
    applyCoordinateTransform(transform, point),
    applyCoordinateTransform(transform, origin),
    scale,
  );
}

export function partToRasterPoint(
  point: CoordinatePoint,
  origin: CoordinatePoint,
  scale: CoordinateScale,
  transform: CoordinateAffine,
): CoordinatePoint | null {
  const aligned = worldToRasterPoint(point, applyCoordinateTransform(transform, origin), scale);
  return invertCoordinateTransform(transform, aligned);
}
