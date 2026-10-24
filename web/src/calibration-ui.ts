// Calibration UI controller: segment placement on the viewer, the calibration
// panel (lengths/orientations, solve, apply, report), and the Level tool.

import {
  isotropicWarnings,
  segmentResiduals,
  solveAnisotropic,
  solveIsotropic,
  solveRotation,
  type CalibrationSegment,
  type CalibrationWarning,
  type SegmentOrientation,
} from './calibration';
import { t, tf, type Locale } from './i18n';
import { formatDegrees, formatMm, parseLength } from './units';
import type { Affine, RasterViewer } from './viewer';

interface SegmentDraft {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  lengthText: string;
  orientation: SegmentOrientation;
  included: boolean;
}

export interface CalibrationResult {
  theta: number;
  sx: number;
  sy: number;
  isotropic: boolean;
  residuals: { lengthText: string; residualPct: number }[];
  warnings: CalibrationWarning[];
}

export class CalibrationController {
  private segments: SegmentDraft[] = [];
  private pending: { x: number; y: number } | null = null;
  private levelPending: { x: number; y: number } | null = null;
  private mode: 'off' | 'segment' | 'level' = 'off';
  private rotation = 0; // display rotation currently applied (radians, y-down)
  private lastMouse: { x: number; y: number } | null = null;
  result: CalibrationResult | null = null;

  constructor(
    private viewer: RasterViewer,
    private panel: HTMLElement,
    private locale: Locale,
    private onStatus: (msg: string, isError?: boolean) => void,
    private getPageSize: () => { width: number; height: number } | null,
  ) {}

  isActive(): boolean {
    return this.mode !== 'off';
  }

  /** Update the cursor position (canvas-relative CSS px) for the live preview. */
  setLastMouse(x: number, y: number): void {
    this.lastMouse = { x, y };
  }

  activate(): void {
    this.mode = 'segment';
    this.panel.hidden = false;
    this.onStatus(t(this.locale, 'calibrate.hint'));
    this.render();
  }

  deactivate(): void {
    this.mode = 'off';
    this.pending = null;
    this.levelPending = null;
    this.panel.hidden = true;
  }

  /** Handle a viewer click; returns true when the click was consumed. */
  handleClick(clientX: number, clientY: number): boolean {
    if (this.mode === 'off') return false;
    const raster = this.viewer.clientToRaster(clientX, clientY);
    if (!raster) return true;

    if (this.mode === 'level') {
      if (!this.levelPending) {
        this.levelPending = raster;
        this.onStatus(t(this.locale, 'calibrate.level.hint'));
      } else {
        const a = this.levelPending;
        const alpha = Math.atan2(raster.y - a.y, raster.x - a.x);
        this.rotation = -alpha;
        this.levelPending = null;
        this.applyRotation();
        this.onStatus(t(this.locale, 'status.ready'));
        this.render();
      }
      return true;
    }

    // Segment mode: two clicks per segment.
    if (!this.pending) {
      this.pending = raster;
      this.onStatus(t(this.locale, 'calibrate.hint'));
    } else {
      const a = this.pending;
      this.pending = null;
      this.segments.push({
        ax: a.x,
        ay: a.y,
        bx: raster.x,
        by: raster.y,
        lengthText: '10',
        orientation: { type: 'free' },
        included: true,
      });
      this.onStatus(t(this.locale, 'status.ready'));
      this.render();
    }
    return true;
  }

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (this.mode === 'off') return;
    const s = this.viewer.rasterToScreen.bind(this.viewer);
    const accent =
      getComputedStyle(this.panel).getPropertyValue('--color-accent').trim() || '#2465c7';

    ctx.save();
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;
    ctx.lineWidth = 1.5;

    // Placed segments.
    this.segments.forEach((seg, i) => {
      const a = s(seg.ax, seg.ay);
      const b = s(seg.bx, seg.by);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      this.dot(ctx, a.x, a.y);
      this.dot(ctx, b.x, b.y);
      ctx.fillText(String(i + 1), (a.x + b.x) / 2 + 4, (a.y + b.y) / 2 - 4);
    });

