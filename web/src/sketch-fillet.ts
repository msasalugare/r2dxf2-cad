export interface FilletPoint {
  x: number;
  y: number;
}

export interface FilletGeometry {
  first: FilletPoint;
  second: FilletPoint;
  center: FilletPoint;
  start: number;
  end: number;
  startWithFirst: boolean;
}

function direction(corner: FilletPoint, other: FilletPoint): FilletPoint | null {
  const length = Math.hypot(other.x - corner.x, other.y - corner.y);
  if (length < 1e-9) return null;
  return { x: (other.x - corner.x) / length, y: (other.y - corner.y) / length };
}

export function cornerFilletGeometry(
  corner: FilletPoint,
  firstOther: FilletPoint,
  secondOther: FilletPoint,
  radius: number,
): FilletGeometry | null {
  if (!Number.isFinite(radius) || radius <= 0) return null;
  const u1 = direction(corner, firstOther);
  const u2 = direction(corner, secondOther);
  if (!u1 || !u2) return null;
  const dot = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
  const angle = Math.acos(dot);
  if (angle < 1e-6 || Math.PI - angle < 1e-6) return null;
  const half = angle / 2;
  const setback = radius / Math.tan(half);
  const centerDistance = radius / Math.sin(half);
  const bisectorLength = Math.hypot(u1.x + u2.x, u1.y + u2.y);
  if (bisectorLength < 1e-9) return null;
  const bx = (u1.x + u2.x) / bisectorLength;
  const by = (u1.y + u2.y) / bisectorLength;
  const first = { x: corner.x + u1.x * setback, y: corner.y + u1.y * setback };
  const second = { x: corner.x + u2.x * setback, y: corner.y + u2.y * setback };
  const center = { x: corner.x + bx * centerDistance, y: corner.y + by * centerDistance };
  const a1 = Math.atan2(first.y - center.y, first.x - center.x);
  const a2 = Math.atan2(second.y - center.y, second.x - center.x);
  const tau = Math.PI * 2;
  const sweep = ((a2 - a1) % tau + tau) % tau;
  return {
    first,
    second,
    center,
    start: sweep <= Math.PI ? a1 : a2,
    end: sweep <= Math.PI ? a1 + sweep : a2 + (tau - sweep),
    startWithFirst: sweep <= Math.PI,
  };
}

export function cornerChamferGeometry(
  corner: FilletPoint,
  firstOther: FilletPoint,
  secondOther: FilletPoint,
  firstDistance: number,
  secondDistance: number,
): { first: FilletPoint; second: FilletPoint } | null {
  const firstLength = Math.hypot(firstOther.x - corner.x, firstOther.y - corner.y);
  const secondLength = Math.hypot(secondOther.x - corner.x, secondOther.y - corner.y);
  if (
    firstLength < 1e-9 ||
    secondLength < 1e-9 ||
    !Number.isFinite(firstDistance) ||
    !Number.isFinite(secondDistance) ||
    firstDistance <= 0 ||
    secondDistance <= 0 ||
    firstDistance > firstLength ||
    secondDistance > secondLength
  ) {
    return null;
  }
  const u1 = direction(corner, firstOther)!;
  const u2 = direction(corner, secondOther)!;
  return {
    first: { x: corner.x + u1.x * firstDistance, y: corner.y + u1.y * firstDistance },
    second: { x: corner.x + u2.x * secondDistance, y: corner.y + u2.y * secondDistance },
  };
}
