// Canvas2D raster viewer: dot-grid background plus a tiled pyramid renderer
// with f64 pan/zoom (zoom-to-cursor), devicePixelRatio-aware, and 60 FPS via
// dirty-flag + requestAnimationFrame batching.
//
// Coordinate spaces:
// - raster `(u, v)`: image pixels (y-down).
// - world `(x, y)`: millimetres after calibration (y-up); equal to raster until
//   a calibration transform is applied.
// - screen: CSS pixels on the canvas.
//
// The raster is drawn through an affine `rasterTransform` (default identity)
// and then the pan/zoom camera.

import {
  bestLevel,
  fitCamera,
  panBy,
  screenToWorld,
  zoomAt,
  type Camera,
} from './camera';
import { TILE_SIZE, tileHeight, tileIndex, tileWidth, type RasterPage } from './raster';

const GRID_SPACING = 24; // CSS px, mirrors --geometry-viewer-grid-spacing
const DOT_RADIUS = 1;

/** Affine as Canvas 2D coefficients: `[a, b, c, d, e, f]`. */
export type Affine = [number, number, number, number, number, number];

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

export class RasterViewer {
  private camera: Camera = { zoom: 1, x: 0, y: 0 };
  private page: RasterPage | null = null;
  private rasterTransform: Affine = IDENTITY;
  private raf = 0;
  private dragPointer: number | null = null;
  private lastX = 0;
  private lastY = 0;

