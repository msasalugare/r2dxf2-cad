import { rulerStepForRange, rulerStepForScale } from './guide-geometry';
import type { SavedGuide } from './project';
import type { RasterViewer } from './viewer';

const RULER_SIZE = 24;
const HIT_TOLERANCE = 8;
const FAR = 1e6;

export class GuideController {
  private guides: SavedGuide[] = [];
  private selectedGuide: number | null = null;
  private drag: { kind: SavedGuide['kind']; value: number } | null = null;

  constructor(
    private readonly viewer: RasterViewer,
    private readonly onChange?: () => void,
    private readonly canSelect: () => boolean = () => true,
  ) {
    document.documentElement.dataset.rulers = 'true';
    this.syncDataset();
  }

  handleDrag(clientX: number, clientY: number, phase: 'start' | 'move' | 'end'): boolean {
    if (phase === 'start') {
      const ruler = this.rulerAt(clientX, clientY);
      if (ruler) {
        this.selectedGuide = null;
        this.drag = { kind: ruler, value: this.partValue(clientX, clientY, ruler) };
        this.syncDataset();
        this.viewer.requestRender();
        return true;
      }
      const hit = this.canSelect() ? this.findGuideAt(clientX, clientY) : null;
      this.selectedGuide = hit?.id ?? null;
      this.syncDataset();
      this.viewer.requestRender();
      return hit !== null;
    }

    if (!this.drag) return false;
    if (phase === 'move') {
      this.drag.value = this.partValue(clientX, clientY, this.drag.kind);
      this.viewer.requestRender();
      return true;
    }

    const drag = this.drag;
    this.drag = null;
    if (this.insideDrawingArea(clientX, clientY)) {
      this.guides.push({ id: this.nextId(), kind: drag.kind, value: drag.value });
      this.onChange?.();
    }
    this.syncDataset();
    this.viewer.requestRender();
    return true;
  }

  handleKey(e: KeyboardEvent): boolean {
    if ((e.key !== 'Delete' && e.key !== 'Backspace') || this.selectedGuide === null) return false;
    this.guides = this.guides.filter((guide) => guide.id !== this.selectedGuide);
    this.selectedGuide = null;
    this.syncDataset();
    this.viewer.requestRender();
    this.onChange?.();
    return true;
  }

  snapToGuide(
    point: { x: number; y: number },
    tolerancePx = 8,
  ): { x: number; y: number; snapped: boolean } {
    const screen = this.viewer.rasterToScreen(point.x, point.y);
    const part = this.viewer.rasterToPart(point.x, point.y);
    let best: { x: number; y: number } | null = null;
    let bestDistance = tolerancePx;
    for (const guide of this.guides) {
      const projected = this.viewer.partToRaster(
        guide.kind === 'vertical' ? guide.value : part.x,
        guide.kind === 'horizontal' ? guide.value : part.y,
      );
      if (!projected) continue;
      const guideScreen = this.viewer.rasterToScreen(projected.x, projected.y);
      const distance = Math.hypot(guideScreen.x - screen.x, guideScreen.y - screen.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = projected;
      }
    }
    return best ? { ...best, snapped: true } : { ...point, snapped: false };
  }

  exportState(): SavedGuide[] {
    return this.guides.map((guide) => ({ ...guide }));
  }

  importState(guides: SavedGuide[] = []): void {
    this.guides = guides.filter((guide) => Number.isFinite(guide.value)).map((guide) => ({ ...guide }));
    this.selectedGuide = null;
    this.drag = null;
    this.syncDataset();
    this.viewer.requestRender();
  }

  drawOverlay(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    for (const guide of this.guides) {
      this.drawGuide(ctx, guide.kind, guide.value, guide.id === this.selectedGuide);
    }
    if (this.drag) this.drawGuide(ctx, this.drag.kind, this.drag.value, true);
    this.drawRulers(ctx, width, height);
  }

