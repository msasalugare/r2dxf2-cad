import { t, type Locale } from './i18n';
import type { SavedSketchText } from './project';
import type { RasterViewer } from './viewer';

interface TextHitRegion {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  rotation: number;
  lines: number;
}

export class TextController {
  private active = false;
  private texts: SavedSketchText[] = [];
  private selectedId: number | null = null;
  private draft = '';
  private height = 3.5;
  private rotation = 0;
  private drag: { id: number; dx: number; dy: number } | null = null;
  private hitRegions: TextHitRegion[] = [];

  constructor(
    private readonly viewer: RasterViewer,
    private readonly panel: HTMLElement,
    private readonly locale: Locale,
    private readonly onStatus: (message: string, isError?: boolean) => void,
    private readonly onChange?: () => void,
  ) {
    this.syncDataset();
  }

  isActive(): boolean {
    return this.active;
  }

  activate(): void {
    this.active = true;
    this.panel.hidden = false;
    this.render();
    this.onStatus(t(this.locale, 'text.hint'));
    this.viewer.requestRender();
  }

  deactivate(): void {
    this.active = false;
    this.drag = null;
    this.panel.hidden = true;
    this.viewer.requestRender();
  }

  handleClick(clientX: number, clientY: number): boolean {
    if (!this.active) return false;
    const hit = this.findTextAt(clientX, clientY);
    if (hit) {
      this.selectText(hit.id);
      return true;
    }

    const point = this.viewer.clientToRaster(clientX, clientY);
    if (!point) return true;
    if (!this.draft.trim()) {
      this.onStatus(t(this.locale, 'text.empty'), true);
      return true;
    }
    const text: SavedSketchText = {
      id: this.nextId(),
      x: point.x,
      y: point.y,
      text: this.draft,
      height: this.height,
      rotation: (this.rotation * Math.PI) / 180,
    };
    this.texts.push(text);
    this.selectText(text.id);
    this.onChange?.();
    return true;
  }

  handleDrag(clientX: number, clientY: number, phase: 'start' | 'move' | 'end'): boolean {
    if (!this.active) return false;
    if (phase === 'start') {
      const hit = this.findTextAt(clientX, clientY);
      const point = this.viewer.clientToRaster(clientX, clientY);
      if (!hit || !point) return false;
      this.selectText(hit.id);
      this.drag = { id: hit.id, dx: point.x - hit.x, dy: point.y - hit.y };
      return true;
    }
    if (!this.drag) return false;
    if (phase === 'move') {
      const point = this.viewer.clientToRaster(clientX, clientY);
      const text = this.texts.find((item) => item.id === this.drag?.id);
      if (point && text) {
        text.x = point.x - this.drag.dx;
        text.y = point.y - this.drag.dy;
        this.viewer.requestRender();
      }
      return true;
    }
    this.drag = null;
    this.onChange?.();
    return true;
  }

  handleKey(event: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (event.key === 'Escape' && this.selectedId !== null) {
      this.selectedId = null;
      this.syncDataset();
      this.render();
      this.viewer.requestRender();
      return true;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.selectedId !== null) {
      this.deleteSelected();
      return true;
    }
    return false;
  }

  exportState(): SavedSketchText[] {
    return this.texts.map((text) => ({ ...text }));
  }

