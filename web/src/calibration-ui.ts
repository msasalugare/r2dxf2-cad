// Calibration UI controller: segment placement & endpoint dragging on the viewer,
// automatic & manual solve/apply, rotation controls (slider, angle input, ±90°/±1°/±0.1°,
// 2-point Level tool), 8× magnifying loupe, sub-pixel ridge snap, and LOO diagnostics.

import {
  isotropicWarnings,
  leaveOneOutIsotropic,
  pixelLength,
  segmentResiduals,
  solveAnisotropic,
  solveIsotropic,
  solveRotation,
  type CalibrationSegment,
  type CalibrationWarning,
  type SegmentOrientation,
} from './calibration';
import { t, tf, type Locale } from './i18n';
import type { SavedCalibrationSegment } from './project';
import { TILE_SIZE, tileIndex } from './raster';
import { formatDegrees, formatMm, parseLength } from './units';
import type { Affine, RasterViewer } from './viewer';

export interface SegmentDraft {
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
  hasOrientedSegment: boolean;
  residuals: { lengthText: string; residualMm: number; residualPct: number }[];
  looScales: number[];
  warnings: CalibrationWarning[];
}

export class CalibrationController {
  private segments: SegmentDraft[] = [];
  private pending: { x: number; y: number } | null = null;
  private levelPending: { x: number; y: number } | null = null;
  private dragEndpoint: { segIndex: number; end: 'a' | 'b' } | null = null;
  private mode: 'off' | 'segment' | 'level' = 'off';
  private rotation = 0; // clockwise screen rotation applied to raster (radians)
  private flipH = false;
  private flipV = false;
  private snapEnabled = true;
  private loupeEnabled = true;
  private lastMouse: { x: number; y: number } | null = null;
  private grayCache: { data: Uint8Array; width: number; height: number } | null = null;
  result: CalibrationResult | null = null;

  constructor(
    private viewer: RasterViewer,
    private panel: HTMLElement,
    private locale: Locale,
    private onStatus: (msg: string, isError?: boolean) => void,
    private getPageSize: () => { width: number; height: number } | null,
    private onChange?: () => void,
  ) {}

  isActive(): boolean {
    return this.mode !== 'off';
  }

  /** Provide the current page's gray8 buffer for sub-pixel ridge snapping. */
  setGrayBuffer(gray: { data: Uint8Array; width: number; height: number } | null): void {
    this.grayCache = gray;
  }

  /** Update the cursor position (canvas-relative CSS px) for the live preview & 8× loupe. */
  setLastMouse(x: number, y: number): void {
    this.lastMouse = { x, y };
    if (this.mode !== 'off') {
      this.viewer.requestRender();
    }
  }

  cancelPending(): boolean {
    if (this.pending || this.levelPending) {
      this.pending = null;
      this.levelPending = null;
      if (this.mode === 'level') {
        this.mode = 'segment';
        this.render();
      }
      this.viewer.requestRender();
      return true;
    }
    return false;
  }

  activate(): void {
    this.mode = 'segment';
    this.panel.hidden = false;
    this.onStatus(t(this.locale, 'calibrate.hint'));
    this.render();
    this.viewer.requestRender();
  }

  deactivate(): void {
    this.mode = 'off';
    this.pending = null;
    this.levelPending = null;
    this.dragEndpoint = null;
    this.panel.hidden = true;
    this.viewer.requestRender();
  }

  exportState(): {
    segments: SavedCalibrationSegment[];
    scale?: { sx: number; sy: number; theta: number };
  } {
    return {
      segments: this.segments.map((s) => ({ ...s })),
      scale: this.result
        ? { sx: this.result.sx, sy: this.result.sy, theta: this.result.theta }
        : undefined,
    };
  }

  importState(state: {
    segments: SavedCalibrationSegment[];
    scale?: { sx: number; sy: number; theta: number };
  }): void {
    this.segments = state.segments.map((s) => ({ ...s }));
    if (state.scale) {
      this.viewer.setWorldScale(state.scale.sx, state.scale.sy);
      this.solve();
    } else {
      this.result = null;
      this.viewer.setWorldScale(1, 1);
    }
    if (this.isActive()) this.render();
    this.viewer.requestRender();
  }

