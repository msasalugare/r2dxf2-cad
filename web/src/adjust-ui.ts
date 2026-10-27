// Image adjustments panel: server-side preprocessing (sharpness / contrast /
// colour balance) plus a display-only opacity control.
//
// The server re-processes the original raster and re-detects ridges when the
// preprocessing sliders change (debounced); opacity is composited client-side
// by the viewer and never re-runs analysis.

import {
  adjustRaster,
  DEFAULT_ADJUSTMENTS,
  getActiveRasterSession,
  type NativeRasterSession,
  type RasterAdjustments,
} from './backend';
import { t, type Locale } from './i18n';
import type { RasterViewer } from './viewer';

const DEFAULT_OPACITY = 0.72;
const DEBOUNCE_MS = 400;

export class AdjustController {
  private active = false;
  private adjustments: RasterAdjustments = cloneAdjustments(DEFAULT_ADJUSTMENTS);
  private debounce: number | null = null;

  constructor(
    private readonly viewer: RasterViewer,
    private readonly panel: HTMLElement,
    private readonly locale: Locale,
    private readonly setStatus: (msg: string, isError?: boolean) => void,
    private readonly onAdjusted: (session: NativeRasterSession) => void,
  ) {}

  isActive(): boolean {
    return this.active;
  }

  activate(): void {
    this.active = true;
    this.syncFromSession();
    this.panel.hidden = false;
    this.render();
    this.viewer.requestRender();
  }

  deactivate(): void {
    this.active = false;
    this.panel.hidden = true;
    this.cancelDebounce();
    this.viewer.requestRender();
  }

  /** Pull the current server-side adjustments from the active session. */
  syncFromSession(): void {
    const s = getActiveRasterSession();
    this.adjustments = s?.adjustments
      ? cloneAdjustments(s.adjustments)
      : cloneAdjustments(DEFAULT_ADJUSTMENTS);
  }

  /** Re-sync from the active session and re-render if the panel is open. */
  refresh(): void {
    this.syncFromSession();
    if (this.active) this.render();
  }

  private cancelDebounce(): void {
    if (this.debounce !== null) {
      clearTimeout(this.debounce);
      this.debounce = null;
    }
  }

  private setProcessing(on: boolean): void {
    const el = this.panel.querySelector<HTMLElement>('#adjust-processing');
    if (el) el.hidden = !on;
  }

  private render(): void {
    const locale = this.locale;
    const disp = this.viewer.getDisplayOptions();
    const a = this.adjustments;
    const cb = a.colour_balance;

    this.panel.innerHTML = `
      <div class="panel-head">
        <h2 class="panel-title">${t(locale, 'adjust.title')}</h2>
        <button id="adjust-close" class="tool-btn" type="button" aria-label="${t(locale, 'calibrate.close')}">×</button>
      </div>
      <p class="panel-hint">${t(locale, 'adjust.hint')}</p>

      <div class="cal-actions">
        <label class="cal-label" for="adjust-contrast">${t(locale, 'adjust.contrast')}</label>
        <input id="adjust-contrast" type="range" min="0.5" max="2" step="0.05" value="${a.contrast}" class="flex-1" />
      </div>
      <div class="cal-actions">
        <label class="cal-label" for="adjust-sharpness">${t(locale, 'adjust.sharpness')}</label>
        <input id="adjust-sharpness" type="range" min="0" max="3" step="0.1" value="${a.sharpness}" class="flex-1" />
      </div>
      <div class="cal-actions">
        <label class="cal-label">${t(locale, 'adjust.colourBalance')}</label>
      </div>
      <div class="cal-actions">
        <label class="cal-label" for="adjust-r">R</label>
        <input id="adjust-r" type="range" min="0.5" max="2" step="0.05" value="${cb.r}" class="flex-1" />
      </div>
      <div class="cal-actions">
        <label class="cal-label" for="adjust-g">G</label>
        <input id="adjust-g" type="range" min="0.5" max="2" step="0.05" value="${cb.g}" class="flex-1" />
      </div>
      <div class="cal-actions">
        <label class="cal-label" for="adjust-b">B</label>
        <input id="adjust-b" type="range" min="0.5" max="2" step="0.05" value="${cb.b}" class="flex-1" />
      </div>
      <div class="cal-actions">
        <label class="cal-label" for="adjust-opacity">${t(locale, 'adjust.opacity')}</label>
        <input id="adjust-opacity" type="range" min="0" max="1" step="0.05" value="${disp.opacity.toFixed(2)}" class="flex-1" />
      </div>
      <div class="cal-actions">
        <button id="adjust-reset" class="btn" type="button">${t(locale, 'adjust.reset')}</button>
        <span id="adjust-processing" class="panel-hint" hidden>${t(locale, 'adjust.processing')}</span>
      </div>
    `;

    this.panel.querySelector('#adjust-close')!.addEventListener('click', () => this.deactivate());

    const bindServerSlider = (id: string, apply: (v: number) => void): void => {
      const el = this.panel.querySelector<HTMLInputElement>(id);
      el?.addEventListener('input', (e) => {
        apply(Number.parseFloat((e.target as HTMLInputElement).value));
        this.scheduleApply();
      });
    };

    bindServerSlider('#adjust-contrast', (v) => {
      this.adjustments.contrast = v;
    });
    bindServerSlider('#adjust-sharpness', (v) => {
      this.adjustments.sharpness = v;
    });
    bindServerSlider('#adjust-r', (v) => {
      this.adjustments.colour_balance.r = v;
    });
    bindServerSlider('#adjust-g', (v) => {
      this.adjustments.colour_balance.g = v;
    });
    bindServerSlider('#adjust-b', (v) => {
      this.adjustments.colour_balance.b = v;
    });

    // Opacity is display-only: apply live, no server round-trip.
    this.panel.querySelector<HTMLInputElement>('#adjust-opacity')!.addEventListener('input', (e) => {
      this.viewer.setDisplayOptions({ opacity: Number.parseFloat((e.target as HTMLInputElement).value) });
    });

    this.panel.querySelector('#adjust-reset')!.addEventListener('click', () => {
      this.adjustments = cloneAdjustments(DEFAULT_ADJUSTMENTS);
      this.viewer.setDisplayOptions({ opacity: DEFAULT_OPACITY });
      this.render();
      void this.applyNow();
    });
  }

  private scheduleApply(): void {
    this.cancelDebounce();
    this.setProcessing(true);
    this.debounce = window.setTimeout(() => {
      this.debounce = null;
      void this.applyNow();
    }, DEBOUNCE_MS);
  }

  private async applyNow(): Promise<void> {
    this.cancelDebounce();
    const s = getActiveRasterSession();
    if (!s) return;
    this.setProcessing(true);
    try {
      const session = await adjustRaster(s.raster_id, this.adjustments);
      if (session) this.onAdjusted(session);
      else this.setStatus(t(this.locale, 'error.server'), true);
    } catch {
      this.setStatus(t(this.locale, 'error.server'), true);
    } finally {
      this.setProcessing(false);
    }
  }
}

function cloneAdjustments(a: RasterAdjustments): RasterAdjustments {
  return {
    contrast: a.contrast,
    sharpness: a.sharpness,
    colour_balance: { ...a.colour_balance },
  };
}
