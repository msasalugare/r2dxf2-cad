// Pure constraint-graph helpers for the sketch editor.
// Constraints are FreeCAD-style single-key records, e.g. `{ Horizontal: lineId }`
// or `{ Distance: [ptA, ptB, value] }`.

export type ConstraintRecord = Record<string, unknown>;

/** Remove constraints whose referenced entities no longer exist. */
export function pruneOrphanConstraints(
  constraints: ConstraintRecord[],
  ptIds: Set<number>,
  lnIds: Set<number>,
  ciIds: Set<number>,
  arIds: Set<number>,
): ConstraintRecord[] {
  return constraints.filter((c) => {
    const k = Object.keys(c)[0];
    const v = c[k];
    switch (k) {
      case 'Horizontal':
      case 'Vertical':
        return lnIds.has(v as number);
      case 'LineLength':
      case 'AngleLine':
        return Array.isArray(v) && lnIds.has(v[0] as number);
      case 'Parallel':
      case 'Perpendicular':
      case 'EqualLength':
      case 'Collinear':
      case 'Angle':
        return Array.isArray(v) && lnIds.has(v[0] as number) && lnIds.has(v[1] as number);
      case 'Coincident':
      case 'HorizontalPoints':
      case 'VerticalPoints':
      case 'Distance':
      case 'HorizontalDistance':
      case 'VerticalDistance':
        return Array.isArray(v) && ptIds.has(v[0] as number) && ptIds.has(v[1] as number);
      case 'FixedPoint':
        return Array.isArray(v) && ptIds.has(v[0] as number);
      case 'PointOnLine':
      case 'Midpoint':
      case 'DistancePointLine':
        return Array.isArray(v) && ptIds.has(v[0] as number) && lnIds.has(v[1] as number);
      case 'PointOnCircle':
        return Array.isArray(v) && ptIds.has(v[0] as number) && ciIds.has(v[1] as number);
      case 'PointOnArc':
        return Array.isArray(v) && ptIds.has(v[0] as number) && arIds.has(v[1] as number);
      case 'Symmetric':
        return (
          Array.isArray(v) &&
          ptIds.has(v[0] as number) &&
          ptIds.has(v[1] as number) &&
          lnIds.has(v[2] as number)
        );
      case 'SymmetricPoints':
        return (
          Array.isArray(v) &&
          ptIds.has(v[0] as number) &&
          ptIds.has(v[1] as number) &&
          ptIds.has(v[2] as number)
        );
      case 'Radius':
      case 'Diameter':
        return Array.isArray(v) && ciIds.has(v[0] as number);
      case 'ArcRadius':
        return Array.isArray(v) && arIds.has(v[0] as number);
      case 'EqualRadius':
      case 'TangentCircleCircle':
        return Array.isArray(v) && ciIds.has(v[0] as number) && ciIds.has(v[1] as number);
      case 'EqualRadiusArc':
      case 'TangentArcArc':
        return Array.isArray(v) && arIds.has(v[0] as number) && arIds.has(v[1] as number);
      case 'EqualRadiusCircleArc':
        return Array.isArray(v) && ciIds.has(v[0] as number) && arIds.has(v[1] as number);
      case 'TangentLineCircle':
      case 'PerpendicularLineCircle':
        return Array.isArray(v) && lnIds.has(v[0] as number) && ciIds.has(v[1] as number);
      case 'TangentLineArc':
      case 'PerpendicularLineArc':
        return Array.isArray(v) && lnIds.has(v[0] as number) && arIds.has(v[1] as number);
      default:
        return true;
    }
  });
}

/** Return all point IDs connected to `ptId` via Coincident constraints (including `ptId` itself). */
export function getCoincidentCluster(constraints: ConstraintRecord[], ptId: number): number[] {
  const visited = new Set<number>([ptId]);
  const queue = [ptId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const c of constraints) {
      if ('Coincident' in c) {
        const [a, b] = (c as { Coincident: number[] }).Coincident;
        if (a === cur && !visited.has(b)) {
          visited.add(b);
          queue.push(b);
        } else if (b === cur && !visited.has(a)) {
          visited.add(a);
          queue.push(a);
        }
      }
    }
  }
  return [...visited];
}