  private rulerAt(clientX: number, clientY: number): SavedGuide['kind'] | null {
    const rect = this.canvasRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    if (x >= RULER_SIZE && y < RULER_SIZE) return 'horizontal';
    if (x < RULER_SIZE && y >= RULER_SIZE) return 'vertical';
    return null;
  }

  private insideDrawingArea(clientX: number, clientY: number): boolean {
    const rect = this.canvasRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return x >= RULER_SIZE && y >= RULER_SIZE && x <= rect.width && y <= rect.height;
  }

  private partValue(clientX: number, clientY: number, kind: SavedGuide['kind']): number {
    const part = this.viewer.clientToPart(clientX, clientY);
    return kind === 'vertical' ? part.x : part.y;
  }

  private findGuideAt(clientX: number, clientY: number): SavedGuide | null {
    const rect = this.canvasRect();
    const screen = { x: clientX - rect.left, y: clientY - rect.top };
    const part = this.viewer.clientToPart(clientX, clientY);
    let best: SavedGuide | null = null;
    let bestDistance = HIT_TOLERANCE;
    for (const guide of this.guides) {
      const projected = this.viewer.partToRaster(
        guide.kind === 'vertical' ? guide.value : part.x,
        guide.kind === 'horizontal' ? guide.value : part.y,
      );
      if (!projected) continue;
      const point = this.viewer.rasterToScreen(projected.x, projected.y);
      const distance = Math.hypot(point.x - screen.x, point.y - screen.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = guide;
      }
    }
    return best;
  }

