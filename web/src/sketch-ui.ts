// Minimal sketch tool wired to the WASM core: click to place points, then
// "Solve" runs the Rust constraint solver and snaps the sketch to its
// constraints (horizontal + a driving distance on the first segment).

import { t, tf, type Locale } from './i18n';
import type { RasterViewer } from './viewer';
import { loadWasm } from './wasm';

interface SketchPoint {
  id: number;
  x: number;
  y: number;
}

interface SolveResult {
  converged: boolean;
  max_residual: number;
  params: number[];
}

export class SketchController {
  private points: SketchPoint[] = [];
  private pending: { x: number; y: number } | null = null;
  private active = false;
  private resultText = '';

  constructor(
    private viewer: RasterViewer,
    private panel: HTMLElement,
    private locale: Locale,
    private onStatus: (msg: string, isError?: boolean) => void,
    private getGray: () => Promise<{ data: Uint8Array; width: number; height: number } | null>,
    private getMaskStrokes: () => { mode: 'include' | 'exclude'; points: { x: number; y: number }[] }[],
  ) {}

  isActive(): boolean {
    return this.active;
  }

  activate(): void {
    this.active = true;
    this.panel.hidden = false;
    this.onStatus(t(this.locale, 'sketch.hint'));
    this.render();
  }

  deactivate(): void {
    this.active = false;
    this.pending = null;
    this.panel.hidden = true;
  }

  /** Handle a viewer click; returns true when consumed. */
  handleClick(clientX: number, clientY: number): boolean {
    if (!this.active) return false;
    const r = this.viewer.clientToRaster(clientX, clientY);
    if (!r) return true;

    if (!this.pending) {
      this.pending = r;
      this.onStatus(t(this.locale, 'sketch.hint'));
    } else {
      this.points.push({ id: this.points.length + 1, x: this.pending.x, y: this.pending.y });
      this.points.push({ id: this.points.length + 1, x: r.x, y: r.y });
      this.pending = null;
      this.resultText = '';
      this.render();
      this.onStatus(t(this.locale, 'status.ready'));
    }
    return true;
  }

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (!this.active || this.points.length === 0) return;
    const to = this.viewer.rasterToScreen.bind(this.viewer);
    const accent = getComputedStyle(this.panel).getPropertyValue('--color-accent').trim() || '#2465c7';

    ctx.save();
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;
    ctx.lineWidth = 1.5;

