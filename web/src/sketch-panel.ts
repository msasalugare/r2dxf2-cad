// Side-panel DOM rendering & event wiring for the sketch editor.
// Consumes the controller's public (internal) state — see sketch-ui.ts.

import { t, tf } from './i18n';
import { isDimensionKey } from './sketch-dimensions';
import { toggleInArray } from './sketch-geometry';
import type { SketchController } from './sketch-ui';

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

export function renderSketchPanel(sk: SketchController): void {
    const locale = sk.locale;
    const dof = sk.getDof();
    const redundant = sk.lastSolve?.redundant ?? [];
    const conflicting = sk.lastSolve?.conflicting ?? [];

    const solverBannerHtml =
      conflicting.length > 0
        ? `<button id="sketch-remove-conflict" class="btn sketch-banner sketch-banner-conflict" type="button">⚠ ${tf(locale, 'sketch.conflictWarn', { list: conflicting.map((i) => `#${i + 1}`).join(', ') })}</button>`
        : redundant.length > 0
          ? `<button id="sketch-remove-redundant" class="btn sketch-banner sketch-banner-redundant" type="button">⚠ ${tf(locale, 'sketch.redundantWarn', { list: redundant.map((i) => `#${i + 1}`).join(', ') })}</button>`
          : dof === 0 && sk.points.length > 0
            ? `<div class="sketch-status sketch-status-ok">✓ ${t(locale, 'sketch.fullyConstrained')}</div>`
            : `<div class="sketch-status sketch-status-hint">${tf(locale, 'sketch.underConstrained', { dof })}</div>`;

    const selectionSummary = [
      ...sk.selectedPoints.map((id) => `Pt#${id}`),
      ...sk.selectedLines.map((id) => `Ln#${id}`),
      ...sk.selectedCircles.map((id) => `Cir#${id}`),
      ...sk.selectedArcs.map((id) => `Arc#${id}`),
    ].join(', ');

    const constraintsHtml = sk.constraints
      .map((c, idx) => {
        const key = Object.keys(c)[0] ?? 'Ograničenje';
        const val = JSON.stringify((c as Record<string, unknown>)[key]);
        const isRef = sk.referenceConstraints.includes(idx);
        const isConflict = conflicting.includes(idx);
        const isRedundant = redundant.includes(idx);
        return `
          <li class="cal-segment${isConflict ? ' segment-conflict' : isRedundant ? ' segment-redundant' : ''}">
            <input type="checkbox" class="sketch-c-ref" data-index="${idx}" ${!isRef ? 'checked' : ''} title="Aktivno" />
            <span class="cal-label">#${idx + 1} ${escapeHtml(key)} ${escapeHtml(val)}</span>
            <button class="sketch-c-del tool-btn cal-delete" type="button" data-index="${idx}" aria-label="Obriši">×</button>
          </li>`;
      })
      .join('');

    const dimensionEditorHtml = (() => {
      const idx = sk.editingConstraintIdx;
      if (idx === null) return '';
      const constraint = sk.constraints[idx];
      const key = constraint ? Object.keys(constraint)[0] : undefined;
      if (!constraint || !key || !isDimensionKey(key) || sk.referenceConstraints.includes(idx)) return '';
      const value = sk.dimensionDisplayValue(constraint, idx);
      if (value === null) return '';
      const unit = key === 'Angle' || key === 'AngleLine' ? '°' : 'mm';
      const label = tf(locale, 'sketch.editDimension', { index: idx + 1, unit });
      return `
        <div class="sketch-toolbar-box sketch-dimension-editor">
          <label class="cal-label" for="sketch-dimension-value">${escapeHtml(label)}</label>
          <div class="cal-actions">
            <input id="sketch-dimension-value" class="cal-length" type="number" step="any" value="${value.toFixed(3)}" />
            <button id="sketch-dimension-apply" class="btn btn-primary" type="button">${t(locale, 'calibrate.apply')}</button>
            <button id="sketch-dimension-cancel" class="btn" type="button">${t(locale, 'account.cancel')}</button>
          </div>
        </div>`;
    })();

    const elementsHtml = [
      ...sk.lines.map(
        (l) =>
          `<li class="cal-segment"><span class="cal-label">Linija #${l.id} (P${l.a}→P${l.b})${l.construction ? ' [C]' : ''}</span><button class="sketch-el-sel btn" type="button" data-kind="line" data-id="${l.id}">${sk.selectedLines.includes(l.id) ? '✓' : 'Izb'}</button></li>`,
      ),
      ...sk.circles.map(
        (c) =>
          `<li class="cal-segment"><span class="cal-label">Kružnica #${c.id} (R=${c.radius.toFixed(1)})${c.construction ? ' [C]' : ''}</span><button class="sketch-el-sel btn" type="button" data-kind="circle" data-id="${c.id}">${sk.selectedCircles.includes(c.id) ? '✓' : 'Izb'}</button></li>`,
      ),
      ...sk.arcs.map(
        (a) =>
          `<li class="cal-segment"><span class="cal-label">Luk #${a.id} (R=${a.radius.toFixed(1)})${a.construction ? ' [C]' : ''}</span><button class="sketch-el-sel btn" type="button" data-kind="arc" data-id="${a.id}">${sk.selectedArcs.includes(a.id) ? '✓' : 'Izb'}</button></li>`,
      ),
    ].join('');

    const orig = sk.viewer.getOrigin();

    sk.panel.innerHTML = `
      <div class="panel-head">
        <h2 class="panel-title">${t(locale, 'sketch.title')}</h2>
        <button id="sketch-close" class="tool-btn" type="button" aria-label="${t(locale, 'calibrate.close')}">×</button>
      </div>
      ${solverBannerHtml}
      <p class="cal-hint">${selectionSummary ? `Izb: ${escapeHtml(selectionSummary)}` : t(locale, sk.pending || sk.arcStartPending || sk.arc3PtPending ? 'sketch.finishChain' : 'sketch.hint')}</p>

      <details class="sketch-toolbar-box" role="group" open aria-label="Izbor i koordinatni sistem">
        <summary class="sketch-toolbar-title">1 · Izbor i koordinatni sistem (0,0)</summary>
        <div class="cal-actions">
          <button id="sketch-tool-select" class="btn ${sk.tool === 'select' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.select')}">↖ Izaberi / Pomeri (V)</button>
          <button id="sketch-tool-origin" class="btn ${sk.tool === 'origin' ? 'btn-tool-active' : ''}" type="button" title="Pomeri (0,0) koordinatni početak">🎯 Postavi (0,0) [${Math.round(orig.x)}, ${Math.round(orig.y)}]</button>
          <button id="sketch-origin-reset" class="btn" type="button" title="Resetuj (0,0) na donji levi ugao">↺ (0,0) Donji levi</button>
          <button id="sketch-undo" class="btn" type="button" title="${t(locale, 'sketch.undo')}">↶</button>
          <button id="sketch-redo" class="btn" type="button" title="${t(locale, 'sketch.redo')}">↷</button>
          <button id="sketch-delete" class="btn" type="button" title="${t(locale, 'sketch.delete')}">🗑</button>
        </div>
        <div class="cal-actions">
          <label class="cal-label"><input id="sketch-raster-snap" type="checkbox" ${sk.rasterSnapEnabled ? 'checked' : ''} /> 🧲 Snap na raster</label>
          <label class="cal-label"><input id="sketch-guide-snap" type="checkbox" ${sk.guideSnapEnabled ? 'checked' : ''} /> 🧲 Snap na guide</label>
          <label class="cal-label"><input id="sketch-pin-raster" type="checkbox" ${sk.autoPinRaster ? 'checked' : ''} /> 📌 Prikvači na raster</label>
          <label class="cal-label"><input id="sketch-loupe" type="checkbox" ${sk.loupeEnabled ? 'checked' : ''} /> 🔍 8×</label>
          <label class="cal-label"><input id="sketch-construction" type="checkbox" ${sk.constructionMode ? 'checked' : ''} /> ${t(locale, 'sketch.construction')}</label>
          <label class="cal-label"><input id="sketch-auto" type="checkbox" ${sk.autoConstraints ? 'checked' : ''} /> ${t(locale, 'sketch.autoConstraint')}</label>
          <label class="cal-label"><input id="sketch-grid-snap" type="checkbox" ${sk.viewer.isGridSnapEnabled() ? 'checked' : ''} /> ${t(locale, 'sketch.gridSnap')}</label>
        </div>
      </details>

      <details class="sketch-toolbar-box" role="group" open aria-label="Alati za geometriju">
        <summary class="sketch-toolbar-title">2 · Crtanje i izmena geometrije</summary>
        <div class="cal-actions">
          <button id="sketch-tool-polyline" class="btn ${sk.tool === 'polyline' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.polyline')}">Polilinija (P)</button>
          <button id="sketch-tool-line" class="btn ${sk.tool === 'line' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.line')}">╱ Linija (L)</button>
          <button id="sketch-tool-rect" class="btn ${sk.tool === 'rect' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.rect')}">▭ Pravougaonik (R)</button>
          <button id="sketch-tool-rounded-rect" class="btn ${sk.tool === 'roundedRect' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.roundedRect')}">▢ Zaoblj. prav.</button>
          <button id="sketch-tool-center-rect" class="btn ${sk.tool === 'centerRect' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.centerRect')}">⊡ C-Prav.</button>
          <button id="sketch-tool-slot" class="btn ${sk.tool === 'slot' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.slot')}">⬭ Slot (S)</button>
          <button id="sketch-tool-circle" class="btn ${sk.tool === 'circle' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.circle')}">◯ Kružnica (C)</button>
          <button id="sketch-tool-arc" class="btn ${sk.tool === 'arc' ? 'btn-tool-active' : ''}" type="button" title="Luk centar-početak-kraj (A)">◜ Luk C-P-K (A)</button>
          <button id="sketch-tool-arc3pt" class="btn ${sk.tool === 'arc3pt' ? 'btn-tool-active' : ''}" type="button" title="Luk 3 tačke (Shift+A ili M)">⌒ Luk 3T</button>
          <button id="sketch-tool-polygon" class="btn ${sk.tool === 'polygon' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.polygon')}">⬡ Poligon (G)</button>
          <button id="sketch-tool-fillet" class="btn ${sk.tool === 'fillet' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.fillet')}">╭ Zaobljenje (F)</button>
          <button id="sketch-tool-chamfer" class="btn ${sk.tool === 'chamfer' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.chamfer')}">╱ Kosa ivica</button>
          <button id="sketch-tool-trim" class="btn ${sk.tool === 'trim' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.trim')}">✂ Odseci (T)</button>
          <button id="sketch-tool-mirror" class="btn ${sk.tool === 'mirror' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.mirror')}">⇋ Ogledalo</button>
          <button id="sketch-tool-point" class="btn ${sk.tool === 'point' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.point')}">• Tačka (O)</button>
        </div>
        ${sk.tool === 'fillet' ? `
          <div class="cal-actions">
            <label class="cal-label" for="sketch-fillet-radius">${t(locale, 'sketch.fillet.radius')}</label>
            <input id="sketch-fillet-radius" class="cal-length" type="number" min="0" step="any" placeholder="auto" value="${sk.filletRadiusMm ?? ''}" />
          </div>` : sk.tool === 'chamfer' ? `
          <div class="cal-actions">
            <label class="cal-label" for="sketch-chamfer-d1">${t(locale, 'sketch.chamfer.d1')}</label>
            <input id="sketch-chamfer-d1" class="cal-length" type="number" min="0" step="any" value="${sk.chamferFirstMm}" />
            <label class="cal-label" for="sketch-chamfer-d2">${t(locale, 'sketch.chamfer.d2')}</label>
            <input id="sketch-chamfer-d2" class="cal-length" type="number" min="0" step="any" value="${sk.chamferSecondMm}" />
          </div>` : sk.tool === 'roundedRect' ? `
          <div class="cal-actions">
            <label class="cal-label" for="sketch-rounded-radius">${t(locale, 'sketch.roundedRect.radius')}</label>
            <input id="sketch-rounded-radius" class="cal-length" type="number" min="0" step="any" placeholder="auto" value="${sk.roundedRectRadiusMm ?? ''}" />
          </div>` : ''}
        ${
          sk.pending || sk.arcStartPending || sk.arc3PtPending
            ? `<div class="cal-actions"><button id="sketch-finish-chain" class="btn btn-primary" type="button">${t(locale, 'sketch.finishChain')}</button></div>`
            : ''
        }
      </details>

      <details class="sketch-toolbar-box" role="group" aria-label="Geometrijska ograničenja">
        <summary class="sketch-toolbar-title">3 · Geometrijska ograničenja</summary>
        <div class="cal-actions">
          <button class="btn sketch-fc-c" data-action="Coincident" type="button" title="Podudarnost (2 tačke)">● Podud.</button>
          <button class="btn sketch-fc-c" data-action="PointOnObject" type="button" title="Tačka na objektu">⟐ NaObj</button>
          <button class="btn sketch-fc-c" data-action="Horizontal" type="button" title="Horizontalno (H)">━ H</button>
          <button class="btn sketch-fc-c" data-action="Vertical" type="button" title="Vertikalno">┃ V</button>
          <button class="btn sketch-fc-c" data-action="Parallel" type="button" title="Paralelno">∥ Par</button>
          <button class="btn sketch-fc-c" data-action="Perpendicular" type="button" title="Normalno (N)">⊥ Norm</button>
          <button class="btn sketch-fc-c" data-action="Tangent" type="button" title="Tangenta">⌓ Tan</button>
          <button class="btn sketch-fc-c" data-action="Equal" type="button" title="Jednako (E)">= Jedn</button>
          <button class="btn sketch-fc-c" data-action="Symmetric" type="button" title="Simetrija">> <Sim</button>
          <button class="btn sketch-fc-c" data-action="Midpoint" type="button" title="Središte">M Sred</button>
          <button class="btn sketch-fc-c" data-action="Collinear" type="button" title="Kolinearno">∥ Kol</button>
          <button class="btn sketch-fc-c" data-action="Block" type="button" title="Fiksiraj na raster (B)">🔒 Fiks</button>
        </div>
      </details>

      <details class="sketch-toolbar-box" role="group" aria-label="Dimenziona ograničenja">
        <summary class="sketch-toolbar-title">4 · Dimenziona ograničenja</summary>
        <div class="cal-actions">
          <button class="btn sketch-fc-c" data-action="Distance" type="button" title="Rastojanje / dužina (D)">↔ Rast</button>
          <button class="btn sketch-fc-c" data-action="HorizontalDistance" type="button" title="Horizontalno rastojanje">ΔX</button>
          <button class="btn sketch-fc-c" data-action="VerticalDistance" type="button" title="Vertikalno rastojanje">ΔY</button>
          <button class="btn sketch-fc-c" data-action="Radius" type="button" title="Poluprečnik">R Pol</button>
          <button class="btn sketch-fc-c" data-action="Diameter" type="button" title="Prečnik">⌀ Pre</button>
          <button class="btn sketch-fc-c" data-action="Angle" type="button" title="Ugao">∠ Ugao</button>
        </div>
        <div class="cal-actions">
          <select id="sketch-c-type" class="cal-orientation" aria-label="${t(locale, 'sketch.constraints')}">
            <option value="Horizontal">Horizontalno (linija)</option>
            <option value="Vertical">Vertikalno (linija)</option>
            <option value="HorizontalPoints">Horizontalno (p1, p2)</option>
            <option value="VerticalPoints">Vertikalno (p1, p2)</option>
            <option value="LineLength">Dužina linije (linija, d)</option>
            <option value="Distance">Rastojanje (p1, p2, d)</option>
            <option value="DistancePointLine">Rast. tačka-linija (tačka, linija, d)</option>
            <option value="HorizontalDistance">Horiz. rast. (p1, p2, d)</option>
            <option value="VerticalDistance">Vert. rast. (p1, p2, d)</option>
            <option value="Parallel">Paralelno (l1, l2)</option>
            <option value="Perpendicular">Normalno (l1, l2)</option>
            <option value="TangentLineCircle">Tangenta (linija, kružnica)</option>
            <option value="EqualLength">Jednake dužine (l1, l2)</option>
            <option value="EqualRadius">Jednak poluprečnik (c1, c2)</option>
            <option value="Coincident">Podudarnost (p1, p2)</option>
            <option value="PointOnLine">Tačka na liniji (tačka, linija)</option>
            <option value="PointOnCircle">Tačka na kružnici (tačka, kružnica)</option>
            <option value="Midpoint">Središte (tačka, linija)</option>
            <option value="Collinear">Kolinearno (l1, l2)</option>
            <option value="Radius">Poluprečnik (kružnica, r)</option>
            <option value="Diameter">Prečnik (kružnica, d)</option>
            <option value="Angle">Ugao (l1, l2, °)</option>
            <option value="AngleLine">Ugao linije (linija, °)</option>
            <option value="FixedPoint">Fiksna tačka (tačka)</option>
          </select>
          <input id="sketch-c-e1" class="cal-length w-38" type="number" value="1" aria-label="ID 1" />
          <input id="sketch-c-e2" class="cal-length w-38" type="number" value="2" aria-label="ID 2" />
          <input id="sketch-c-val" class="cal-length w-54" type="number" step="any" placeholder="auto" aria-label="Vrijednost" />
          <button id="sketch-c-add" class="btn" type="button">+</button>
        </div>
      </details>

      <details class="sketch-toolbar-box" role="group" open aria-label="Rešavanje, fit i izvoz">
        <summary class="sketch-toolbar-title">5 · Rešavanje, RasterFit i izvoz</summary>
        <div class="cal-actions">
          <button id="sketch-solve" class="btn btn-primary" type="button">${t(locale, 'sketch.solve')}</button>
          <button id="sketch-fit" class="btn" type="button">${t(locale, 'sketch.fit')}</button>
          <button id="sketch-fit-preview" class="btn" type="button">${t(locale, 'sketch.fitPreview')}</button>
          ${sk.preFitSnapshot ? `<button id="sketch-fit-cancel" class="btn" type="button">${t(locale, 'sketch.fitCancel')}</button>` : ''}
          <button id="sketch-clear" class="btn" type="button">${t(locale, 'sketch.clear')}</button>
        </div>
        <div class="cal-actions">
          <button id="export-dxf" class="btn" type="button">${t(locale, 'sketch.exportDxf')}</button>
          <button id="export-svg" class="btn" type="button">${t(locale, 'sketch.exportSvg')}</button>
          <button id="export-json" class="btn" type="button">${t(locale, 'sketch.exportJson')}</button>
          <button id="export-csv" class="btn" type="button">${t(locale, 'sketch.exportCsv')}</button>
        </div>
      </details>

      <details class="mb-8">
        <summary class="cal-subhead cursor-pointer">${t(locale, 'sketch.fitDialog')}</summary>
        <div class="cal-actions mt-6">
          <label class="cal-label"><input id="fit-opt-geom" type="checkbox" ${sk.fitOpts.fitGeometry ? 'checked' : ''} /> ${t(locale, 'sketch.fitGeometry')}</label>
          <label class="cal-label"><input id="fit-opt-rot" type="checkbox" ${sk.fitOpts.fitRotation ? 'checked' : ''} /> ${t(locale, 'sketch.fitRotation')}</label>
          <label class="cal-label"><input id="fit-opt-trans" type="checkbox" ${sk.fitOpts.fitTranslation ? 'checked' : ''} /> ${t(locale, 'sketch.fitTranslation')}</label>
          <label class="cal-label"><input id="fit-opt-scale" type="checkbox" ${sk.fitOpts.fitScale ? 'checked' : ''} /> ${t(locale, 'sketch.fitScale')}</label>
          <label class="cal-label"><input id="fit-opt-const" type="checkbox" ${sk.fitOpts.includeConstruction ? 'checked' : ''} /> ${t(locale, 'sketch.construction')}</label>
        </div>
      </details>

      ${dimensionEditorHtml}
      ${constraintsHtml ? `<ol class="cal-segments">${constraintsHtml}</ol>` : ''}
      ${elementsHtml ? `<details class="mb-8"><summary class="cal-subhead cursor-pointer">${t(locale, 'sketch.elements')} (${sk.lines.length + sk.circles.length + sk.arcs.length})</summary><ol class="cal-segments">${elementsHtml}</ol></details>` : ''}

      <p class="cal-empty" id="sketch-result">${escapeHtml(sk.resultText)}</p>
    `;

    const dimensionInput = sk.panel.querySelector<HTMLInputElement>('#sketch-dimension-value');
    dimensionInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Enter') sk.updateDimensionFromEditor();
        else sk.finishChain();
      }
    });
    sk.panel.querySelector('#sketch-dimension-apply')?.addEventListener('click', () => {
      sk.updateDimensionFromEditor();
    });
    sk.panel.querySelector('#sketch-dimension-cancel')?.addEventListener('click', () => sk.finishChain());
    dimensionInput?.focus();
    dimensionInput?.select();

    sk.panel.querySelector('#sketch-close')!.addEventListener('click', () => sk.deactivate());
    sk.panel.querySelector('#sketch-tool-polyline')!.addEventListener('click', () => sk.setTool('polyline'));
    sk.panel.querySelector('#sketch-tool-line')!.addEventListener('click', () => sk.setTool('line'));
    sk.panel.querySelector('#sketch-tool-rect')!.addEventListener('click', () => sk.setTool('rect'));
    sk.panel.querySelector('#sketch-tool-rounded-rect')!.addEventListener('click', () => sk.setTool('roundedRect'));
    sk.panel.querySelector('#sketch-tool-center-rect')!.addEventListener('click', () => sk.setTool('centerRect'));
    sk.panel.querySelector('#sketch-tool-slot')!.addEventListener('click', () => sk.setTool('slot'));
    sk.panel.querySelector('#sketch-tool-circle')!.addEventListener('click', () => sk.setTool('circle'));
    sk.panel.querySelector('#sketch-tool-arc')!.addEventListener('click', () => sk.setTool('arc'));
    sk.panel.querySelector('#sketch-tool-arc3pt')!.addEventListener('click', () => sk.setTool('arc3pt'));
    sk.panel.querySelector('#sketch-tool-polygon')!.addEventListener('click', () => sk.setTool('polygon'));
    sk.panel.querySelector('#sketch-tool-fillet')!.addEventListener('click', () => sk.setTool('fillet'));
    sk.panel.querySelector('#sketch-tool-chamfer')!.addEventListener('click', () => sk.setTool('chamfer'));
    sk.panel.querySelector('#sketch-tool-trim')!.addEventListener('click', () => sk.setTool('trim'));
    sk.panel.querySelector('#sketch-tool-mirror')!.addEventListener('click', () => sk.setTool('mirror'));
    sk.panel.querySelector('#sketch-tool-point')!.addEventListener('click', () => sk.setTool('point'));
    sk.panel.querySelector('#sketch-tool-select')!.addEventListener('click', () => sk.setTool('select'));
    sk.panel.querySelector('#sketch-tool-origin')!.addEventListener('click', () => sk.setTool('origin'));
    sk.panel.querySelector('#sketch-origin-reset')!.addEventListener('click', () => {
      sk.viewer.resetOrigin();
      const o = sk.viewer.getOrigin();
      sk.onStatus(`(0,0) → (${o.x.toFixed(0)}, ${o.y.toFixed(0)}) px`);
      sk.render();
    });

    const optionalRadius = (id: string, assign: (value: number | null) => void): void => {
      sk.panel.querySelector<HTMLInputElement>(id)?.addEventListener('change', (event) => {
        const value = Number((event.target as HTMLInputElement).value);
        assign(Number.isFinite(value) && value > 0 ? value : null);
      });
    };
    optionalRadius('#sketch-fillet-radius', (value) => { sk.filletRadiusMm = value; });
    optionalRadius('#sketch-rounded-radius', (value) => { sk.roundedRectRadiusMm = value; });
    sk.panel.querySelector<HTMLInputElement>('#sketch-chamfer-d1')?.addEventListener('change', (event) => {
      const value = Number((event.target as HTMLInputElement).value);
      if (Number.isFinite(value) && value > 0) sk.chamferFirstMm = value;
    });
    sk.panel.querySelector<HTMLInputElement>('#sketch-chamfer-d2')?.addEventListener('change', (event) => {
      const value = Number((event.target as HTMLInputElement).value);
      if (Number.isFinite(value) && value > 0) sk.chamferSecondMm = value;
    });

    sk.panel.querySelector('#sketch-finish-chain')?.addEventListener('click', () => {
      sk.finishChain();
    });
    sk.panel.querySelector('#sketch-remove-conflict')?.addEventListener('click', () => {
      if (conflicting.length > 0) {
        sk.pushUndo();
        sk.removeConstraintAt(conflicting[conflicting.length - 1]);
        void sk.solve();
      }
    });
    sk.panel.querySelector('#sketch-remove-redundant')?.addEventListener('click', () => {
      if (redundant.length > 0) {
        sk.pushUndo();
        sk.removeConstraintAt(redundant[redundant.length - 1]);
        void sk.solve();
      }
    });

    sk.panel.querySelector<HTMLInputElement>('#sketch-raster-snap')?.addEventListener('change', (e) => {
      sk.rasterSnapEnabled = (e.target as HTMLInputElement).checked;
      document.documentElement.dataset.rasterSnap = String(sk.rasterSnapEnabled);
      sk.viewer.requestRender();
    });
    sk.panel.querySelector<HTMLInputElement>('#sketch-guide-snap')?.addEventListener('change', (e) => {
      sk.guideSnapEnabled = (e.target as HTMLInputElement).checked;
      document.documentElement.dataset.guideSnap = String(sk.guideSnapEnabled);
      sk.viewer.requestRender();
    });
    sk.panel.querySelector<HTMLInputElement>('#sketch-pin-raster')?.addEventListener('change', (e) => {
      sk.autoPinRaster = (e.target as HTMLInputElement).checked;
    });
    sk.panel.querySelector<HTMLInputElement>('#sketch-loupe')?.addEventListener('change', (e) => {
      sk.loupeEnabled = (e.target as HTMLInputElement).checked;
      sk.viewer.requestRender();
    });
    sk.panel.querySelector<HTMLInputElement>('#sketch-construction')!.addEventListener('change', (e) => {
      sk.constructionMode = (e.target as HTMLInputElement).checked;
    });
    sk.panel.querySelector<HTMLInputElement>('#sketch-auto')!.addEventListener('change', (e) => {
      sk.autoConstraints = (e.target as HTMLInputElement).checked;
    });
    sk.panel.querySelector<HTMLInputElement>('#sketch-grid-snap')!.addEventListener('change', (e) => {
      sk.viewer.setGridSnapEnabled((e.target as HTMLInputElement).checked);
    });

    sk.panel.querySelectorAll<HTMLButtonElement>('.sketch-fc-c').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action) sk.applyConstraintAction(action);
      });
    });

    sk.panel.querySelectorAll<HTMLButtonElement>('.sketch-el-sel').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.kind;
        const id = Number(btn.dataset.id);
        if (kind === 'line') toggleInArray(sk.selectedLines, id);
        else if (kind === 'circle') toggleInArray(sk.selectedCircles, id);
        else if (kind === 'arc') toggleInArray(sk.selectedArcs, id);
        sk.render();
        sk.viewer.requestRender();
      });
    });

    sk.panel.querySelector('#sketch-solve')!.addEventListener('click', () => void sk.solve());
    sk.panel.querySelector('#sketch-fit')!.addEventListener('click', () => void sk.fit(false));
    sk.panel.querySelector('#sketch-fit-preview')!.addEventListener('click', () => void sk.fit(true));
    sk.panel.querySelector('#sketch-fit-cancel')?.addEventListener('click', () => sk.cancelFitPreview());
    sk.panel.querySelector('#sketch-undo')!.addEventListener('click', () => sk.undo());
    sk.panel.querySelector('#sketch-redo')!.addEventListener('click', () => sk.redo());
    sk.panel.querySelector('#sketch-delete')!.addEventListener('click', () => sk.deleteSelected());
    sk.panel.querySelector('#sketch-clear')!.addEventListener('click', () => sk.clear());

    sk.panel.querySelector<HTMLInputElement>('#fit-opt-geom')?.addEventListener('change', (e) => {
      sk.fitOpts.fitGeometry = (e.target as HTMLInputElement).checked;
    });
    sk.panel.querySelector<HTMLInputElement>('#fit-opt-rot')?.addEventListener('change', (e) => {
      sk.fitOpts.fitRotation = (e.target as HTMLInputElement).checked;
    });
    sk.panel.querySelector<HTMLInputElement>('#fit-opt-trans')?.addEventListener('change', (e) => {
      sk.fitOpts.fitTranslation = (e.target as HTMLInputElement).checked;
    });
    sk.panel.querySelector<HTMLInputElement>('#fit-opt-scale')?.addEventListener('change', (e) => {
      sk.fitOpts.fitScale = (e.target as HTMLInputElement).checked;
    });
    sk.panel.querySelector<HTMLInputElement>('#fit-opt-const')?.addEventListener('change', (e) => {
      sk.fitOpts.includeConstruction = (e.target as HTMLInputElement).checked;
    });

    sk.panel.querySelector('#sketch-c-add')!.addEventListener('click', () => {
      const type = (sk.panel.querySelector('#sketch-c-type') as HTMLSelectElement).value;
      const e1 = Number((sk.panel.querySelector('#sketch-c-e1') as HTMLInputElement).value);
      const e2 = Number((sk.panel.querySelector('#sketch-c-e2') as HTMLInputElement).value);
      const val = Number((sk.panel.querySelector('#sketch-c-val') as HTMLInputElement).value);
      sk.addConstraintFromUi(type, e1, e2, val);
    });

    sk.panel.querySelectorAll<HTMLInputElement>('.sketch-c-ref').forEach((el) => {
      const idx = Number(el.dataset.index);
      el.addEventListener('change', () => {
        if (el.checked) {
          sk.referenceConstraints = sk.referenceConstraints.filter((i) => i !== idx);
        } else if (!sk.referenceConstraints.includes(idx)) {
          sk.referenceConstraints.push(idx);
          if (sk.editingConstraintIdx === idx) sk.editingConstraintIdx = null;
        }
        void sk.solveSilent();
        sk.render();
        sk.viewer.requestRender();
        sk.onChange?.();
      });
    });

    sk.panel.querySelectorAll<HTMLButtonElement>('.sketch-c-del').forEach((el) => {
      const idx = Number(el.dataset.index);
      el.addEventListener('click', () => {
        sk.pushUndo();
        sk.removeConstraintAt(idx);
        void sk.solveSilent();
        sk.render();
        sk.viewer.requestRender();
        sk.onChange?.();
      });
    });

    sk.panel.querySelector('#export-dxf')!.addEventListener('click', () => void sk.exportDxf());
    sk.panel.querySelector('#export-svg')!.addEventListener('click', () => void sk.exportSvg());
    sk.panel.querySelector('#export-json')!.addEventListener('click', () => void sk.exportReportJson());
    sk.panel.querySelector('#export-csv')!.addEventListener('click', () => void sk.exportReportCsv());
  }