  /** Sub-pixel snap to a dark ridge within `r = 6 px` unless disabled or `altKey` is pressed. */
  private snapRasterPoint(pt: { x: number; y: number }, altKey = false): { x: number; y: number } {
    if (!this.snapEnabled || altKey || !this.grayCache) return pt;
    const { data, width, height } = this.grayCache;
    const r = 6;
    const u0 = Math.max(1, Math.floor(pt.x - r));
    const u1 = Math.min(width - 2, Math.ceil(pt.x + r));
    const v0 = Math.max(1, Math.floor(pt.y - r));
    const v1 = Math.min(height - 2, Math.ceil(pt.y + r));

    let bestScore = 0;
    let bestU = pt.x;
    let bestV = pt.y;
    for (let v = v0; v <= v1; v += 1) {
      for (let u = u0; u <= u1; u += 1) {
        const dist = Math.hypot(u + 0.5 - pt.x, v + 0.5 - pt.y);
        if (dist > r) continue;
        const darkness = 255 - data[v * width + u];
        if (darkness < 30) continue;
        const score = darkness / (1 + 0.25 * dist);
        if (score > bestScore) {
          bestScore = score;
          const dL = 255 - data[v * width + (u - 1)];
          const dR = 255 - data[v * width + (u + 1)];
          const dU = 255 - data[(v - 1) * width + u];
          const dD = 255 - data[(v + 1) * width + u];
          const denomX = dL - 2 * darkness + dR;
          const denomY = dU - 2 * darkness + dD;
          const dx = Math.abs(denomX) > 1e-3 ? Math.max(-0.5, Math.min(0.5, (0.5 * (dL - dR)) / denomX)) : 0;
          const dy = Math.abs(denomY) > 1e-3 ? Math.max(-0.5, Math.min(0.5, (0.5 * (dU - dD)) / denomY)) : 0;
          bestU = u + 0.5 + dx;
          bestV = v + 0.5 + dy;
        }
      }
    }
    return bestScore > 0 ? { x: bestU, y: bestV } : pt;
  }

  /** Drag an existing segment endpoint on the canvas. */
  handleDrag(clientX: number, clientY: number, phase: 'start' | 'move' | 'end'): boolean {
    if (this.mode === 'off' || this.pending || this.levelPending) return false;
    const rect = this.panel.ownerDocument.getElementById('viewer')?.getBoundingClientRect();
    const sx = rect ? clientX - rect.left : clientX;
    const sy = rect ? clientY - rect.top : clientY;

    if (phase === 'start') {
      const to = this.viewer.rasterToScreen.bind(this.viewer);
      for (let i = 0; i < this.segments.length; i += 1) {
        const seg = this.segments[i];
        const a = to(seg.ax, seg.ay);
        if (Math.hypot(a.x - sx, a.y - sy) <= 10) {
          this.dragEndpoint = { segIndex: i, end: 'a' };
          return true;
        }
        const b = to(seg.bx, seg.by);
        if (Math.hypot(b.x - sx, b.y - sy) <= 10) {
          this.dragEndpoint = { segIndex: i, end: 'b' };
          return true;
        }
      }
      return false;
    }

    if (phase === 'move' && this.dragEndpoint) {
      const r = this.viewer.clientToRaster(clientX, clientY);
      if (r) {
        const snapped = this.snapRasterPoint(r);
        const seg = this.segments[this.dragEndpoint.segIndex];
        if (seg) {
          if (this.dragEndpoint.end === 'a') {
            seg.ax = snapped.x;
            seg.ay = snapped.y;
          } else {
            seg.bx = snapped.x;
            seg.by = snapped.y;
          }
          this.viewer.requestRender();
        }
      }
      return true;
    }

    if (phase === 'end' && this.dragEndpoint) {
      this.dragEndpoint = null;
      this.autoSolveAndApply();
      this.render();
      this.onChange?.();
      return true;
    }
    return false;
  }