  /** Called after the camera changes (used to refresh the status bar). */
  onCameraChange: (() => void) | null = null;
  /** Called after the raster layer, in CSS-px space, for overlays. */
  onOverlay: ((ctx: CanvasRenderingContext2D, w: number, h: number) => void) | null = null;
  /** If set and returns true, a pointer press is consumed as a click (no pan). */
  onClick: ((clientX: number, clientY: number) => boolean) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('resize', this.scheduleRender);
    this.scheduleRender();
  }

  getCamera(): Camera {
    return this.camera;
  }

  getRasterTransform(): Affine {
    return [...this.rasterTransform] as Affine;
  }

  setRasterTransform(t: Affine): void {
    this.rasterTransform = [...t] as Affine;
    this.scheduleRender();
    this.onCameraChange?.();
  }

  resetRasterTransform(): void {
    this.rasterTransform = IDENTITY;
    this.scheduleRender();
    this.onCameraChange?.();
  }

  setPage(page: RasterPage | null): void {
    this.page = page;
    this.rasterTransform = IDENTITY;
    if (page) {
      this.camera = fitCamera(this.viewWidth(), this.viewHeight(), page.meta.width, page.meta.height);
    }
    this.scheduleRender();
    this.onCameraChange?.();
  }

  /** Zoom by `factor` around the canvas center. */
  zoomBy(factor: number): void {
    this.camera = zoomAt(this.camera, this.viewWidth() / 2, this.viewHeight() / 2, factor);
    this.scheduleRender();
    this.onCameraChange?.();
  }

  /** Fit the current page (in world space) into the viewport. */
  fit(): void {
    if (!this.page) return;
    const bounds = this.worldBounds();
    this.camera = fitCamera(this.viewWidth(), this.viewHeight(), bounds.width, bounds.height);
    this.scheduleRender();
    this.onCameraChange?.();
  }

  /** World coordinates (post-transform) under a client point. */
  clientToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return screenToWorld(this.camera, clientX - rect.left, clientY - rect.top);
  }

  /** Raster coordinates (pre-transform) under a client point, or null if singular. */
  clientToRaster(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    return this.screenToRaster(clientX - rect.left, clientY - rect.top);
  }

  /** Map a raster point to screen CSS coordinates. */
  rasterToScreen(rx: number, ry: number): { x: number; y: number } {
    const m = this.combined();
    return {
      x: m[0] * rx + m[2] * ry + m[4],
      y: m[1] * rx + m[3] * ry + m[5],
    };
  }

  destroy(): void {
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('resize', this.scheduleRender);
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  private viewWidth(): number {
    return this.canvas.clientWidth;
  }

  private viewHeight(): number {
    return this.canvas.clientHeight;
  }

  /** Combined raster→screen affine `[a, b, c, d, e, f]`. */
  private combined(): Affine {
    const t = this.rasterTransform;
    const z = this.camera.zoom;
    return [z * t[0], z * t[1], z * t[2], z * t[3], z * t[4] + this.camera.x, z * t[5] + this.camera.y];
  }

  private screenToRaster(sx: number, sy: number): { x: number; y: number } | null {
    const m = this.combined();
    const det = m[0] * m[3] - m[2] * m[1];
    if (Math.abs(det) < 1e-12) return null;
    const dx = sx - m[4];
    const dy = sy - m[5];
    return {
      x: (m[3] * dx - m[2] * dy) / det,
      y: (-m[1] * dx + m[0] * dy) / det,
    };
  }

  /** World-space bounding box of the raster (width/height in world units). */
  private worldBounds(): { width: number; height: number } {
    const page = this.page;
    if (!page) return { width: 1, height: 1 };
    const t = this.rasterTransform;
    const W = page.meta.width;
    const H = page.meta.height;
    const corners = [
      [0, 0],
      [W, 0],
      [W, H],
      [0, H],
    ] as const;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [u, v] of corners) {
      const x = t[0] * u + t[2] * v + t[4];
      const y = t[1] * u + t[3] * v + t[5];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return { width: maxX - minX, height: maxY - minY };
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const factor = Math.exp(-delta * 0.0015);
    this.camera = zoomAt(this.camera, cx, cy, factor);
    this.scheduleRender();
    this.onCameraChange?.();
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    if (this.onClick?.(e.clientX, e.clientY)) return;
    this.dragPointer = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.canvas.setPointerCapture(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.dragPointer !== e.pointerId) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.camera = panBy(this.camera, dx, dy);
    this.scheduleRender();
    this.onCameraChange?.();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.dragPointer !== e.pointerId) return;
    this.dragPointer = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // Pointer may already be released.
    }
  };

  private scheduleRender = (): void => {
    if (this.raf) return;
    this.raf = requestAnimationFrame(this.render);
  };

  private render = (): void => {
    this.raf = 0;
    const w = this.viewWidth();
    const h = this.viewHeight();
    if (w === 0 || h === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }

    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = cssVar(this.canvas, '--color-surface-viewer', '#eceef0');
    ctx.fillRect(0, 0, w, h);
    this.drawGrid(ctx, w, h);
    if (this.page) this.drawRaster(ctx, w, h);
    this.onOverlay?.(ctx, w, h);
  };

  private drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.fillStyle = cssVar(this.canvas, '--color-viewer-grid-dot', '#d3d7dc');
    for (let x = GRID_SPACING / 2; x < w; x += GRID_SPACING) {
      for (let y = GRID_SPACING / 2; y < h; y += GRID_SPACING) {
        ctx.beginPath();
        ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawRaster(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const page = this.page;
    if (!page) return;

    const m = this.combined();
    const det = m[0] * m[3] - m[2] * m[1];
    if (Math.abs(det) < 1e-12) return;

    // Choose the pyramid level so raster pixels ≈ screen pixels.
    const t = this.rasterTransform;
    const rasterZoom =
      this.camera.zoom * Math.max(Math.hypot(t[0], t[1]), Math.hypot(t[2], t[3]));
    const level = page.levels[bestLevel(rasterZoom, page.levels.length - 1)];

    // Raster-space bounding box of the visible screen rectangle.
    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    for (const [sx, sy] of [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ] as const) {
      const dx = sx - m[4];
      const dy = sy - m[5];
      const u = (m[3] * dx - m[2] * dy) / det;
      const v = (-m[1] * dx + m[0] * dy) / det;
      minU = Math.min(minU, u);
      minV = Math.min(minV, v);
      maxU = Math.max(maxU, u);
      maxV = Math.max(maxV, v);
    }
    minU = Math.max(0, minU);
    minV = Math.max(0, minV);
    maxU = Math.min(page.meta.width, maxU);
    maxV = Math.min(page.meta.height, maxV);
    if (maxU <= minU || maxV <= minV) return;

    const col0 = Math.floor(minU / TILE_SIZE);
    const row0 = Math.floor(minV / TILE_SIZE);
    const col1 = Math.min(level.tileCols - 1, Math.floor((maxU - 1) / TILE_SIZE));
    const row1 = Math.min(level.tileRows - 1, Math.floor((maxV - 1) / TILE_SIZE));

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);

    for (let row = row0; row <= row1; row += 1) {
      for (let col = col0; col <= col1; col += 1) {
        const tile = level.tiles[tileIndex(level, col, row)];
        if (!tile) continue;
        const tw = tileWidth(level, col);
        const th = tileHeight(level, row);
        ctx.drawImage(tile, col * TILE_SIZE, row * TILE_SIZE, tw, th);
      }
    }
    ctx.restore();
  }
}