    // Lines between consecutive points.
    for (let i = 0; i + 1 < this.points.length; i += 2) {
      const a = to(this.points[i].x, this.points[i].y);
      const b = to(this.points[i + 1].x, this.points[i + 1].y);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    // Points.
    for (const p of this.points) {
      const s = to(p.x, p.y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // Pending point.
    if (this.pending) {
      const s = to(this.pending.x, this.pending.y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  async solve(): Promise<void> {
    if (this.points.length < 2) {
      this.onStatus(t(this.locale, 'sketch.none'), true);
      return;
    }
    try {
      const wasm = await loadWasm();
      const sketch = this.buildSketch();
      const result: SolveResult = JSON.parse(wasm.solve_constraints(JSON.stringify(sketch)));
      for (let i = 0; i < this.points.length; i += 1) {
        this.points[i].x = result.params[2 * i];
        this.points[i].y = result.params[2 * i + 1];
      }
      this.resultText = result.converged
        ? tf(this.locale, 'sketch.result', { r: result.max_residual.toExponential(2) })
        : t(this.locale, 'error.failed');
      this.onStatus(this.resultText, !result.converged);
      this.render();
    } catch (err) {
      this.onStatus(t(this.locale, 'error.failed'), true);
      console.error('sketch solve failed', err);
    }
  }

  async fit(): Promise<void> {
    if (this.points.length < 2) {
      this.onStatus(t(this.locale, 'sketch.none'), true);
      return;
    }
    try {
      const gray = await this.getGray();
      if (!gray) {
        this.onStatus(t(this.locale, 'sketch.none'), true);
        return;
      }
      const wasm = await loadWasm();
      const ridgeParams = { scales: [1.0, 1.5, 2.5], background_radius: 24, min_strength: 5.0 };
      const ridges = JSON.parse(
        wasm.detect_ridges(gray.data, gray.width, gray.height, JSON.stringify(ridgeParams)),
      ) as { x: number; y: number; direction: number; strength: number; scale: number }[];

      const fitterParams = {
        max_iterations: 40,
        capture_radius: 12.0,
        sample_step: 2.0,
        tikhonov: 1e-6,
        constraint_penalty: 1e-3,
      };

      const sketchJson = JSON.stringify(this.buildSketch());
      const maskStrokes = this.getMaskStrokes();
      let resultJson: string;
      if (maskStrokes.length > 0) {
        const rfStrokes = maskStrokes.map((s) => ({
          mode: s.mode === 'include' ? 'Include' : 'Exclude',
          kind: 'Brush',
          radius: 6.0,
          points: s.points,
        }));
        const maskParams = {
          enabled: true,
          base_all: !maskStrokes.some((s) => s.mode === 'include'),
          feather: 3.0,
        };
        resultJson = wasm.fit_sketch_masked(
          sketchJson,
          JSON.stringify(ridges),
          JSON.stringify(rfStrokes),
          JSON.stringify(maskParams),
          gray.width,
          gray.height,
          JSON.stringify([0, 0, 0]),
          JSON.stringify(fitterParams),
        );
      } else {
        resultJson = wasm.fit_sketch(sketchJson, JSON.stringify(ridges), JSON.stringify([0, 0, 0]), JSON.stringify(fitterParams));
      }

      const result = JSON.parse(resultJson) as { params: number[]; rms_px: number; transform: [number, number, number] };

      for (let i = 0; i < this.points.length; i += 1) {
        this.points[i].x = result.params[2 * i];
        this.points[i].y = result.params[2 * i + 1];
      }
      this.resultText = tf(this.locale, 'sketch.fitResult', {
        r: result.rms_px.toFixed(3),
        t: ((result.transform[0] * 180) / Math.PI).toFixed(3),
      });
      this.onStatus(this.resultText);
      this.render();
    } catch (err) {
      this.onStatus(t(this.locale, 'error.failed'), true);
      console.error('fit failed', err);
    }
  }

  clear(): void {
    this.points = [];
    this.pending = null;
    this.resultText = '';
    this.render();
    this.onStatus(t(this.locale, 'status.ready'));
  }

  private buildSketch(): object {
    const points = this.points.map((p) => ({ id: p.id, x: p.x, y: p.y }));
    const lines = [];
    for (let i = 0; i + 1 < this.points.length; i += 2) {
      lines.push({ id: i / 2 + 1, a: this.points[i].id, b: this.points[i + 1].id, construction: false });
    }
    const constraints: unknown[] = [];
    if (this.points.length >= 2) {
      constraints.push({ Horizontal: lines[0].id });
      constraints.push({ Distance: [this.points[0].id, this.points[1].id, 10.0] });
    }
    return { points, lines, circles: [], constraints };
  }

  private render(): void {
    const locale = this.locale;
    this.panel.innerHTML = `
      <div class="panel-head">
        <h2 class="panel-title">${t(locale, 'sketch.title')}</h2>
        <button id="sketch-close" class="tool-btn" type="button" aria-label="${t(locale, 'calibrate.close')}">×</button>
      </div>
      <p class="cal-hint">${t(locale, 'sketch.hint')}</p>
      <div class="cal-actions">
        <button id="sketch-solve" class="btn btn-primary" type="button">${t(locale, 'sketch.solve')}</button>
        <button id="sketch-fit" class="btn" type="button">${t(locale, 'sketch.fit')}</button>
        <button id="sketch-clear" class="btn" type="button">${t(locale, 'sketch.clear')}</button>
      </div>
      <p class="cal-empty" id="sketch-result">${escapeHtml(this.resultText)}</p>
    `;

    this.panel.querySelector('#sketch-close')!.addEventListener('click', () => this.deactivate());
    this.panel.querySelector('#sketch-solve')!.addEventListener('click', () => void this.solve());
    this.panel.querySelector('#sketch-fit')!.addEventListener('click', () => void this.fit());
    this.panel.querySelector('#sketch-clear')!.addEventListener('click', () => this.clear());
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