  /** Handle a viewer click; returns true when the click was consumed. */
  handleClick(clientX: number, clientY: number, altKey = false): boolean {
    if (this.mode === 'off') return false;
    const rawRaster = this.viewer.clientToRaster(clientX, clientY);
    if (!rawRaster) return true;
    const raster = this.snapRasterPoint(rawRaster, altKey);

    if (this.mode === 'level') {
      if (!this.levelPending) {
        this.levelPending = raster;
        this.onStatus(t(this.locale, 'calibrate.level.hint'));
      } else {
        const a = this.levelPending;
        const alpha = Math.atan2(raster.y - a.y, raster.x - a.x);
        // Snap the clicked line to the nearest horizontal or vertical axis (within ±45°).
        const nearestAxis = Math.round(alpha / (Math.PI / 2)) * (Math.PI / 2);
        const tilt = alpha - nearestAxis;
        this.rotation = -tilt;
        this.levelPending = null;
        this.mode = 'segment';
        this.applyTransform();
        this.onStatus(
          tf(this.locale, 'calibrate.leveled', {
            deg: ((this.rotation * 180) / Math.PI).toFixed(1),
          }),
        );
        this.render();
        this.onChange?.();
      }
      this.viewer.requestRender();
      return true;
    }

    // Segment mode: two clicks per segment.
    if (!this.pending) {
      this.pending = raster;
      this.onStatus(t(this.locale, 'calibrate.hint'));
    } else {
      const a = this.pending;
      this.pending = null;
      if (Math.hypot(raster.x - a.x, raster.y - a.y) < 1) {
        return true;
      }
      const newIndex = this.segments.length;
      this.segments.push({
        ax: a.x,
        ay: a.y,
        bx: raster.x,
        by: raster.y,
        lengthText: '100',
        orientation: { type: 'free' },
        included: true,
      });
      this.autoSolveAndApply();
      this.onStatus(t(this.locale, 'status.ready'));
      this.render();
      // Auto-focus and select the new segment's length input for immediate typing.
      const input = this.panel.querySelector<HTMLInputElement>(`.cal-length[data-index="${newIndex}"]`);
      if (input) {
        input.focus();
        input.select();
      }
      this.onChange?.();
    }
    this.viewer.requestRender();
    return true;
  }

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (this.mode === 'off' && this.segments.length === 0) return;
    const s = this.viewer.rasterToScreen.bind(this.viewer);
    const accent =
      getComputedStyle(this.panel).getPropertyValue('--color-accent').trim() || '#2465c7';

    ctx.save();
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;
    ctx.lineWidth = 1.75;
    ctx.font = '12px Arial, sans-serif';

    // Placed segments.
    this.segments.forEach((seg, i) => {
      const a = s(seg.ax, seg.ay);
      const b = s(seg.bx, seg.by);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      this.dot(ctx, a.x, a.y, 4);
      this.dot(ctx, b.x, b.y, 4);
      const pxLen = Math.hypot(seg.bx - seg.ax, seg.by - seg.ay);
      const label = `#${i + 1}: ${seg.lengthText} (${pxLen.toFixed(1)} px)`;
      const mx = (a.x + b.x) / 2 + 6;
      const my = (a.y + b.y) / 2 - 6;
      ctx.fillText(label, mx, my);
    });

    // Pending point + live rubber-band line to cursor.
    const activePending = this.pending ?? this.levelPending;
    if (activePending) {
      const a = s(activePending.x, activePending.y);
      this.dot(ctx, a.x, a.y, 4.5);
      if (this.lastMouse) {
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(this.lastMouse.x, this.lastMouse.y);
        ctx.stroke();
        ctx.restore();

        const rect = ctx.canvas.getBoundingClientRect();
        const curRaster = this.viewer.clientToRaster(
          rect.left + this.lastMouse.x,
          rect.top + this.lastMouse.y,
        );
        if (curRaster) {
          const dPx = Math.hypot(curRaster.x - activePending.x, curRaster.y - activePending.y);
          const deg =
            (Math.atan2(curRaster.y - activePending.y, curRaster.x - activePending.x) * 180) /
            Math.PI;
          ctx.fillText(
            `${dPx.toFixed(1)} px · ${deg.toFixed(2)}°`,
            this.lastMouse.x + 10,
            this.lastMouse.y - 10,
          );
        }
      }
    }

    // 8× Magnifying Loupe around the cursor (Prompt.txt §6).
    if (this.mode !== 'off' && this.loupeEnabled && this.lastMouse) {
      this.drawLoupe(ctx, this.lastMouse.x, this.lastMouse.y, accent);
    }

