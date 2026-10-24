// Canvas2D raster viewer: dot-grid background plus a tiled pyramid renderer
// with f64 pan/zoom (zoom-to-cursor), devicePixelRatio-aware, and 60 FPS via
// dirty-flag + requestAnimationFrame batching.

import {
  bestLevel,
  fitCamera,
  panBy,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Camera,
} from './camera';
import { TILE_SIZE, tileHeight, tileIndex, tileWidth, type RasterPage } from './raster';

const GRID_SPACING = 24; // CSS px, mirrors --geometry-viewer-grid-spacing
const DOT_RADIUS = 1;

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

export class RasterViewer {
  private camera: Camera = { zoom: 1, x: 0, y: 0 };
  private page: RasterPage | null = null;
  private raf = 0;
  private dragPointer: number | null = null;
  private lastX = 0;
  private lastY = 0;

  /** Called after the camera changes (used to refresh the status bar). */
  onCameraChange: (() => void) | null = null;

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

  setPage(page: RasterPage | null): void {
    this.page = page;
    if (page) this.camera = fitCamera(this.viewWidth(), this.viewHeight(), page.meta.width, page.meta.height);
    this.scheduleRender();
    this.onCameraChange?.();
  }

  /** Zoom by `factor` around the canvas center. */
  zoomBy(factor: number): void {
    this.camera = zoomAt(this.camera, this.viewWidth() / 2, this.viewHeight() / 2, factor);
    this.scheduleRender();
    this.onCameraChange?.();
  }

  /** Fit the current page into the viewport. */
  fit(): void {
    if (!this.page) return;
    this.camera = fitCamera(this.viewWidth(), this.viewHeight(), this.page.meta.width, this.page.meta.height);
    this.scheduleRender();
    this.onCameraChange?.();
  }

  /** World (raster px) coordinates under a client point. */
  clientToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return screenToWorld(this.camera, clientX - rect.left, clientY - rect.top);
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

    const level = page.levels[bestLevel(this.camera.zoom, page.levels.length - 1)];
    const scale = level.scale;

    const topLeft = screenToWorld(this.camera, 0, 0);
    const bottomRight = screenToWorld(this.camera, w, h);
    const lx0 = Math.min(topLeft.x, bottomRight.x) * scale;
    const ly0 = Math.min(topLeft.y, bottomRight.y) * scale;
    const lx1 = Math.max(topLeft.x, bottomRight.x) * scale;
    const ly1 = Math.max(topLeft.y, bottomRight.y) * scale;

    const col0 = Math.max(0, Math.floor(lx0 / TILE_SIZE));
    const row0 = Math.max(0, Math.floor(ly0 / TILE_SIZE));
    const col1 = Math.min(level.tileCols - 1, Math.floor((lx1 - 1) / TILE_SIZE));
    const row1 = Math.min(level.tileRows - 1, Math.floor((ly1 - 1) / TILE_SIZE));

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    for (let row = row0; row <= row1; row += 1) {
      for (let col = col0; col <= col1; col += 1) {
        const tile = level.tiles[tileIndex(level, col, row)];
        if (!tile) continue;
        const tw = tileWidth(level, col);
        const th = tileHeight(level, row);
        const origin = worldToScreen(this.camera, (col * TILE_SIZE) / scale, (row * TILE_SIZE) / scale);
        ctx.drawImage(tile, origin.x, origin.y, (tw / scale) * this.camera.zoom, (th / scale) * this.camera.zoom);
      }
    }
  }
}