  private drawGuide(
    ctx: CanvasRenderingContext2D,
    kind: SavedGuide['kind'],
    value: number,
    selected: boolean,
  ): void {
    const a = kind === 'vertical'
      ? this.partToScreen(value, -FAR)
      : this.partToScreen(-FAR, value);
    const b = kind === 'vertical'
      ? this.partToScreen(value, FAR)
      : this.partToScreen(FAR, value);
    ctx.save();
    ctx.strokeStyle = selected ? '#f59e0b' : '#22d3ee';
    ctx.lineWidth = selected ? 2 : 1.25;
    ctx.setLineDash(selected ? [] : [7, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  private drawRulers(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const style = getComputedStyle(document.documentElement);
    const surface = style.getPropertyValue('--color-surface-panel').trim() || '#242628';
    const divider = style.getPropertyValue('--color-divider').trim() || '#3a3d40';
    const text = style.getPropertyValue('--color-text-secondary').trim() || '#a7adb2';
    ctx.save();
    ctx.fillStyle = surface;
    ctx.fillRect(0, 0, width, RULER_SIZE);
    ctx.fillRect(0, 0, RULER_SIZE, height);
    ctx.strokeStyle = divider;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_SIZE + 0.5);
    ctx.lineTo(width, RULER_SIZE + 0.5);
    ctx.moveTo(RULER_SIZE + 0.5, 0);
    ctx.lineTo(RULER_SIZE + 0.5, height);
    ctx.stroke();
    ctx.fillStyle = surface;
    ctx.fillRect(0, 0, RULER_SIZE, RULER_SIZE);
    ctx.strokeRect(0.5, 0.5, RULER_SIZE - 1, RULER_SIZE - 1);

    ctx.fillStyle = text;
    ctx.strokeStyle = text;
    ctx.font = '10px Arial, sans-serif';
    document.documentElement.dataset.rulerUnits = 'mm';
    ctx.fillText('mm', 4, 15);
    this.drawHorizontalTicks(ctx, width);
    this.drawVerticalTicks(ctx, height);
    ctx.restore();
  }

  private drawHorizontalTicks(ctx: CanvasRenderingContext2D, width: number): void {
    const scale = this.viewer.getWorldScale().sx;
    const rect = this.canvasRect();
    const start = this.viewer.clientToPart(rect.left + RULER_SIZE, rect.top + RULER_SIZE).x;
    const end = this.viewer.clientToPart(rect.left + width, rect.top + RULER_SIZE).x;
    const min = Math.min(start, end);
    const max = Math.max(start, end);
    const step = rulerStepForRange(rulerStepForScale(this.viewer.getEffectiveZoom(), scale), min, max);
    document.documentElement.dataset.rulerStepX = String(step);
    const first = Math.ceil(min / step) * step;
    let count = 0;
    for (let value = first; value <= max && count < 500; value += step, count += 1) {
      const x = this.horizontalTickPosition(value);
      if (x === null || x < RULER_SIZE || x > width) continue;
      ctx.beginPath();
      ctx.moveTo(x, RULER_SIZE - 10);
      ctx.lineTo(x, RULER_SIZE);
      ctx.stroke();
      ctx.fillText(this.formatTick(value, step), x + 3, 10);
    }
  }

  private drawVerticalTicks(ctx: CanvasRenderingContext2D, height: number): void {
    const scale = this.viewer.getWorldScale().sy;
    const rect = this.canvasRect();
    const start = this.viewer.clientToPart(rect.left + RULER_SIZE, rect.top + RULER_SIZE).y;
    const end = this.viewer.clientToPart(rect.left + RULER_SIZE, rect.top + height).y;
    const min = Math.min(start, end);
    const max = Math.max(start, end);
    const step = rulerStepForRange(rulerStepForScale(this.viewer.getEffectiveZoom(), scale), min, max);
    document.documentElement.dataset.rulerStepY = String(step);
    const first = Math.ceil(min / step) * step;
    let count = 0;
    for (let value = first; value <= max && count < 500; value += step, count += 1) {
      const y = this.verticalTickPosition(value);
      if (y === null || y < RULER_SIZE || y > height) continue;
      ctx.beginPath();
      ctx.moveTo(RULER_SIZE - 10, y);
      ctx.lineTo(RULER_SIZE, y);
      ctx.stroke();
      ctx.save();
      ctx.translate(10, y - 3);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(this.formatTick(value, step), 0, 0);
      ctx.restore();
    }
  }

  private horizontalTickPosition(value: number): number | null {
    const origin = this.partToScreen(0, 0);
    const xAxis = this.partToScreen(1, 0);
    const yAxis = this.partToScreen(0, 1);
    const dx = { x: xAxis.x - origin.x, y: xAxis.y - origin.y };
    const dy = { x: yAxis.x - origin.x, y: yAxis.y - origin.y };
    if (Math.abs(dy.y) < 1e-12) return null;
    const distance = (RULER_SIZE - origin.y - value * dx.y) / dy.y;
    return origin.x + value * dx.x + distance * dy.x;
  }

  private verticalTickPosition(value: number): number | null {
    const origin = this.partToScreen(0, 0);
    const xAxis = this.partToScreen(1, 0);
    const yAxis = this.partToScreen(0, 1);
    const dx = { x: xAxis.x - origin.x, y: xAxis.y - origin.y };
    const dy = { x: yAxis.x - origin.x, y: yAxis.y - origin.y };
    if (Math.abs(dx.x) < 1e-12) return null;
    const distance = (RULER_SIZE - origin.x - value * dy.x) / dx.x;
    return origin.y + value * dy.y + distance * dx.y;
  }

  private partToScreen(px: number, py: number): { x: number; y: number } {
    const raster = this.viewer.partToRaster(px, py);
    return raster ? this.viewer.rasterToScreen(raster.x, raster.y) : { x: 0, y: 0 };
  }

  private formatTick(value: number, step: number): string {
    const decimals = Math.max(0, Math.min(6, -Math.floor(Math.log10(step))));
    const normalized = Math.abs(value) < step * 1e-9 ? 0 : value;
    return normalized.toFixed(decimals);
  }

  private canvasRect(): DOMRect {
    return document.querySelector<HTMLCanvasElement>('#viewer')!.getBoundingClientRect();
  }

  private nextId(): number {
    return this.guides.reduce((max, guide) => Math.max(max, guide.id), 0) + 1;
  }

  private syncDataset(): void {
    document.documentElement.dataset.guides = String(this.guides.length);
    document.documentElement.dataset.guideSelected = this.selectedGuide === null ? '' : String(this.selectedGuide);
  }
}
