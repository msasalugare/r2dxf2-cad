// Canvas2D raster viewer: dot-grid background plus a tiled pyramid renderer
// with f64 pan/zoom (zoom-to-cursor), devicePixelRatio-aware, and 60 FPS via
// dirty-flag + requestAnimationFrame batching.
//
// Coordinate spaces:
// - raster `(u, v)`: image pixels (y-down).
// - World `(x, y)`: calibrated millimetres around the fixed raster origin (y-up).
// - Part `(x, y)`: calibrated millimetres after levelling around the Part origin.
// - screen: CSS pixels on the canvas.
//
// The raster is drawn through an affine `rasterTransform` (default identity)
// and then the pan/zoom camera.

import {
  clampZoom,
  fitCamera,
  panBy,
  screenToWorld,
  zoomAt,
  type Camera,
} from './camera';
import { TILE_SIZE, tileHeight, tileIndex, tileWidth, type RasterPage } from './raster';
import {
  partToRasterPoint,
  rasterToPartPoint,
  rasterToWorldPoint,
  worldToRasterPoint,
} from './coordinate-system';

/** Affine as Canvas 2D coefficients: `[a, b, c, d, e, f]`. */
export type Affine = [number, number, number, number, number, number];

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

export interface RasterDisplayOptions {
  opacity: number;
  invert: boolean;
  contrast: number;
  visible?: boolean;
}

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

export class RasterViewer {
  private camera: Camera = { zoom: 1, x: 0, y: 0 };
  private page: RasterPage | null = null;
  private rasterTransform: Affine = IDENTITY;
  private worldScale: { sx: number; sy: number } = { sx: 1, sy: 1 };
  private displayOpts: RasterDisplayOptions = { opacity: 0.72, invert: false, contrast: 1, visible: true };
  private gridSnapEnabled = false;
  private gridStep = 10;
  private customOrigin: { x: number; y: number } | null = null;
  private raf = 0;
  private dragPointer: number | null = null;
  private dragHookActive = false;
  private panPointer: number | null = null;
  private downPos: { x: number; y: number; altKey: boolean; moved: boolean } | null = null;
  private lastX = 0;
  private lastY = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchStart: { dist: number; zoom: number; worldX: number; worldY: number } | null = null;