  importState(texts: SavedSketchText[] = []): void {
    this.texts = texts
      .filter((text) => Number.isFinite(text.x) && Number.isFinite(text.y))
      .map((text) => ({
        ...text,
        height: Number.isFinite(text.height) && text.height > 0 ? text.height : 3.5,
        rotation: Number.isFinite(text.rotation) ? text.rotation : 0,
      }));
    this.selectedId = null;
    this.drag = null;
    this.syncDataset();
    if (this.active) this.render();
    this.viewer.requestRender();
  }

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    this.hitRegions = [];
    const scale = this.viewer.getWorldScale();
    const zoom = this.viewer.getEffectiveZoom();
    const transform = this.viewer.getCombinedTransform();
    const displayRotation = Math.atan2(transform[1], transform[0]);
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    for (const text of this.texts) {
      const position = this.viewer.rasterToScreen(text.x, text.y);
      const fontSize = Math.max(1, (text.height / (scale.sy || 1)) * zoom);
      const rotation = text.rotation + displayRotation;
      const lines = text.text.split('\n');
      ctx.save();
      ctx.translate(position.x, position.y);
      ctx.rotate(rotation);
      ctx.font = `${fontSize}px Arial, sans-serif`;
      ctx.fillStyle = this.selectedId === text.id ? '#f59e0b' : '#38bdf8';
      lines.forEach((line, index) => ctx.fillText(line, 0, index * fontSize * 1.2));
      const width = Math.max(0, ...lines.map((line) => ctx.measureText(line).width));
      if (this.selectedId === text.id) {
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(-4, -fontSize, width + 8, fontSize * (1 + Math.max(0, lines.length - 1) * 1.2) + 8);
      }
      ctx.restore();
      this.hitRegions.push({
        id: text.id,
        x: position.x,
        y: position.y,
        width,
        height: fontSize,
        fontSize,
        rotation,
        lines: lines.length,
      });
    }
    ctx.restore();
  }

  private findTextAt(clientX: number, clientY: number): SavedSketchText | null {
    const canvas = this.panel.ownerDocument.querySelector<HTMLCanvasElement>('#viewer');
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return null;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    for (let i = this.hitRegions.length - 1; i >= 0; i -= 1) {
      const region = this.hitRegions[i];
      const dx = x - region.x;
      const dy = y - region.y;
      const cos = Math.cos(-region.rotation);
      const sin = Math.sin(-region.rotation);
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;
      const bottom = (region.lines - 1) * region.fontSize * 1.2 + 5;
      if (localX >= -6 && localX <= region.width + 6 && localY >= -region.height - 4 && localY <= bottom) {
        return this.texts.find((text) => text.id === region.id) ?? null;
      }
    }
    return null;
  }

  private selectText(id: number): void {
    this.selectedId = id;
    const text = this.texts.find((item) => item.id === id);
    if (text) {
      this.draft = text.text;
      this.height = text.height;
      this.rotation = (text.rotation * 180) / Math.PI;
    }
    this.syncDataset();
    this.render();
    this.viewer.requestRender();
  }

  private deleteSelected(): void {
    if (this.selectedId === null) return;
    this.texts = this.texts.filter((text) => text.id !== this.selectedId);
    this.selectedId = null;
    this.draft = '';
    this.syncDataset();
    this.render();
    this.viewer.requestRender();
    this.onChange?.();
  }

  private render(): void {
    const selected = this.selectedId !== null;
    this.panel.innerHTML = `
      <div class="panel-head">
        <h2 class="panel-title">${t(this.locale, 'text.title')}</h2>
        <button id="text-close" class="tool-btn" type="button" aria-label="${t(this.locale, 'calibrate.close')}">×</button>
      </div>
      <p class="cal-hint">${t(this.locale, 'text.hint')}</p>
      <div class="sketch-toolbar-box text-editor">
        <label class="cal-label" for="text-content">${t(this.locale, 'text.content')}</label>
        <textarea id="text-content" rows="5">${escapeHtml(this.draft)}</textarea>
        <div class="cal-actions">
          <label class="cal-label" for="text-height">${t(this.locale, 'text.height')}</label>
          <input id="text-height" class="cal-length" type="number" min="0.1" step="any" value="${this.height}" />
          <label class="cal-label" for="text-rotation">${t(this.locale, 'text.rotation')}</label>
          <input id="text-rotation" class="cal-length" type="number" step="any" value="${this.rotation}" />
        </div>
        <div class="cal-actions">
          <button id="text-delete" class="btn" type="button" ${selected ? '' : 'disabled'}>${t(this.locale, 'account.delete')}</button>
        </div>
      </div>
      <p class="cal-hint">${t(this.locale, 'text.count')} ${this.texts.length}</p>
    `;

    this.panel.querySelector('#text-close')!.addEventListener('click', () => this.deactivate());
    this.panel.querySelector('#text-delete')!.addEventListener('click', () => this.deleteSelected());
    this.panel.querySelector<HTMLTextAreaElement>('#text-content')!.addEventListener('input', (event) => {
      this.draft = (event.target as HTMLTextAreaElement).value;
      const text = this.texts.find((item) => item.id === this.selectedId);
      if (text) text.text = this.draft;
      this.viewer.requestRender();
      this.onChange?.();
    });
    this.panel.querySelector<HTMLInputElement>('#text-height')!.addEventListener('change', (event) => {
      const value = Number((event.target as HTMLInputElement).value);
      if (!Number.isFinite(value) || value <= 0) return;
      this.height = value;
      const text = this.texts.find((item) => item.id === this.selectedId);
      if (text) text.height = value;
      this.viewer.requestRender();
      this.onChange?.();
    });
    this.panel.querySelector<HTMLInputElement>('#text-rotation')!.addEventListener('change', (event) => {
      const value = Number((event.target as HTMLInputElement).value);
      if (!Number.isFinite(value)) return;
      this.rotation = value;
      const text = this.texts.find((item) => item.id === this.selectedId);
      if (text) text.rotation = (value * Math.PI) / 180;
      this.viewer.requestRender();
      this.onChange?.();
    });
  }

  private nextId(): number {
    return this.texts.reduce((max, text) => Math.max(max, text.id), 0) + 1;
  }

  private syncDataset(): void {
    document.documentElement.dataset.texts = String(this.texts.length);
    document.documentElement.dataset.textSelected = this.selectedId === null ? '' : String(this.selectedId);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
