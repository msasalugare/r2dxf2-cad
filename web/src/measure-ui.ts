import { t, type Locale } from './i18n';
import { buildHatchSegments, measureAngle, measureDistance, polygonArea } from './measure-geometry';
import type { SavedHatch, SavedMeasurement } from './project';
import type { RasterViewer } from './viewer';

export type MeasureTool = 'distance' | 'angle' | 'hatch';

export interface MeasureWorkspaceState {
  measurements: SavedMeasurement[];
  hatches: SavedHatch[];
}

export class MeasureController {
  private active = false;
  private tool: MeasureTool = 'distance';
  private pending: { x: number; y: number }[] = [];
  private measurements: SavedMeasurement[] = [];
  private hatches: SavedHatch[] = [];
  private hatchSpacing = 5;
  private hatchAngle = 45;
  private lastMouse: { x: number; y: number } | null = null;

  constructor(
    private readonly viewer: RasterViewer,
    private readonly panel: HTMLElement,
    private readonly locale: Locale,
    private readonly onStatus: (msg: string, isError?: boolean) => void,
    private readonly onChange?: () => void,
  ) {}

  isActive(): boolean {
    return this.active;
  }

  activate(): void {
    this.active = true;
    this.panel.hidden = false;
    this.render();
    this.showToolHint();
    this.viewer.requestRender();
  }

  deactivate(): void {
    this.active = false;
    this.pending = [];
    this.panel.hidden = true;
    this.viewer.requestRender();
  }

  setLastMouse(x: number, y: number): void {
    this.lastMouse = { x, y };
    if (this.active) this.viewer.requestRender();
  }

  handleClick(clientX: number, clientY: number): boolean {
    if (!this.active) return false;
    const point = this.viewer.clientToRaster(clientX, clientY);
    if (!point) return true;

    if (this.tool === 'hatch' && this.pending.length >= 3) {
      const first = this.viewer.rasterToScreen(this.pending[0].x, this.pending[0].y);
      const current = this.viewer.rasterToScreen(point.x, point.y);
      if (Math.hypot(current.x - first.x, current.y - first.y) <= 12) {
        this.finishPending();
        return true;
      }
    }

    const last = this.pending[this.pending.length - 1];
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 1.5) return true;
    this.pending.push(point);