  /** Called after the camera changes (used to refresh the status bar). */
  onCameraChange: (() => void) | null = null;
  /** Called after the raster layer, in CSS-px space, for overlays. */
  onOverlay: ((ctx: CanvasRenderingContext2D, w: number, h: number) => void) | null = null;
  /** If set and returns true, a click (pointerdown+up within 5 px) is consumed. */
  onClick: ((clientX: number, clientY: number, altKey?: boolean) => boolean) | null = null;
  /** Called on double-click on the canvas (e.g. to finish a polyline/polygon). */
  onDoubleClick: ((clientX: number, clientY: number) => boolean) | null = null;
  /** Called on right-click on the canvas (e.g. to finish/cancel a pending chain). */
  onContextMenu: ((clientX: number, clientY: number) => boolean) | null = null;
  /** Called on pointer move over the canvas for live tool previews. */
  onPointerHover: ((clientX: number, clientY: number, altKey: boolean) => void) | null = null;
  /** If set and returns true on `start`, the drag is consumed as a tool stroke. */
  onDrag: ((clientX: number, clientY: number, phase: 'start' | 'move' | 'end') => boolean) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('dblclick', this.onDblClick);
    this.canvas.addEventListener('contextmenu', this.onCtxMenu);
    window.addEventListener('resize', this.scheduleRender);
    this.scheduleRender();
  }

  getCamera(): Camera {
    return this.camera;
  }

  getPage(): RasterPage | null {
    return this.page;
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
    this.worldScale = { sx: 1, sy: 1 };
    this.scheduleRender();
    this.onCameraChange?.();
  }

  getWorldScale(): { sx: number; sy: number } {
    return { ...this.worldScale };
  }

  setWorldScale(sx: number, sy: number): void {
    this.worldScale = { sx: sx > 0 ? sx : 1, sy: sy > 0 ? sy : 1 };
    this.onCameraChange?.();
  }

  getDisplayOptions(): RasterDisplayOptions {
    return { ...this.displayOpts };
  }

  setDisplayOptions(opts: Partial<RasterDisplayOptions>): void {
    this.displayOpts = { ...this.displayOpts, ...opts };
    this.scheduleRender();
  }

  isGridSnapEnabled(): boolean {
    return this.gridSnapEnabled;
  }

  setGridSnapEnabled(enabled: boolean): void {
    this.gridSnapEnabled = enabled;
    this.scheduleRender();
  }

  getGridStep(): number {
    return this.gridStep;
  }

  setGridStep(step: number): void {
    if (step > 0) {
      this.gridStep = step;
      this.scheduleRender();
    }
  }

  getWorldOrigin(): { x: number; y: number } {
    if (this.page) return { x: 0, y: this.page.meta.height };
    return { x: 80, y: Math.max(200, (this.viewHeight() || 720) - 80) };
  }

  /** Part origin in raw raster coordinates; World never uses this custom offset. */
  getOrigin(): { x: number; y: number } {
    return this.customOrigin ? { ...this.customOrigin } : this.getWorldOrigin();
  }

  /** Move only the Part coordinate system origin. */
  setOrigin(rx: number, ry: number): void {
    this.customOrigin = { x: rx, y: ry };
    this.scheduleRender();
    this.onCameraChange?.();
  }

  /** Reset only the Part coordinate system origin. */
  resetOrigin(): void {
    this.customOrigin = null;
    this.scheduleRender();
    this.onCameraChange?.();
  }

  /** Snap raw raster coordinates to the calibrated Part grid. */
  snapToGrid(x: number, y: number): { x: number; y: number } {
    if (!this.gridSnapEnabled) return { x, y };
    const part = this.rasterToPart(x, y);
    const snapped = this.partToRaster(
      Math.round(part.x / this.gridStep) * this.gridStep,
      Math.round(part.y / this.gridStep) * this.gridStep,
    );
    return snapped ?? { x, y };
  }

  /** Rotate and translate the background around the page center by `(dTheta, dx, dy)`. */
  applyFitDelta(dTheta: number, dx: number, dy: number): void {
    const t = this.rasterTransform;
    const c = Math.cos(-dTheta);
    const s = Math.sin(-dTheta);
    const next: Affine = [
      c * t[0] - s * t[1],
      s * t[0] + c * t[1],
      c * t[2] - s * t[3],
      s * t[2] + c * t[3],
      c * t[4] - s * t[5] - dx,
      s * t[4] + c * t[5] - dy,
    ];
    this.setRasterTransform(next);
  }

  setPage(page: RasterPage | null): void {
    this.page = page;
    this.rasterTransform = IDENTITY;
    this.customOrigin = null;
    if (page) {
      // Occupy 100% of the workspace on open (padding = 0).
      this.camera = fitCamera(this.viewWidth(), this.viewHeight(), page.meta.width, page.meta.height, 0);
    }
    this.scheduleRender();
    this.onCameraChange?.();
  }

  /** Swap the raster page in place (e.g. after server-side image adjustments),
   *  preserving camera, transform, and origin. */
  replacePage(page: RasterPage): void {
    this.page = page;
    this.scheduleRender();
  }

  /** Zoom by `factor` around the canvas center. */
  zoomBy(factor: number): void {
    this.camera = zoomAt(this.camera, this.viewWidth() / 2, this.viewHeight() / 2, factor);
    this.scheduleRender();
    this.onCameraChange?.();
  }

  /** Request a re-render on the next animation frame. */
  requestRender(): void {
    this.scheduleRender();
  }

  /** Fit the current page (in world space) into 100% of the viewport. */
  fit(): void {
    if (!this.page) {
      this.camera = { zoom: 1, x: 0, y: 0 };
      this.scheduleRender();
      this.onCameraChange?.();
      return;
    }
    const bounds = this.worldBounds();
    const cam = fitCamera(this.viewWidth(), this.viewHeight(), bounds.width, bounds.height, 0);
    this.camera = {
      zoom: cam.zoom,
      x: cam.x - bounds.minX * cam.zoom,
      y: cam.y - bounds.minY * cam.zoom,
    };
    this.scheduleRender();
    this.onCameraChange?.();
  }

  clientToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const raster = this.clientToRaster(clientX, clientY);
    if (raster) return this.rasterToWorld(raster.x, raster.y);
    const rect = this.canvas.getBoundingClientRect();
    const point = screenToWorld(this.camera, clientX - rect.left, clientY - rect.top);
    return this.rasterToWorld(point.x, point.y);
  }

  clientToPart(clientX: number, clientY: number): { x: number; y: number } {
    const raster = this.clientToRaster(clientX, clientY);
    if (raster) return this.rasterToPart(raster.x, raster.y);
    const rect = this.canvas.getBoundingClientRect();
    const point = screenToWorld(this.camera, clientX - rect.left, clientY - rect.top);
    return this.rasterToPart(point.x, point.y);
  }

  /** Calibrated World millimetres, independent of Part origin and levelling. */
  rasterToWorld(rx: number, ry: number): { x: number; y: number } {
    return rasterToWorldPoint({ x: rx, y: ry }, this.getWorldOrigin(), this.worldScale);
  }

  worldToRaster(wx: number, wy: number): { x: number; y: number } {
    return worldToRasterPoint({ x: wx, y: wy }, this.getWorldOrigin(), this.worldScale);
  }

  /** Calibrated and levelled Part millimetres around the custom Part origin. */
  rasterToPart(rx: number, ry: number): { x: number; y: number } {
    return rasterToPartPoint(
      { x: rx, y: ry },
      this.getOrigin(),
      this.worldScale,
      this.rasterTransform,
    );
  }

  partToRaster(px: number, py: number): { x: number; y: number } | null {
    return partToRasterPoint(
      { x: px, y: py },
      this.getOrigin(),
      this.worldScale,
      this.rasterTransform,
    );
  }

  /** Combined raster→screen affine `[a, b, c, d, e, f]`. */
  getCombinedTransform(): Affine {
    return this.combined();
  }

  /** Effective screen-pixels-per-raster-pixel zoom factor (including `rasterTransform`). */
  getEffectiveZoom(): number {
    const m = this.combined();
    return Math.hypot(m[0], m[1]) || this.camera.zoom;
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
    this.canvas.removeEventListener('dblclick', this.onDblClick);
    this.canvas.removeEventListener('contextmenu', this.onCtxMenu);
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

  screenToRaster(sx: number, sy: number): { x: number; y: number } | null {
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

  /** World-space bounding box of the raster (minX, minY, width, height in post-transform units). */
  private worldBounds(): { minX: number; minY: number; width: number; height: number } {
    const page = this.page;
    if (!page) return { minX: 0, minY: 0, width: 1, height: 1 };
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
    return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const factor = Math.exp(-delta * 0.0022);
    this.camera = zoomAt(this.camera, cx, cy, factor);
    this.scheduleRender();
    this.onCameraChange?.();
  };

  private onDblClick = (e: MouseEvent): void => {
    if (this.onDoubleClick?.(e.clientX, e.clientY)) {
      e.preventDefault();
    }
  };

  private onCtxMenu = (e: MouseEvent): void => {
    if (this.onContextMenu?.(e.clientX, e.clientY)) {
      e.preventDefault();
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.canvas.setPointerCapture(e.pointerId);

    // Middle button always pans, even while a tool is active.
    if (e.button === 1) {
      this.panPointer = e.pointerId;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.downPos = null;
      return;
    }
    if (e.button !== 0) return;

    // A second finger starts a pinch (zoom + pan).
    if (this.pointers.size >= 2) {
      this.downPos = null;
      this.startPinch();
      return;
    }

    if (this.onDrag?.(e.clientX, e.clientY, 'start')) {
      this.dragHookActive = true;
      this.dragPointer = e.pointerId;
      this.downPos = null;
      return;
    }
    this.panPointer = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.downPos = { x: e.clientX, y: e.clientY, altKey: e.altKey, moved: false };
  };

  private onPointerMove = (e: PointerEvent): void => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.onPointerHover?.(e.clientX, e.clientY, e.altKey);

    if (this.pinchStart && this.pointers.size >= 2) {
      this.updatePinch();
      return;
    }

    if (this.dragHookActive && this.dragPointer === e.pointerId) {
      const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
      if (coalesced.length > 0) {
        for (const ev of coalesced) {
          this.onDrag?.(ev.clientX, ev.clientY, 'move');
        }
      } else {
        this.onDrag?.(e.clientX, e.clientY, 'move');
      }
      return;
    }

    if (this.panPointer === e.pointerId) {
      if (this.downPos && !this.downPos.moved) {
        if (Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) > 5) {
          this.downPos.moved = true;
        } else {
          return;
        }
      }
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.camera = panBy(this.camera, dx, dy);
      this.scheduleRender();
      this.onCameraChange?.();
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);

    if (this.dragHookActive && this.dragPointer === e.pointerId) {
      this.onDrag?.(e.clientX, e.clientY, 'end');
      this.dragHookActive = false;
      this.dragPointer = null;
    }
    if (this.panPointer === e.pointerId) {
      this.panPointer = null;
      if (this.downPos && !this.downPos.moved && e.type === 'pointerup') {
        this.onClick?.(e.clientX, e.clientY, this.downPos.altKey);
      }
      this.downPos = null;
    }
    if (this.pointers.size < 2) {
      this.pinchStart = null;
    }
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // Pointer may already be released.
    }
  };

  private startPinch(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const a = pts[0];
    const b = pts[1];
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const world = screenToWorld(this.camera, cx, cy);
    this.pinchStart = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      zoom: this.camera.zoom,
      worldX: world.x,
      worldY: world.y,
    };
  }

  private updatePinch(): void {
    if (!this.pinchStart) return;
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const a = pts[0];
    const b = pts[1];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const zoom = clampZoom(this.pinchStart.zoom * (dist / this.pinchStart.dist));
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    // Keep the start world point under the current pinch centroid (zoom + pan).
    this.camera = { zoom, x: cx - this.pinchStart.worldX * zoom, y: cy - this.pinchStart.worldY * zoom };
    this.scheduleRender();
    this.onCameraChange?.();
  }

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
    if (this.page && this.displayOpts.visible !== false) this.drawRaster(ctx, w, h);
    if (!this.page || this.gridSnapEnabled) this.drawGrid(ctx, w, h);
    this.drawOriginAxes(ctx, w, h);
    this.onOverlay?.(ctx, w, h);
  };

  private drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const z = this.getEffectiveZoom();
    const orig = this.getOrigin();
    const origScreen = this.rasterToScreen(orig.x, orig.y);

    // Adaptive CAD grid spacing so grid lines are always ~20..100 CSS px apart
    const baseStep = (this.gridStep || 10) / (this.worldScale.sx || 1);
    let minorStepWorld = baseStep;
    while (minorStepWorld * z < 18) minorStepWorld *= 2;
    while (minorStepWorld * z > 90) minorStepWorld /= 2;
    const minorPx = minorStepWorld * z;
    const majorEvery = 5;

    ctx.save();
    const isDark = document.documentElement.dataset.theme === 'dark';
    const minorColor = isDark ? 'rgba(148, 163, 184, 0.12)' : 'rgba(100, 116, 139, 0.14)';
    const majorColor = isDark ? 'rgba(148, 163, 184, 0.26)' : 'rgba(100, 116, 139, 0.28)';

    // Vertical grid lines
    const startIdxX = Math.floor(-origScreen.x / minorPx);
    const endIdxX = Math.ceil((w - origScreen.x) / minorPx);
    for (let i = startIdxX; i <= endIdxX; i += 1) {
      if (i === 0) continue;
      const sx = origScreen.x + i * minorPx;
      ctx.strokeStyle = i % majorEvery === 0 ? majorColor : minorColor;
      ctx.lineWidth = i % majorEvery === 0 ? 1 : 0.75;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
      ctx.stroke();
    }

    // Horizontal grid lines
    const startIdxY = Math.floor(-origScreen.y / minorPx);
    const endIdxY = Math.ceil((h - origScreen.y) / minorPx);
    for (let j = startIdxY; j <= endIdxY; j += 1) {
      if (j === 0) continue;
      const sy = origScreen.y + j * minorPx;
      ctx.strokeStyle = j % majorEvery === 0 ? majorColor : minorColor;
      ctx.lineWidth = j % majorEvery === 0 ? 1 : 0.75;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawOriginAxes(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const orig = this.getOrigin();
    const origScreen = this.rasterToScreen(orig.x, orig.y);
    const uxX = 1;
    const uxY = 0;
    const lenX = 1;
    const uyX = 0;
    const uyY = -1;
    const lenY = 1;

    ctx.save();
    // Dashed full-canvas axis lines through (0, 0)
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(224, 49, 49, 0.55)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(origScreen.x - (uxX / lenX) * Math.max(w, h) * 2, origScreen.y - (uxY / lenX) * Math.max(w, h) * 2);
    ctx.lineTo(origScreen.x + (uxX / lenX) * Math.max(w, h) * 2, origScreen.y + (uxY / lenX) * Math.max(w, h) * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(47, 158, 68, 0.55)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(origScreen.x - (uyX / lenY) * Math.max(w, h) * 2, origScreen.y - (uyY / lenY) * Math.max(w, h) * 2);
    ctx.lineTo(origScreen.x + (uyX / lenY) * Math.max(w, h) * 2, origScreen.y + (uyY / lenY) * Math.max(w, h) * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Solid positive X (red) and Y (green) arrows at (0, 0)
    const arrowLen = 56;
    const xEnd = { x: origScreen.x + (uxX / lenX) * arrowLen, y: origScreen.y + (uxY / lenX) * arrowLen };
    const yEnd = { x: origScreen.x + (uyX / lenY) * arrowLen, y: origScreen.y + (uyY / lenY) * arrowLen };

    ctx.strokeStyle = '#e03131';
    ctx.lineWidth = 2.25;
    ctx.beginPath();
    ctx.moveTo(origScreen.x, origScreen.y);
    ctx.lineTo(xEnd.x, xEnd.y);
    ctx.stroke();

    ctx.strokeStyle = '#2f9e44';
    ctx.lineWidth = 2.25;
    ctx.beginPath();
    ctx.moveTo(origScreen.x, origScreen.y);
    ctx.lineTo(yEnd.x, yEnd.y);
    ctx.stroke();

    // Origin (0,0) bullseye & X/Y axis labels
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#e03131';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(origScreen.x, origScreen.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(origScreen.x, origScreen.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = '#e03131';
    ctx.fill();

    ctx.font = 'bold 11px Arial, sans-serif';
    ctx.fillStyle = '#e03131';
    ctx.fillText('+X', xEnd.x + 4, xEnd.y - 4);
    ctx.fillStyle = '#2f9e44';
    ctx.fillText('+Y', yEnd.x + 5, yEnd.y + 4);
    ctx.fillStyle = '#1e293b';
    ctx.fillText('(0,0)', origScreen.x + 8, origScreen.y + 14);

    ctx.restore();
  }

  private drawRaster(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const page = this.page;
    if (!page || page.levels.length === 0) return;

    const m = this.combined();
    const det = m[0] * m[3] - m[2] * m[1];
    if (Math.abs(det) < 1e-12) return;

    // Always draw from level 0 (exact 1:1 full-resolution raster coordinates)
    // so there is zero pyramid-level rounding or scale shift during zoom in/out.
    const level = page.levels[0];

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
    const col1 = Math.min(level.tileCols - 1, Math.floor(Math.max(0, maxU - 1e-6) / TILE_SIZE));
    const row1 = Math.min(level.tileRows - 1, Math.floor(Math.max(0, maxV - 1e-6) / TILE_SIZE));

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, this.displayOpts.opacity));
    const filters: string[] = [];
    if (this.displayOpts.invert) filters.push('invert(1)');
    if (Math.abs(this.displayOpts.contrast - 1) > 0.01) {
      filters.push(`contrast(${Math.round(this.displayOpts.contrast * 100)}%)`);
    }
    if (filters.length > 0) {
      ctx.filter = filters.join(' ');
    }
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
