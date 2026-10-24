// Viewer camera: an affine map from raster pixels to screen pixels.
//
// Everything is a JS `number` (IEEE 754 f64). The transform is:
//   screenX = worldX * zoom + x
//   screenY = worldY * zoom + y
// so `zoom` is screen pixels per raster pixel and (x, y) is the screen
// position of the raster origin.

export interface Camera {
  /** Screen pixels per raster pixel. */
  zoom: number;
  /** Screen x of the raster origin (0, 0). */
  x: number;
  /** Screen y of the raster origin (0, 0). */
  y: number;
}

export const MIN_ZOOM = 1e-4;
export const MAX_ZOOM = 64;

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** Zoom by `factor`, keeping the world point under (cx, cy) fixed. */
export function zoomAt(c: Camera, cx: number, cy: number, factor: number): Camera {
  const zoom = clampZoom(c.zoom * factor);
  const k = zoom / c.zoom;
  return { zoom, x: cx - (cx - c.x) * k, y: cy - (cy - c.y) * k };
}

export function panBy(c: Camera, dx: number, dy: number): Camera {
  return { zoom: c.zoom, x: c.x + dx, y: c.y + dy };
}

export function screenToWorld(c: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - c.x) / c.zoom, y: (sy - c.y) / c.zoom };
}

export function worldToScreen(c: Camera, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * c.zoom + c.x, y: wy * c.zoom + c.y };
}

/**
 * Fit a world rect into a viewport, centered with a small padding, without
 * going below the minimum zoom.
 */
export function fitCamera(
  viewportW: number,
  viewportH: number,
  worldW: number,
  worldH: number,
  padding = 24,
): Camera {
  const availableW = Math.max(1, viewportW - padding * 2);
  const availableH = Math.max(1, viewportH - padding * 2);
  const zoom = clampZoom(Math.min(availableW / worldW, availableH / worldH));
  return {
    zoom,
    x: (viewportW - worldW * zoom) / 2,
    y: (viewportH - worldH * zoom) / 2,
  };
}

/**
 * Choose the pyramid level whose pixels best match screen pixels at `zoom`.
 * Level L has scale 1/2^L, so its pixels are `zoom * 2^L` screen px wide; the
 * best level has that product closest to 1.
 */
export function bestLevel(zoom: number, maxLevel: number): number {
  if (zoom >= 1) return 0;
  const raw = Math.round(-Math.log2(zoom));
  return Math.min(maxLevel, Math.max(0, raw));
}
