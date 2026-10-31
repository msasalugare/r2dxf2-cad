// Hit-testing of sketch entities in screen space.
// Pure functions over entity arrays + a small viewer-projection environment.

import type {
  SavedSketchArc,
  SavedSketchCircle,
  SavedSketchLine,
  SavedSketchPoint,
} from './project';
import { distToSegment, isAngleInArc } from './sketch-geometry';

export interface HitTestEnv {
  rasterToScreen: (rx: number, ry: number) => { x: number; y: number };
  getEffectiveZoom: () => number;
}

/** Find an existing sketch point within `tolScreenPx` CSS pixels on screen. */
export function findNearPoint(
  env: HitTestEnv,
  points: SavedSketchPoint[],
  rx: number,
  ry: number,
  tolScreenPx = 10,
): SavedSketchPoint | null {
  const targetScreen = env.rasterToScreen(rx, ry);
  let best: SavedSketchPoint | null = null;
  let bestDist = tolScreenPx;
  for (const p of points) {
    const s = env.rasterToScreen(p.x, p.y);
    const d = Math.hypot(s.x - targetScreen.x, s.y - targetScreen.y);
    if (d <= bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

/** Find a line segment near `(rx, ry)` within `tolScreenPx` CSS pixels. */
export function findNearLine(
  env: HitTestEnv,
  points: SavedSketchPoint[],
  lines: SavedSketchLine[],
  rx: number,
  ry: number,
  tolScreenPx = 8,
): SavedSketchLine | null {
  const pScreen = env.rasterToScreen(rx, ry);
  let best: SavedSketchLine | null = null;
  let bestDist = tolScreenPx;
  for (const l of lines) {
    const pa = points.find((p) => p.id === l.a);
    const pb = points.find((p) => p.id === l.b);
    if (!pa || !pb) continue;
    const a = env.rasterToScreen(pa.x, pa.y);
    const b = env.rasterToScreen(pb.x, pb.y);
    const d = distToSegment(pScreen.x, pScreen.y, a.x, a.y, b.x, b.y);
    if (d <= bestDist) {
      bestDist = d;
      best = l;
    }
  }
  return best;
}

/** Find a circle rim near `(rx, ry)` within `tolScreenPx` CSS pixels. */
export function findNearCircle(
  env: HitTestEnv,
  points: SavedSketchPoint[],
  circles: SavedSketchCircle[],
  rx: number,
  ry: number,
  tolScreenPx = 8,
): SavedSketchCircle | null {
  const pScreen = env.rasterToScreen(rx, ry);
  const zoom = env.getEffectiveZoom();
  let best: SavedSketchCircle | null = null;
  let bestDist = tolScreenPx;
  for (const c of circles) {
    const center = points.find((p) => p.id === c.center);
    if (!center) continue;
    const sc = env.rasterToScreen(center.x, center.y);
    const d = Math.abs(Math.hypot(pScreen.x - sc.x, pScreen.y - sc.y) - c.radius * zoom);
    if (d <= bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/** Find an arc near `(rx, ry)` within `tolScreenPx` CSS pixels. */
export function findNearArc(
  env: HitTestEnv,
  points: SavedSketchPoint[],
  arcs: SavedSketchArc[],
  rx: number,
  ry: number,
  tolScreenPx = 8,
): SavedSketchArc | null {
  const pScreen = env.rasterToScreen(rx, ry);
  const zoom = env.getEffectiveZoom();
  let best: SavedSketchArc | null = null;
  let bestDist = tolScreenPx;
  for (const a of arcs) {
    const center = points.find((p) => p.id === a.center);
    if (!center) continue;
    const sc = env.rasterToScreen(center.x, center.y);
    const d = Math.abs(Math.hypot(pScreen.x - sc.x, pScreen.y - sc.y) - a.radius * zoom);
    if (d <= bestDist && isAngleInArc(Math.atan2(ry - center.y, rx - center.x), a.start, a.end)) {
      bestDist = d;
      best = a;
    }
  }
  return best;
}
