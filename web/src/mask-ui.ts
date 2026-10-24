// Mask tool: paint include/exclude brush strokes in raster coordinates, with a
// semi-transparent overlay. The strokes are the source of truth (the weight-map
// bitmap is derived later by `rf-core::mask` for the fitter).

import { t, type Locale } from './i18n';
import type { RasterViewer } from './viewer';

export type MaskMode = 'include' | 'exclude';

interface MaskStroke {
  mode: MaskMode;
  points: { x: number; y: number }[];
}

export class MaskController {
  private strokes: MaskStroke[] = [];
  private current: MaskStroke | null = null;
  private active = false;
  private mode: MaskMode = 'include';

  constructor(
    private viewer: RasterViewer,
    private panel: HTMLElement,
    private locale: Locale,
    private onStatus: (msg: string, isError?: boolean) => void,
  ) {}

  isActive(): boolean {
    return this.active;
  }

  getStrokes(): MaskStroke[] {
    return this.strokes;
  }

  activate(): void {
    this.active = true;
    this.panel.hidden = false;
    this.onStatus(t(this.locale, 'mask.hint'));
    this.render();
  }

  deactivate(): void {
    this.active = false;
    this.current = null;
    this.panel.hidden = true;
  }

  /** Handle a pointer drag; returns true when consumed. */
  handleDrag(clientX: number, clientY: number, phase: 'start' | 'move' | 'end'): boolean {
    if (!this.active) return false;
    const r = this.viewer.clientToRaster(clientX, clientY);
    if (!r) return true;

    if (phase === 'start') {
      this.current = { mode: this.mode, points: [{ x: r.x, y: r.y }] };
    } else if (phase === 'move' && this.current) {
      const last = this.current.points[this.current.points.length - 1];
      if (Math.hypot(last.x - r.x, last.y - r.y) > 1.5) {
        this.current.points.push({ x: r.x, y: r.y });
      }
    } else if (phase === 'end' && this.current) {
      this.strokes.push(this.current);
      this.current = null;
      this.render();
      document.documentElement.dataset.maskStrokes = String(this.strokes.length);
      this.onStatus(t(this.locale, 'status.ready'));
    }
    this.viewer.requestRender();
    return true;
  }

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (this.strokes.length === 0 && !this.current) return;
    const to = this.viewer.rasterToScreen.bind(this.viewer);
    const include = getComputedStyle(this.panel).getPropertyValue('--color-success').trim() || '#067647';
    const exclude = getComputedStyle(this.panel).getPropertyValue('--color-danger').trim() || '#ac3540';

    const draw = (stroke: MaskStroke): void => {
      ctx.strokeStyle = stroke.mode === 'include' ? include : exclude;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 12;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      stroke.points.forEach((p, i) => {
        const s = to(p.x, p.y);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    };

    ctx.save();
    for (const s of this.strokes) draw(s);
    if (this.current) draw(this.current);
    ctx.restore();
  }

  clear(): void {
    this.strokes = [];
    this.current = null;
    document.documentElement.dataset.maskStrokes = '0';
    this.render();
    this.onStatus(t(this.locale, 'status.ready'));
  }

  private render(): void {
    const locale = this.locale;
    this.panel.innerHTML = `
      <div class="panel-head">
        <h2 class="panel-title">${t(locale, 'mask.title')}</h2>
        <button id="mask-close" class="tool-btn" type="button" aria-label="${t(locale, 'calibrate.close')}">×</button>
      </div>
      <p class="cal-hint">${t(locale, 'mask.hint')}</p>
      <div class="cal-actions">
        <button id="mask-include" class="btn ${this.mode === 'include' ? 'btn-primary' : ''}" type="button">${t(locale, 'calibrate.include')}</button>
        <button id="mask-exclude" class="btn ${this.mode === 'exclude' ? 'btn-primary' : ''}" type="button">${t(locale, 'mask.exclude')}</button>
        <button id="mask-clear" class="btn" type="button">${t(locale, 'sketch.clear')}</button>
      </div>
    `;

    this.panel.querySelector('#mask-close')!.addEventListener('click', () => this.deactivate());
    this.panel.querySelector('#mask-include')!.addEventListener('click', () => {
      this.mode = 'include';
      this.render();
    });
    this.panel.querySelector('#mask-exclude')!.addEventListener('click', () => {
      this.mode = 'exclude';
      this.render();
    });
    this.panel.querySelector('#mask-clear')!.addEventListener('click', () => this.clear());
  }
}