    ctx.restore();
  }

  private drawLoupe(
    ctx: CanvasRenderingContext2D,
    mouseX: number,
    mouseY: number,
    accent: string,
  ): void {
    const page = this.viewer.getPage();
    if (!page || page.levels.length === 0) return;
    const rect = ctx.canvas.getBoundingClientRect();
    const rasterPt = this.viewer.clientToRaster(rect.left + mouseX, rect.top + mouseY);
    if (!rasterPt) return;

    const radius = 44;
    const cx = Math.max(radius + 16, ctx.canvas.clientWidth - radius - 20);
    const cy = 72 + radius;
    const srcSpan = (radius * 2) / 8; // 8× magnification
    const level0 = page.levels[0];
    const col = Math.floor(rasterPt.x / TILE_SIZE);
    const row = Math.floor(rasterPt.y / TILE_SIZE);
    if (col < 0 || row < 0 || col >= level0.tileCols || row >= level0.tileRows) return;
    const tile = level0.tiles[tileIndex(level0, col, row)];
    if (!tile) return;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

    const localX = rasterPt.x - col * TILE_SIZE;
    const localY = rasterPt.y - row * TILE_SIZE;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      tile,
      localX - srcSpan / 2,
      localY - srcSpan / 2,
      srcSpan,
      srcSpan,
      cx - radius,
      cy - radius,
      radius * 2,
      radius * 2,
    );

    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  private autoSolveAndApply(): void {
    const solverSegments = this.buildSolverSegments();
    if (!solverSegments || solverSegments.length === 0) return;
    this.solve();
    if (this.result) {
      this.viewer.setWorldScale(this.result.sx, this.result.sy);
      if (this.result.hasOrientedSegment) {
        this.rotation = -this.result.theta;
        this.applyTransform();
      }
    }
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

    const rotatedTheta = solveRotation(solverSegments);
    const hasOrientedSegment = rotatedTheta !== null;
    const theta = rotatedTheta ?? -this.rotation;
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
    const looScales = leaveOneOutIsotropic(solverSegments);
    const page = this.getPageSize();
    const pageDiagonal = page ? Math.hypot(page.width, page.height) : 0;
    const warnings = isotropicWarnings(solverSegments, residuals, pageDiagonal);

    this.result = {
      theta,
      sx,
      sy,
      isotropic: isIso,
      hasOrientedSegment,
      residuals: residuals.map((r, i) => ({
        lengthText: solverSegments[i].length.toString(),
        residualMm: r.residualMm,
        residualPct: r.residualPct,
      })),
      looScales,
      warnings,
    };
    this.viewer.setWorldScale(sx, sy);
    this.onStatus(t(this.locale, 'status.ready'));
    this.render();
    this.onChange?.();
  }

  apply(): void {
    if (!this.result) {
      this.solve();
    }
    if (!this.result) return;
    // Only overwrite rotation if at least one segment has an orientation constraint.
    if (this.result.hasOrientedSegment) {
      this.rotation = -this.result.theta;
    }
    this.viewer.setWorldScale(this.result.sx, this.result.sy);
    this.applyTransform();
    this.render();
    this.onStatus(t(this.locale, 'status.ready'));
    this.onChange?.();
  }

  reset(): void {
    this.segments = [];
    this.pending = null;
    this.levelPending = null;
    this.rotation = 0;
    this.flipH = false;
    this.flipV = false;
    this.result = null;
    this.viewer.resetRasterTransform();
    this.render();
    this.onStatus(t(this.locale, 'status.ready'));
    this.onChange?.();
  }

  private applyTransform(): void {
    const page = this.getPageSize();
    const cx = page ? page.width / 2 : 0;
    const cy = page ? page.height / 2 : 0;
    const cosT = Math.cos(this.rotation);
    const sinT = Math.sin(this.rotation);
    const sx = this.flipH ? -1 : 1;
    const sy = this.flipV ? -1 : 1;
    // Standard 2D clockwise screen rotation by `this.rotation` around `(cx, cy)`:
    // x' = cos(r)*x - sin(r)*y, y' = sin(r)*x + cos(r)*y.
    const a = cosT * sx;
    const b = sinT * sx;
    const c = -sinT * sy;
    const d = cosT * sy;
    const t: Affine = [
      a,
      b,
      c,
      d,
      cx - (a * cx + c * cy),
      cy - (b * cx + d * cy),
    ];
    this.viewer.setRasterTransform(t);
  }

  private buildSolverSegments(): CalibrationSegment[] | null {
    const out: CalibrationSegment[] = [];
    for (const seg of this.segments) {
      if (!seg.included) continue;
      const length = parseLength(seg.lengthText);
      if (length === null) return null;
      const s: CalibrationSegment = {
        ax: seg.ax,
        ay: seg.ay,
        bx: seg.bx,
        by: seg.by,
        length,
        orientation: seg.orientation,
      };
      if (pixelLength(s) > 0) out.push(s);
    }
    return out;
  }

  private render(): void {
    const locale = this.locale;
    const disp = this.viewer.getDisplayOptions();
    const rotDeg = (this.rotation * 180) / Math.PI;
    const sliderDeg = Math.max(-45, Math.min(45, rotDeg));

    this.panel.innerHTML = `
      <div class="panel-head">
        <h2 class="panel-title">${t(locale, 'calibrate.title')}</h2>
        <button id="cal-close" class="tool-btn" type="button" aria-label="${t(locale, 'calibrate.close')}">×</button>
      </div>
      <p class="cal-hint">${t(locale, this.mode === 'level' ? 'calibrate.level.hint' : 'calibrate.hint')}</p>
      <div class="cal-actions">
        <button id="cal-level" class="btn ${this.mode === 'level' ? 'btn-primary' : ''}" type="button">${t(locale, 'calibrate.level')}</button>
        <button id="cal-solve" class="btn btn-primary" type="button">${t(locale, 'calibrate.solve')}</button>
        <button id="cal-apply" class="btn" type="button">${t(locale, 'calibrate.apply')}</button>
        <button id="cal-reset" class="btn" type="button">${t(locale, 'calibrate.reset')}</button>
      </div>
      <div class="cal-actions">
        <label class="cal-label" for="cal-rot-input">${t(locale, 'calibrate.rotation')}</label>
        <input id="cal-rot-input" class="cal-length w-70" type="number" step="0.1" value="${rotDeg.toFixed(2)}" aria-label="${t(locale, 'calibrate.rotation')}" />
        <input id="cal-rot-slider" type="range" min="-45" max="45" step="0.05" value="${sliderDeg.toFixed(2)}" class="flex-1 min-w-90" aria-label="${t(locale, 'calibrate.rotation')}" />
      </div>
      <div class="cal-actions">
        <button id="cal-rot-m90" class="btn" type="button" title="-90°">−90°</button>
        <button id="cal-rot-m1" class="btn" type="button" title="-1°">−1°</button>
        <button id="cal-rot-minus" class="btn" type="button" title="-0.1°">${t(locale, 'calibrate.bg.rotMinus')}</button>
        <button id="cal-rot-0" class="btn" type="button" title="0°">0°</button>
        <button id="cal-rot-plus" class="btn" type="button" title="+0.1°">${t(locale, 'calibrate.bg.rotPlus')}</button>
        <button id="cal-rot-p1" class="btn" type="button" title="+1°">+1°</button>
        <button id="cal-rot-p90" class="btn" type="button" title="+90°">+90°</button>
      </div>
      <div class="cal-actions">
        <button id="cal-flip-h" class="btn ${this.flipH ? 'btn-primary' : ''}" type="button">${t(locale, 'calibrate.bg.flipH')}</button>
        <button id="cal-flip-v" class="btn ${this.flipV ? 'btn-primary' : ''}" type="button">${t(locale, 'calibrate.bg.flipV')}</button>
        <label class="cal-label"><input id="cal-snap" type="checkbox" ${this.snapEnabled ? 'checked' : ''} /> ${t(locale, 'calibrate.snap')}</label>
        <label class="cal-label"><input id="cal-loupe" type="checkbox" ${this.loupeEnabled ? 'checked' : ''} /> ${t(locale, 'calibrate.loupe')}</label>
        <label class="cal-label"><input id="cal-invert" type="checkbox" ${disp.invert ? 'checked' : ''} /> ${t(locale, 'calibrate.bg.invert')}</label>
      </div>
      <div class="cal-actions">
        <label class="cal-label" for="cal-opacity-slider">${t(locale, 'calibrate.bg.opacity')}</label>
        <input id="cal-opacity-slider" type="range" min="0" max="1" step="0.05" value="${disp.opacity.toFixed(2)}" class="flex-1 min-w-80" aria-label="${t(locale, 'calibrate.bg.opacity')}" />
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
      this.mode = this.mode === 'level' ? 'segment' : 'level';
      this.levelPending = null;
      this.pending = null;
      this.onStatus(t(this.locale, this.mode === 'level' ? 'calibrate.level.hint' : 'calibrate.hint'));
      this.render();
    });

    const setDeg = (deg: number, rerender = true): void => {
      if (!Number.isFinite(deg)) return;
      this.rotation = (deg * Math.PI) / 180;
      this.applyTransform();
      if (rerender) {
        this.render();
      } else {
        const numEl = this.panel.querySelector<HTMLInputElement>('#cal-rot-input');
        if (numEl) numEl.value = deg.toFixed(2);
      }
      this.onChange?.();
    };

    this.panel.querySelector<HTMLInputElement>('#cal-rot-input')!.addEventListener('change', (e) => {
      setDeg(Number.parseFloat((e.target as HTMLInputElement).value), true);
    });
    this.panel.querySelector<HTMLInputElement>('#cal-rot-slider')!.addEventListener('input', (e) => {
      setDeg(Number.parseFloat((e.target as HTMLInputElement).value), false);
    });
    this.panel.querySelector('#cal-rot-m90')!.addEventListener('click', () => setDeg(rotDeg - 90));
    this.panel.querySelector('#cal-rot-m1')!.addEventListener('click', () => setDeg(rotDeg - 1));
    this.panel.querySelector('#cal-rot-minus')!.addEventListener('click', () => setDeg(rotDeg - 0.1));
    this.panel.querySelector('#cal-rot-0')!.addEventListener('click', () => setDeg(0));
    this.panel.querySelector('#cal-rot-plus')!.addEventListener('click', () => setDeg(rotDeg + 0.1));
    this.panel.querySelector('#cal-rot-p1')!.addEventListener('click', () => setDeg(rotDeg + 1));
    this.panel.querySelector('#cal-rot-p90')!.addEventListener('click', () => setDeg(rotDeg + 90));

    this.panel.querySelector('#cal-flip-h')!.addEventListener('click', () => {
      this.flipH = !this.flipH;
      this.applyTransform();
      this.render();
      this.onChange?.();
    });
    this.panel.querySelector('#cal-flip-v')!.addEventListener('click', () => {
      this.flipV = !this.flipV;
      this.applyTransform();
      this.render();
      this.onChange?.();
    });
    this.panel.querySelector<HTMLInputElement>('#cal-snap')!.addEventListener('change', (e) => {
      this.snapEnabled = (e.target as HTMLInputElement).checked;
    });
    this.panel.querySelector<HTMLInputElement>('#cal-loupe')!.addEventListener('change', (e) => {
      this.loupeEnabled = (e.target as HTMLInputElement).checked;
      this.viewer.requestRender();
    });
    this.panel.querySelector<HTMLInputElement>('#cal-invert')!.addEventListener('change', (e) => {
      this.viewer.setDisplayOptions({ invert: (e.target as HTMLInputElement).checked });
    });
    this.panel.querySelector<HTMLInputElement>('#cal-opacity-slider')!.addEventListener('input', (e) => {
      this.viewer.setDisplayOptions({ opacity: Number.parseFloat((e.target as HTMLInputElement).value) });
    });

    this.panel.querySelectorAll<HTMLInputElement>('.cal-include').forEach((el) => {
      const i = Number(el.dataset.index);
      el.addEventListener('change', () => {
        this.segments[i].included = el.checked;
        this.autoSolveAndApply();
        this.onChange?.();
      });
    });
    this.panel.querySelectorAll<HTMLInputElement>('.cal-length').forEach((el) => {
      if (el.id === 'cal-rot-input') return;
      const i = Number(el.dataset.index);
      if (!Number.isFinite(i)) return;
      el.addEventListener('change', () => {
        this.segments[i].lengthText = el.value;
        this.autoSolveAndApply();
        this.viewer.requestRender();
        this.onChange?.();
      });
    });
    this.panel.querySelectorAll<HTMLSelectElement>('.cal-orientation').forEach((el) => {
      const i = Number(el.dataset.index);
      el.addEventListener('change', () => {
        this.segments[i].orientation = orientationFromValue(el.value);
        this.autoSolveAndApply();
        this.render();
        this.onChange?.();
      });
    });
    this.panel.querySelectorAll<HTMLInputElement>('.cal-angle-deg').forEach((el) => {
      const i = Number(el.dataset.index);
      el.addEventListener('change', () => {
        const deg = Number.parseFloat(el.value);
        if (Number.isFinite(deg)) {
          this.segments[i].orientation = { type: 'angle', angle: (deg * Math.PI) / 180 };
          this.autoSolveAndApply();
          this.onChange?.();
        }
      });
    });
    this.panel.querySelectorAll<HTMLButtonElement>('.cal-delete').forEach((el) => {
      const i = Number(el.dataset.index);
      el.addEventListener('click', () => {
        this.segments.splice(i, 1);
        this.autoSolveAndApply();
        this.render();
        this.viewer.requestRender();
        this.onChange?.();
      });
    });
  }

  private segmentRow(seg: SegmentDraft, i: number): string {
    const locale = this.locale;
    const angleInput =
      seg.orientation.type === 'angle'
        ? `<input class="cal-angle-deg cal-length w-52" type="number" step="0.1" data-index="${i}" value="${((seg.orientation.angle * 180) / Math.PI).toFixed(1)}" aria-label="${t(locale, 'calibrate.angle')}" />`
        : '';
    return `
      <li class="cal-segment">
        <input class="cal-include" type="checkbox" data-index="${i}" ${seg.included ? 'checked' : ''} title="${t(locale, 'calibrate.include')}" />
        <span class="cal-label">#${i + 1}</span>
        <input class="cal-length" type="text" data-index="${i}" value="${escapeHtml(seg.lengthText)}" aria-label="${t(locale, 'calibrate.length')}" />
        <select class="cal-orientation" data-index="${i}" aria-label="${t(locale, 'calibrate.orientation')}">
          ${orientationOptions(seg.orientation, locale)}
        </select>
        ${angleInput}
        <button class="cal-delete tool-btn" type="button" data-index="${i}" aria-label="${t(locale, 'calibrate.close')}">×</button>
      </li>`;
  }

  private resultHtml(): string {
    const locale = this.locale;
    const r = this.result;
    if (!r) return `<p class="cal-empty">${t(locale, 'calibrate.result.none')}</p>`;

    const scaleText = r.isotropic
      ? `${formatMm(r.sx)}/px`
      : `sx ${formatMm(r.sx)}/px · sy ${formatMm(r.sy)}/px`;
    const residualLines = r.residuals
      .map(
        (res, i) =>
          `<li>${tf(locale, 'calibrate.segment', { n: i + 1 })}: ${res.residualMm >= 0 ? '+' : ''}${res.residualMm.toFixed(2)} mm (${res.residualPct.toFixed(3)} %)</li>`,
      )
      .join('');
    const looLines =
      r.looScales.length >= 2
        ? r.looScales
            .map((s, i) =>
              Number.isFinite(s)
                ? `<li>LOO −#${i + 1}: ${formatMm(s)}/px</li>`
                : '',
            )
            .join('')
        : '';
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
      ${looLines ? `<p class="cal-subhead">${t(locale, 'calibrate.result.loo')}</p><ul class="cal-residuals">${looLines}</ul>` : ''}
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

  private dot(ctx: CanvasRenderingContext2D, x: number, y: number, radius = 3.5): void {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function orientationFromValue(value: string): SegmentOrientation {
  if (value === 'horizontal') return { type: 'horizontal' };
  if (value === 'vertical') return { type: 'vertical' };
  if (value === 'angle') return { type: 'angle', angle: Math.PI / 4 };
  return { type: 'free' };
}

function orientationOptions(orientation: SegmentOrientation, locale: Locale): string {
  const current = orientation.type;
  return `
    <option value="free" ${current === 'free' ? 'selected' : ''}>${t(locale, 'calibrate.free')}</option>
    <option value="horizontal" ${current === 'horizontal' ? 'selected' : ''}>${t(locale, 'calibrate.horizontal')}</option>
    <option value="vertical" ${current === 'vertical' ? 'selected' : ''}>${t(locale, 'calibrate.vertical')}</option>
    <option value="angle" ${current === 'angle' ? 'selected' : ''}>${t(locale, 'calibrate.angle')}</option>`;
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