    // Pending point + live line to cursor.
    if (this.pending) {
      const a = s(this.pending.x, this.pending.y);
      this.dot(ctx, a.x, a.y);
      if (this.lastMouse) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(this.lastMouse.x, this.lastMouse.y);
        ctx.stroke();
      }
    }
    if (this.levelPending) {
      const a = s(this.levelPending.x, this.levelPending.y);
      this.dot(ctx, a.x, a.y);
      if (this.lastMouse) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(this.lastMouse.x, this.lastMouse.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  solve(): void {
    const solverSegments = this.buildSolverSegments();
    if (solverSegments === null) {
      this.onStatus(t(this.locale, 'calibrate.error.invalid-length'), true);
      return;
    }
    if (solverSegments.length === 0) {
      this.onStatus(t(this.locale, 'calibrate.result.none'), true);
      return;
    }

    const theta = solveRotation(solverSegments) ?? 0;
    const isotropic = solveIsotropic(solverSegments);
    const anisotropic = solveAnisotropic(solverSegments, theta);

    let sx: number;
    let sy: number;
    let isIso: boolean;
    if (anisotropic) {
      [sx, sy] = anisotropic;
      isIso = false;
    } else if (isotropic !== null) {
      sx = isotropic;
      sy = isotropic;
      isIso = true;
    } else {
      this.onStatus(t(this.locale, 'calibrate.result.none'), true);
      return;
    }

    const residuals = segmentResiduals(solverSegments, theta, sx, sy);
    const page = this.getPageSize();
    const pageDiagonal = page ? Math.hypot(page.width, page.height) : 0;
    const warnings = isotropicWarnings(solverSegments, residuals, pageDiagonal);

    this.result = {
      theta,
      sx,
      sy,
      isotropic: isIso,
      residuals: residuals.map((r, i) => ({
        lengthText: solverSegments[i].length.toString(),
        residualPct: r.residualPct,
      })),
      warnings,
    };
    this.onStatus(t(this.locale, 'status.ready'));
    this.render();
  }

  apply(): void {
    if (!this.result) {
      this.solve();
    }
    if (!this.result) return;
    // Display rotation (y-down) levels the raster; the world scale (mm/px) is
    // stored on the result and consumed by later milestones.
    this.rotation = -this.result.theta;
    this.applyRotation();
    this.onStatus(t(this.locale, 'status.ready'));
  }

  reset(): void {
    this.segments = [];
    this.pending = null;
    this.levelPending = null;
    this.rotation = 0;
    this.result = null;
    this.viewer.resetRasterTransform();
    this.render();
    this.onStatus(t(this.locale, 'status.ready'));
  }

  private applyRotation(): void {
    const page = this.getPageSize();
    const cx = page ? page.width / 2 : 0;
    const cy = page ? page.height / 2 : 0;
    const cosT = Math.cos(this.rotation);
    const sinT = Math.sin(this.rotation);
    // x' = cosT·u + sinT·v + (cx(1−cosT) − cy·sinT)
    // y' = −sinT·u + cosT·v + (cy(1−cosT) + cx·sinT)
    const t: Affine = [
      cosT,
      -sinT,
      sinT,
      cosT,
      cx * (1 - cosT) - cy * sinT,
      cy * (1 - cosT) + cx * sinT,
    ];
    this.viewer.setRasterTransform(t);
  }

  private buildSolverSegments(): CalibrationSegment[] | null {
    const out: CalibrationSegment[] = [];
    for (const seg of this.segments) {
      if (!seg.included) continue;
      const length = parseLength(seg.lengthText);
      if (length === null) return null;
      out.push({
        ax: seg.ax,
        ay: seg.ay,
        bx: seg.bx,
        by: seg.by,
        length,
        orientation: seg.orientation,
      });
    }
    return out;
  }

  private render(): void {
    const locale = this.locale;
    this.panel.innerHTML = `
      <div class="panel-head">
        <h2 class="panel-title">${t(locale, 'calibrate.title')}</h2>
        <button id="cal-close" class="tool-btn" type="button" aria-label="${t(locale, 'calibrate.close')}">×</button>
      </div>
      <p class="cal-hint">${t(locale, 'calibrate.hint')}</p>
      <div class="cal-actions">
        <button id="cal-level" class="btn" type="button">${t(locale, 'calibrate.level')}</button>
        <button id="cal-solve" class="btn btn-primary" type="button">${t(locale, 'calibrate.solve')}</button>
        <button id="cal-apply" class="btn" type="button">${t(locale, 'calibrate.apply')}</button>
        <button id="cal-reset" class="btn" type="button">${t(locale, 'calibrate.reset')}</button>
      </div>
      <ol class="cal-segments" id="cal-segments">${this.segments
        .map((seg, i) => this.segmentRow(seg, i))
        .join('')}</ol>
      <div class="cal-result" id="cal-result">${this.resultHtml()}</div>
    `;

    this.panel.querySelector('#cal-close')!.addEventListener('click', () => this.deactivate());
    this.panel.querySelector('#cal-solve')!.addEventListener('click', () => this.solve());
    this.panel.querySelector('#cal-apply')!.addEventListener('click', () => this.apply());
    this.panel.querySelector('#cal-reset')!.addEventListener('click', () => this.reset());
    this.panel.querySelector('#cal-level')!.addEventListener('click', () => {
      this.mode = 'level';
      this.levelPending = null;
      this.onStatus(t(this.locale, 'calibrate.level.hint'));
    });

    this.panel.querySelectorAll<HTMLInputElement>('.cal-include').forEach((el) => {
      const i = Number(el.dataset.index);
      el.addEventListener('change', () => {
        this.segments[i].included = el.checked;
      });
    });
    this.panel.querySelectorAll<HTMLInputElement>('.cal-length').forEach((el) => {
      const i = Number(el.dataset.index);
      el.addEventListener('change', () => {
        this.segments[i].lengthText = el.value;
      });
    });
    this.panel.querySelectorAll<HTMLSelectElement>('.cal-orientation').forEach((el) => {
      const i = Number(el.dataset.index);
      el.addEventListener('change', () => {
        this.segments[i].orientation = orientationFromValue(el.value);
      });
    });
    this.panel.querySelectorAll<HTMLButtonElement>('.cal-delete').forEach((el) => {
      const i = Number(el.dataset.index);
      el.addEventListener('click', () => {
        this.segments.splice(i, 1);
        this.render();
      });
    });
  }

  private segmentRow(seg: SegmentDraft, i: number): string {
    const locale = this.locale;
    return `
      <li class="cal-segment">
        <input class="cal-include" type="checkbox" data-index="${i}" ${seg.included ? 'checked' : ''} title="${t(locale, 'calibrate.include')}" />
        <span class="cal-label">${tf(locale, 'calibrate.segment', { n: i + 1 })}</span>
        <input class="cal-length" type="text" data-index="${i}" value="${escapeHtml(seg.lengthText)}" aria-label="${t(locale, 'calibrate.length')}" />
        <select class="cal-orientation" data-index="${i}" aria-label="${t(locale, 'calibrate.orientation')}">
          ${orientationOptions(seg.orientation, locale)}
        </select>
        <button class="cal-delete tool-btn" type="button" data-index="${i}" aria-label="${t(locale, 'calibrate.close')}">×</button>
      </li>`;
  }

  private resultHtml(): string {
    const locale = this.locale;
    const r = this.result;
    if (!r) return `<p class="cal-empty">${t(locale, 'calibrate.result.none')}</p>`;

    const scaleText = r.isotropic
      ? formatMm(r.sx)
      : `sx ${formatMm(r.sx)} · sy ${formatMm(r.sy)}`;
    const residualLines = r.residuals
      .map(
        (res, i) =>
          `<li>${tf(locale, 'calibrate.segment', { n: i + 1 })}: ${res.residualPct.toFixed(3)} %</li>`,
      )
      .join('');
    const warningLines = r.warnings
      .map((w) => `<li class="cal-warning">${this.warningText(w)}</li>`)
      .join('');

    return `
      <dl class="cal-stats">
        <div><dt>${t(locale, 'calibrate.result.rotation')}</dt><dd>${formatDegrees(r.theta)}</dd></div>
        <div><dt>${t(locale, 'calibrate.result.scale')}</dt><dd>${scaleText}</dd></div>
      </dl>
      <p class="cal-subhead">${t(locale, 'calibrate.result.residuals')}</p>
      <ul class="cal-residuals">${residualLines}</ul>
      ${warningLines ? `<ul class="cal-warnings">${warningLines}</ul>` : ''}
    `;
  }

  private warningText(w: CalibrationWarning): string {
    switch (w) {
      case 'too-few-segments':
        return t(this.locale, 'calibrate.warning.too-few');
      case 'high-max-residual':
        return t(this.locale, 'calibrate.warning.high-max-residual');
      case 'nearly-parallel':
        return t(this.locale, 'calibrate.warning.nearly-parallel');
      case 'short-segment':
        return t(this.locale, 'calibrate.warning.short-segment');
    }
  }

  private dot(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function orientationFromValue(value: string): SegmentOrientation {
  if (value === 'horizontal') return { type: 'horizontal' };
  if (value === 'vertical') return { type: 'vertical' };
  return { type: 'free' };
}

function orientationOptions(orientation: SegmentOrientation, locale: Locale): string {
  const current =
    orientation.type === 'horizontal' ? 'horizontal' : orientation.type === 'vertical' ? 'vertical' : 'free';
  return `
    <option value="free" ${current === 'free' ? 'selected' : ''}>${t(locale, 'calibrate.free')}</option>
    <option value="horizontal" ${current === 'horizontal' ? 'selected' : ''}>${t(locale, 'calibrate.horizontal')}</option>
    <option value="vertical" ${current === 'vertical' ? 'selected' : ''}>${t(locale, 'calibrate.vertical')}</option>`;
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
