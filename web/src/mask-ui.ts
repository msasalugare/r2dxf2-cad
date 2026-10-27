// Mask tool: paint include/exclude strokes (brush, rectangle, click-or-drag
// polygon, eraser) in raster coordinates, with Ramer–Douglas–Peucker
// simplification (tol 0.25 px), live cursor preview, undo/redo, and "Mask from sketch".

import { t, type Locale } from './i18n';
import type { SavedMaskStroke } from './project';
import type { RasterViewer } from './viewer';

export type MaskMode = 'include' | 'exclude';
export type MaskToolKind = 'brush' | 'rect' | 'polygon' | 'eraser';

export interface MaskStroke {
  mode: MaskMode;
  kind: 'brush' | 'polygon' | 'rect';
  radius: number;
  points: { x: number; y: number }[];
}

/** Ramer–Douglas–Peucker polyline simplification (`tol = 0.25 px`). */
function rdpSimplify(pts: { x: number; y: number }[], tol = 0.25): { x: number; y: number }[] {
  if (pts.length <= 2) return pts;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const len = Math.hypot(dx, dy);

  let maxDist = 0;
  let index = 0;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const p = pts[i];
    const d =
      len < 1e-9
        ? Math.hypot(p.x - first.x, p.y - first.y)
        : Math.abs(dy * p.x - dx * p.y + last.x * first.y - last.y * first.x) / len;
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > tol) {
    const left = rdpSimplify(pts.slice(0, index + 1), tol);
    const right = rdpSimplify(pts.slice(index), tol);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

export class MaskController {
  private strokes: MaskStroke[] = [];
  private redoStack: MaskStroke[] = [];
  private current: MaskStroke | null = null;
  private polyPoints: { x: number; y: number }[] = [];
  private lastMouse: { x: number; y: number } | null = null;
  private active = false;
  private mode: MaskMode = 'include';
  private tool: MaskToolKind = 'brush';
  private radius = 12;

  constructor(
    private viewer: RasterViewer,
    private panel: HTMLElement,
    private locale: Locale,
    private onStatus: (msg: string, isError?: boolean) => void,
    private getSketchSegments?: () => { ax: number; ay: number; bx: number; by: number }[],
    private onChange?: () => void,
  ) {}

  isActive(): boolean {
    return this.active;
  }

  getStrokes(): MaskStroke[] {
    return this.strokes;
  }

  setLastMouse(x: number, y: number): void {
    this.lastMouse = { x, y };
    if (this.active) {
      this.viewer.requestRender();
    }
  }

  finishPolygon(): boolean {
    if (this.polyPoints.length >= 3) {
      this.strokes.push({
        mode: this.mode,
        kind: 'polygon',
        radius: this.radius,
        points: [...this.polyPoints],
      });
      this.redoStack = [];
      this.polyPoints = [];
      document.documentElement.dataset.maskStrokes = String(this.strokes.length);
      this.render();
      this.viewer.requestRender();
      this.onChange?.();
      return true;
    }
    if (this.polyPoints.length > 0) {
      this.polyPoints = [];
      this.render();
      this.viewer.requestRender();
      return true;
    }
    return false;
  }

  exportState(): SavedMaskStroke[] {
    return this.strokes.map((s) => ({
      mode: s.mode,
      kind: s.kind,
      radius: s.radius,
      points: s.points.map((p) => ({ x: p.x, y: p.y })),
    }));
  }

  importState(strokes: SavedMaskStroke[]): void {
    this.strokes = strokes.map((s) => ({
      mode: s.mode,
      kind: s.kind ?? 'brush',
      radius: s.radius ?? 12,
      points: s.points.map((p) => ({ x: p.x, y: p.y })),
    }));
    this.redoStack = [];
    this.polyPoints = [];
    document.documentElement.dataset.maskStrokes = String(this.strokes.length);
    if (this.active) this.render();
    this.viewer.requestRender();
  }

  activate(): void {
    this.active = true;
    this.panel.hidden = false;
    this.onStatus(t(this.locale, 'mask.hint'));
    this.render();
    this.viewer.requestRender();
  }

  deactivate(): void {
    this.active = false;
    this.current = null;
    this.polyPoints = [];
    this.panel.hidden = true;
    this.viewer.requestRender();
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (e.key === 'Escape' || e.key === 'Enter') {
      if (this.finishPolygon()) return true;
    }
    if (e.key === 'x' || e.key === 'X') {
      this.mode = this.mode === 'include' ? 'exclude' : 'include';
      this.render();
      return true;
    }
    if (e.key === '[') {
      this.radius = Math.max(2, this.radius - 2);
      this.render();
      this.viewer.requestRender();
      return true;
    }
    if (e.key === ']') {
      this.radius = Math.min(80, this.radius + 2);
      this.render();
      this.viewer.requestRender();
      return true;
    }
    if (e.key === 'b' || e.key === 'B') {
      this.tool = 'brush';
      this.polyPoints = [];
      this.render();
      return true;
    }
    if (e.key === 'r' || e.key === 'R') {
      this.tool = 'rect';
      this.polyPoints = [];
      this.render();
      return true;
    }
    if (e.key === 'p' || e.key === 'P' || e.key === 'l' || e.key === 'L') {
      this.tool = 'polygon';
      this.polyPoints = [];
      this.render();
      return true;
    }
    if (e.key === 'e' || e.key === 'E') {
      this.tool = 'eraser';
      this.polyPoints = [];
      this.render();
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      if (e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    return false;
  }

  /** Handle vertex clicks when `polygon` tool is selected, or single-click dabs for brush/eraser. */
  handleClick(clientX: number, clientY: number): boolean {
    if (!this.active) return false;
    const r = this.viewer.clientToRaster(clientX, clientY);
    if (!r) return true;

    if (this.tool === 'brush' || this.tool === 'eraser') {
      const effectiveMode: MaskMode = this.tool === 'eraser' ? 'exclude' : this.mode;
      this.strokes.push({
        mode: effectiveMode,
        kind: 'brush',
        radius: this.radius,
        points: [{ x: r.x, y: r.y }],
      });
      this.redoStack = [];
      document.documentElement.dataset.maskStrokes = String(this.strokes.length);
      this.render();
      this.viewer.requestRender();
      this.onChange?.();
      return true;
    }

    if (this.tool !== 'polygon') return false;

    if (this.polyPoints.length >= 3) {
      const firstScreen = this.viewer.rasterToScreen(this.polyPoints[0].x, this.polyPoints[0].y);
      const curScreen = this.viewer.rasterToScreen(r.x, r.y);
      if (Math.hypot(curScreen.x - firstScreen.x, curScreen.y - firstScreen.y) <= 12) {
        this.finishPolygon();
        return true;
      }
    }
    const last = this.polyPoints[this.polyPoints.length - 1];
    if (last && Math.hypot(r.x - last.x, r.y - last.y) < 1.5) {
      return true;
    }
    this.polyPoints.push({ x: r.x, y: r.y });
    this.render();
    this.viewer.requestRender();
    return true;
  }

  /** Handle a pointer drag; returns true when consumed. */
  handleDrag(clientX: number, clientY: number, phase: 'start' | 'move' | 'end'): boolean {
    if (!this.active || this.tool === 'polygon') return false;
    const r = this.viewer.clientToRaster(clientX, clientY);
    if (!r) return true;

    const effectiveMode: MaskMode = this.tool === 'eraser' ? 'exclude' : this.mode;
    const effectiveKind: 'brush' | 'polygon' | 'rect' =
      this.tool === 'rect' ? 'rect' : 'brush';

    if (phase === 'start') {
      this.current = {
        mode: effectiveMode,
        kind: effectiveKind,
        radius: this.radius,
        points: [{ x: r.x, y: r.y }],
      };
    } else if (phase === 'move' && this.current) {
      if (this.current.kind === 'rect') {
        this.current.points = [this.current.points[0], { x: r.x, y: r.y }];
      } else {
        const last = this.current.points[this.current.points.length - 1];
        if (Math.hypot(last.x - r.x, last.y - r.y) > 1.0) {
          this.current.points.push({ x: r.x, y: r.y });
        }
      }
    } else if (phase === 'end' && this.current) {
      if (this.current.kind !== 'rect') {
        this.current.points = rdpSimplify(this.current.points, 0.25);
      }
      this.strokes.push(this.current);
      this.redoStack = [];
      this.current = null;
      this.render();
      document.documentElement.dataset.maskStrokes = String(this.strokes.length);
      this.onStatus(t(this.locale, 'status.ready'));
      this.onChange?.();
    }
    this.viewer.requestRender();
    return true;
  }

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (
      this.strokes.length === 0 &&
      !this.current &&
      this.polyPoints.length === 0 &&
      !this.active
    ) {
      return;
    }
    const m = this.viewer.getCombinedTransform();
    const to = this.viewer.rasterToScreen.bind(this.viewer);
    const include = getComputedStyle(this.panel).getPropertyValue('--color-success').trim() || '#067647';
    const exclude = getComputedStyle(this.panel).getPropertyValue('--color-danger').trim() || '#ac3540';
    const zoom = this.viewer.getEffectiveZoom();

    // Draw all mask strokes directly inside the exact raster-to-screen transform `m`
    // so the mask is 100% locked to the raster at any zoom, pan, or rotation.
    const drawInRasterSpace = (stroke: MaskStroke): void => {
      const color = stroke.mode === 'include' ? include : exclude;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.35;

      if (stroke.kind === 'rect' && stroke.points.length >= 2) {
        const a = stroke.points[0];
        const b = stroke.points[1];
        ctx.fillRect(
          Math.min(a.x, b.x),
          Math.min(a.y, b.y),
          Math.abs(b.x - a.x),
          Math.abs(b.y - a.y),
        );
      } else if (stroke.kind === 'polygon' && stroke.points.length >= 3) {
        ctx.beginPath();
        stroke.points.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
        ctx.fill();
      } else if (stroke.points.length === 1) {
        const p = stroke.points[0];
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1, stroke.radius), 0, Math.PI * 2);
        ctx.fill();
      } else if (stroke.points.length >= 2) {
        ctx.lineWidth = Math.max(2, stroke.radius * 2);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        stroke.points.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    ctx.save();
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    for (const s of this.strokes) drawInRasterSpace(s);
    if (this.current) drawInRasterSpace(this.current);
    ctx.restore();

    ctx.save();
    // Live polygon chain preview.
    if (this.polyPoints.length > 0) {
      const color = this.mode === 'include' ? include : exclude;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      this.polyPoints.forEach((p, i) => {
        const s = to(p.x, p.y);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      if (this.lastMouse) {
        ctx.lineTo(this.lastMouse.x, this.lastMouse.y);
      }
      ctx.stroke();
      for (const p of this.polyPoints) {
        const s = to(p.x, p.y);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Live brush circle cursor preview.
    if (
      this.active &&
      this.lastMouse &&
      (this.tool === 'brush' || this.tool === 'eraser')
    ) {
      ctx.strokeStyle = this.tool === 'eraser' || this.mode === 'exclude' ? exclude : include;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(this.lastMouse.x, this.lastMouse.y, Math.max(2, this.radius * zoom), 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  maskFromSketch(): void {
    const segs = this.getSketchSegments?.() ?? [];
    if (segs.length === 0) return;
    for (const seg of segs) {
      this.strokes.push({
        mode: 'include',
        kind: 'brush',
        radius: this.radius,
        points: [
          { x: seg.ax, y: seg.ay },
          { x: seg.bx, y: seg.by },
        ],
      });
    }
    this.redoStack = [];
    document.documentElement.dataset.maskStrokes = String(this.strokes.length);
    this.render();
    this.viewer.requestRender();
    this.onChange?.();
  }

  invert(): void {
    this.strokes = this.strokes.map((s) => ({
      ...s,
      mode: s.mode === 'include' ? 'exclude' : 'include',
    }));
    this.render();
    this.viewer.requestRender();
    this.onChange?.();
  }

  undo(): void {
    const popped = this.strokes.pop();
    if (popped) {
      this.redoStack.push(popped);
      document.documentElement.dataset.maskStrokes = String(this.strokes.length);
      this.render();
      this.viewer.requestRender();
      this.onChange?.();
    }
  }

  redo(): void {
    const popped = this.redoStack.pop();
    if (popped) {
      this.strokes.push(popped);
      document.documentElement.dataset.maskStrokes = String(this.strokes.length);
      this.render();
      this.viewer.requestRender();
      this.onChange?.();
    }
  }

  clear(): void {
    this.strokes = [];
    this.redoStack = [];
    this.current = null;
    this.polyPoints = [];
    document.documentElement.dataset.maskStrokes = '0';
    this.render();
    this.viewer.requestRender();
    this.onStatus(t(this.locale, 'status.ready'));
    this.onChange?.();
  }

  private render(): void {
    const locale = this.locale;
    this.panel.innerHTML = `
      <div class="panel-head">
        <h2 class="panel-title">${t(locale, 'mask.title')}</h2>
        <button id="mask-close" class="tool-btn" type="button" aria-label="${t(locale, 'calibrate.close')}">×</button>
      </div>
      <p class="cal-hint">${t(locale, this.polyPoints.length > 0 ? 'sketch.finishChain' : 'mask.hint')}</p>
      <div class="cal-actions">
        <button id="mask-include" class="btn ${this.mode === 'include' && this.tool !== 'eraser' ? 'btn-primary' : ''}" type="button">${t(locale, 'calibrate.include')}</button>
        <button id="mask-exclude" class="btn ${this.mode === 'exclude' && this.tool !== 'eraser' ? 'btn-primary' : ''}" type="button">${t(locale, 'mask.exclude')}</button>
        <button id="mask-clear" class="btn" type="button">${t(locale, 'sketch.clear')}</button>
      </div>
      <div class="cal-actions">
        <button id="mask-tool-brush" class="btn ${this.tool === 'brush' ? 'btn-primary' : ''}" type="button">${t(locale, 'mask.tool.brush')}</button>
        <button id="mask-tool-rect" class="btn ${this.tool === 'rect' ? 'btn-primary' : ''}" type="button">${t(locale, 'mask.tool.rect')}</button>
        <button id="mask-tool-poly" class="btn ${this.tool === 'polygon' ? 'btn-primary' : ''}" type="button">${t(locale, 'mask.tool.poly')}</button>
        <button id="mask-tool-eraser" class="btn ${this.tool === 'eraser' ? 'btn-primary' : ''}" type="button">${t(locale, 'mask.tool.eraser')}</button>
      </div>
      ${
        this.polyPoints.length >= 3
          ? `<div class="cal-actions"><button id="mask-finish-poly" class="btn btn-primary" type="button">${t(locale, 'sketch.finishChain')}</button></div>`
          : ''
      }
      <div class="cal-actions">
        <label class="cal-label" for="mask-radius-input">${t(locale, 'mask.radius')}: ${this.radius}</label>
        <input id="mask-radius-input" type="range" min="2" max="60" value="${this.radius}" class="flex-1" />
      </div>
      <div class="cal-actions">
        <button id="mask-from-sketch" class="btn" type="button">${t(locale, 'mask.fromSketch')}</button>
        <button id="mask-invert" class="btn" type="button">${t(locale, 'mask.invert')}</button>
        <button id="mask-undo" class="btn" type="button">${t(locale, 'mask.undo')}</button>
        <button id="mask-redo" class="btn" type="button">${t(locale, 'mask.redo')}</button>
      </div>
    `;

    this.panel.querySelector('#mask-close')!.addEventListener('click', () => this.deactivate());
    this.panel.querySelector('#mask-include')!.addEventListener('click', () => {
      this.mode = 'include';
      if (this.tool === 'eraser') this.tool = 'brush';
      this.render();
    });
    this.panel.querySelector('#mask-exclude')!.addEventListener('click', () => {
      this.mode = 'exclude';
      if (this.tool === 'eraser') this.tool = 'brush';
      this.render();
    });
    this.panel.querySelector('#mask-tool-brush')!.addEventListener('click', () => {
      this.tool = 'brush';
      this.polyPoints = [];
      this.render();
    });
    this.panel.querySelector('#mask-tool-rect')!.addEventListener('click', () => {
      this.tool = 'rect';
      this.polyPoints = [];
      this.render();
    });
    this.panel.querySelector('#mask-tool-poly')!.addEventListener('click', () => {
      this.tool = 'polygon';
      this.polyPoints = [];
      this.render();
    });
    this.panel.querySelector('#mask-tool-eraser')!.addEventListener('click', () => {
      this.tool = 'eraser';
      this.polyPoints = [];
      this.render();
    });
    this.panel.querySelector('#mask-finish-poly')?.addEventListener('click', () => {
      this.finishPolygon();
    });
    this.panel.querySelector<HTMLInputElement>('#mask-radius-input')!.addEventListener('input', (e) => {
      this.radius = Number((e.target as HTMLInputElement).value);
      this.render();
    });
    this.panel.querySelector('#mask-from-sketch')!.addEventListener('click', () => this.maskFromSketch());
    this.panel.querySelector('#mask-invert')!.addEventListener('click', () => this.invert());
    this.panel.querySelector('#mask-undo')!.addEventListener('click', () => this.undo());
    this.panel.querySelector('#mask-redo')!.addEventListener('click', () => this.redo());
    this.panel.querySelector('#mask-clear')!.addEventListener('click', () => this.clear());
  }
}