    const completedMeasurement =
      (this.tool === 'distance' && this.pending.length === 2) ||
      (this.tool === 'angle' && this.pending.length === 3);
    if (completedMeasurement) {
      this.measurements.push({
        id: this.nextMeasurementId(),
        kind: this.tool === 'angle' ? 'angle' : 'distance',
        points: this.pending.map((p) => ({ ...p })),
      });
      this.pending = [];
      this.syncDataset();
      this.onChange?.();
    }
    this.render();
    this.viewer.requestRender();
    return true;
  }

  finishPending(): boolean {
    if (!this.active || this.pending.length === 0) return false;
    let changed = false;
    if (this.tool === 'hatch' && this.pending.length >= 3) {
      const world = this.pending.map((p) => this.viewer.rasterToPart(p.x, p.y));
      if (Math.abs(polygonArea(world)) > 1e-9) {
        this.hatches.push({
          id: this.nextHatchId(),
          points: this.pending.map((p) => ({ ...p })),
          spacing: this.hatchSpacing,
          angle: this.hatchAngle,
        });
        changed = true;
      } else {
        this.onStatus(t(this.locale, 'measure.invalidHatch'), true);
      }
    }
    this.pending = [];
    if (changed) {
      this.syncDataset();
      this.onChange?.();
    }
    this.render();
    this.viewer.requestRender();
    return true;
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (e.key === 'Escape' && this.pending.length > 0) {
      this.pending = [];
      this.render();
      this.viewer.requestRender();
      this.showToolHint();
      return true;
    }
    if (e.key === 'Enter') return this.finishPending();
    return false;
  }

  exportState(): MeasureWorkspaceState {
    return {
      measurements: this.measurements.map((m) => ({
        ...m,
        points: m.points.map((p) => ({ ...p })),
      })),
      hatches: this.hatches.map((h) => ({
        ...h,
        points: h.points.map((p) => ({ ...p })),
      })),
    };
  }

  importState(measurements: SavedMeasurement[] = [], hatches: SavedHatch[] = []): void {
    this.measurements = measurements.map((m) => ({
      ...m,
      points: m.points.map((p) => ({ ...p })),
    }));
    this.hatches = hatches.map((h) => ({
      ...h,
      spacing: Number.isFinite(h.spacing) && h.spacing > 0 ? h.spacing : 5,
      angle: Number.isFinite(h.angle) ? h.angle : 45,
      points: h.points.map((p) => ({ ...p })),
    }));
    this.pending = [];
    this.syncDataset();
    if (this.active) this.render();
    this.viewer.requestRender();
  }

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (
      !this.active &&
      this.measurements.length === 0 &&
      this.hatches.length === 0 &&
      this.pending.length === 0
    ) {
      return;
    }
    const accent = getComputedStyle(this.panel).getPropertyValue('--color-accent').trim() || '#2465c7';
    const hatchColor = '#7c3aed';
    ctx.save();
    ctx.font = 'bold 11px Arial, sans-serif';

    for (const hatch of this.hatches) {
      const polygon = hatch.points.map((p) => this.viewer.rasterToPart(p.x, p.y));
      const segments = buildHatchSegments(polygon, hatch.spacing, hatch.angle);
      ctx.strokeStyle = hatchColor;
      ctx.globalAlpha = 0.72;
      ctx.lineWidth = 1;
      for (const segment of segments) {
        const aRaster = this.viewer.partToRaster(segment.a.x, segment.a.y);
        const bRaster = this.viewer.partToRaster(segment.b.x, segment.b.y);
        if (!aRaster || !bRaster) continue;
        const a = this.viewer.rasterToScreen(aRaster.x, aRaster.y);
        const b = this.viewer.rasterToScreen(bRaster.x, bRaster.y);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5;
      this.strokeRasterPolygon(ctx, hatch.points, hatchColor);
    }

    for (const measurement of this.measurements) {
      const points = measurement.points.map((p) => this.viewer.rasterToScreen(p.x, p.y));
      ctx.strokeStyle = accent;
      ctx.fillStyle = accent;
      ctx.lineWidth = 1.5;
      if (measurement.kind === 'distance' && points.length === 2) {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.stroke();
        this.drawBadge(
          ctx,
          (points[0].x + points[1].x) / 2,
          (points[0].y + points[1].y) / 2 - 14,
          `${this.measurementValue(measurement).toFixed(2)} mm`,
          accent,
        );
      } else if (measurement.kind === 'angle' && points.length === 3) {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.lineTo(points[2].x, points[2].y);
        ctx.stroke();
        this.drawAngleArc(ctx, points[0], points[1], points[2], accent);
        this.drawBadge(
          ctx,
          points[1].x + 18,
          points[1].y - 18,
          `${((this.measurementValue(measurement) * 180) / Math.PI).toFixed(2)}°`,
          accent,
        );
      }
      this.drawPointMarkers(ctx, points, accent);
    }

    if (this.active && this.pending.length > 0) {
      const points = this.pending.map((p) => this.viewer.rasterToScreen(p.x, p.y));
      ctx.strokeStyle = accent;
      ctx.fillStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(this.tool === 'hatch' ? [5, 4] : []);
      ctx.beginPath();
      points.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      if (this.lastMouse) ctx.lineTo(this.lastMouse.x, this.lastMouse.y);
      ctx.stroke();
      ctx.setLineDash([]);
      this.drawPointMarkers(ctx, points, accent);
      if (this.tool === 'distance' && points.length === 1 && this.lastMouse) {
        const firstWorld = this.viewer.rasterToPart(this.pending[0].x, this.pending[0].y);
        const currentRaster = this.viewer.screenToRaster(this.lastMouse.x, this.lastMouse.y);
        if (currentRaster) {
          const currentWorld = this.viewer.rasterToPart(currentRaster.x, currentRaster.y);
          this.drawBadge(
            ctx,
            (points[0].x + this.lastMouse.x) / 2,
            (points[0].y + this.lastMouse.y) / 2 - 14,
            `${measureDistance(firstWorld, currentWorld).toFixed(2)} mm`,
            accent,
          );
        }
      }
    }
    ctx.restore();
  }

  private measurementValue(measurement: SavedMeasurement): number {
    const world = measurement.points.map((p) => this.viewer.rasterToPart(p.x, p.y));
    return measurement.kind === 'distance'
      ? measureDistance(world[0], world[1])
      : measureAngle(world[0], world[1], world[2]);
  }

  private strokeRasterPolygon(
    ctx: CanvasRenderingContext2D,
    points: { x: number; y: number }[],
    color: string,
  ): void {
    if (points.length < 3) return;
    ctx.strokeStyle = color;
    ctx.beginPath();
    points.forEach((point, i) => {
      const screen = this.viewer.rasterToScreen(point.x, point.y);
      if (i === 0) ctx.moveTo(screen.x, screen.y);
      else ctx.lineTo(screen.x, screen.y);
    });
    ctx.closePath();
    ctx.stroke();
  }

  private drawPointMarkers(
    ctx: CanvasRenderingContext2D,
    points: { x: number; y: number }[],
    color: string,
  ): void {
    ctx.fillStyle = color;
    for (const point of points) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawAngleArc(
    ctx: CanvasRenderingContext2D,
    a: { x: number; y: number },
    vertex: { x: number; y: number },
    b: { x: number; y: number },
    color: string,
  ): void {
    const start = Math.atan2(a.y - vertex.y, a.x - vertex.x);
    const end = Math.atan2(b.y - vertex.y, b.x - vertex.x);
    const sweep = ((end - start) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(vertex.x, vertex.y, 22, start, end, sweep > Math.PI);
    ctx.stroke();
  }

  private drawBadge(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    text: string,
    color: string,
  ): void {
    const width = ctx.measureText(text).width + 10;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillRect(x - width / 2, y - 10, width, 18);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - width / 2, y - 10, width, 18);
    ctx.fillStyle = color;
    ctx.fillText(text, x - width / 2 + 5, y + 3);
  }

  private nextMeasurementId(): number {
    return this.measurements.reduce((max, m) => Math.max(max, m.id), 0) + 1;
  }

  private nextHatchId(): number {
    return this.hatches.reduce((max, h) => Math.max(max, h.id), 0) + 1;
  }

  private syncDataset(): void {
    document.documentElement.dataset.measurements = String(this.measurements.length);
    document.documentElement.dataset.hatches = String(this.hatches.length);
  }

  private showToolHint(): void {
    const key = this.tool === 'distance'
      ? 'measure.distanceHint'
      : this.tool === 'angle'
        ? 'measure.angleHint'
        : 'measure.hatchHint';
    this.onStatus(t(this.locale, key));
  }

  private setTool(tool: MeasureTool): void {
    this.tool = tool;
    this.pending = [];
    this.render();
    this.showToolHint();
    this.viewer.requestRender();
  }

  private render(): void {
    const locale = this.locale;
    const measurementsHtml = this.measurements.map((measurement, index) => {
      const value = this.measurementValue(measurement);
      const label = measurement.kind === 'distance'
        ? `D ${value.toFixed(2)} mm`
        : `∠ ${((value * 180) / Math.PI).toFixed(2)}°`;
      return `<li class="cal-segment"><span class="cal-label">${label}</span><button class="measure-delete tool-btn cal-delete" data-kind="measurement" data-index="${index}" type="button" aria-label="${t(locale, 'account.delete')}">×</button></li>`;
    }).join('');
    const hatchesHtml = this.hatches.map((hatch, index) =>
      `<li class="cal-segment"><span class="cal-label">▨ ${hatch.angle.toFixed(1)}° · ${hatch.spacing.toFixed(2)} mm</span><button class="measure-delete tool-btn cal-delete" data-kind="hatch" data-index="${index}" type="button" aria-label="${t(locale, 'account.delete')}">×</button></li>`,
    ).join('');

    this.panel.innerHTML = `
      <div class="panel-head">
        <h2 class="panel-title">${t(locale, 'measure.title')}</h2>
        <button id="measure-close" class="tool-btn" type="button" aria-label="${t(locale, 'calibrate.close')}">×</button>
      </div>
      <p class="cal-hint">${t(locale, this.tool === 'distance' ? 'measure.distanceHint' : this.tool === 'angle' ? 'measure.angleHint' : 'measure.hatchHint')}</p>
      <div class="sketch-toolbar-box">
        <div class="cal-actions">
          <button id="measure-tool-distance" class="btn ${this.tool === 'distance' ? 'btn-primary' : ''}" type="button">↔ ${t(locale, 'measure.distance')}</button>
          <button id="measure-tool-angle" class="btn ${this.tool === 'angle' ? 'btn-primary' : ''}" type="button">∠ ${t(locale, 'measure.angle')}</button>
          <button id="measure-tool-hatch" class="btn ${this.tool === 'hatch' ? 'btn-primary' : ''}" type="button">▨ ${t(locale, 'measure.hatch')}</button>
        </div>
        ${this.tool === 'hatch' ? `
          <div class="cal-actions">
            <label class="cal-label" for="measure-spacing">${t(locale, 'measure.spacing')}</label>
            <input id="measure-spacing" class="cal-length" type="number" min="0.01" step="any" value="${this.hatchSpacing}" />
            <label class="cal-label" for="measure-hatch-angle">${t(locale, 'measure.hatchAngle')}</label>
            <input id="measure-hatch-angle" class="cal-length" type="number" step="any" value="${this.hatchAngle}" />
          </div>
          ${this.pending.length >= 3 ? `<div class="cal-actions"><button id="measure-finish-hatch" class="btn btn-primary" type="button">${t(locale, 'measure.finishHatch')}</button></div>` : ''}
        ` : ''}
      </div>
      <details class="sketch-toolbar-box" open>
        <summary class="sketch-toolbar-title">${t(locale, 'measure.measurements')} (${this.measurements.length})</summary>
        ${measurementsHtml ? `<ol class="cal-segments">${measurementsHtml}</ol>` : `<p class="cal-empty">${t(locale, 'measure.empty')}</p>`}
        ${this.measurements.length > 0 ? `<button id="measure-clear-measurements" class="btn" type="button">${t(locale, 'sketch.clear')}</button>` : ''}
      </details>
      <details class="sketch-toolbar-box" open>
        <summary class="sketch-toolbar-title">${t(locale, 'measure.hatches')} (${this.hatches.length})</summary>
        ${hatchesHtml ? `<ol class="cal-segments">${hatchesHtml}</ol>` : `<p class="cal-empty">${t(locale, 'measure.empty')}</p>`}
        ${this.hatches.length > 0 ? `<button id="measure-clear-hatches" class="btn" type="button">${t(locale, 'sketch.clear')}</button>` : ''}
      </details>
    `;

    this.panel.querySelector('#measure-close')!.addEventListener('click', () => this.deactivate());
    this.panel.querySelector('#measure-tool-distance')!.addEventListener('click', () => this.setTool('distance'));
    this.panel.querySelector('#measure-tool-angle')!.addEventListener('click', () => this.setTool('angle'));
    this.panel.querySelector('#measure-tool-hatch')!.addEventListener('click', () => this.setTool('hatch'));
    this.panel.querySelector('#measure-finish-hatch')?.addEventListener('click', () => this.finishPending());
    this.panel.querySelector<HTMLInputElement>('#measure-spacing')?.addEventListener('change', (e) => {
      const value = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(value) && value > 0) this.hatchSpacing = value;
      this.render();
    });
    this.panel.querySelector<HTMLInputElement>('#measure-hatch-angle')?.addEventListener('change', (e) => {
      const value = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(value)) this.hatchAngle = value;
      this.render();
    });
    this.panel.querySelector('#measure-clear-measurements')?.addEventListener('click', () => {
      this.measurements = [];
      this.syncDataset();
      this.render();
      this.viewer.requestRender();
      this.onChange?.();
    });
    this.panel.querySelector('#measure-clear-hatches')?.addEventListener('click', () => {
      this.hatches = [];
      this.syncDataset();
      this.render();
      this.viewer.requestRender();
      this.onChange?.();
    });
    this.panel.querySelectorAll<HTMLButtonElement>('.measure-delete').forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.index);
        if (button.dataset.kind === 'measurement') this.measurements.splice(index, 1);
        else this.hatches.splice(index, 1);
        this.syncDataset();
        this.render();
        this.viewer.requestRender();
        this.onChange?.();
      });
    });
  }
}
