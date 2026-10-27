// FreeCAD Sketcher-style 2D Parametric CAD Editor + RasterFit Free-Parameter Fitter.
//
// Supports:
// - Full FreeCAD Geometry tools: Select/Drag (V), Polyline (P, with M-key mode
//   cycle: Line / Perpendicular / Tangent / Tangent Arc / Free Arc), Line (L),
//   Rectangle (R), Centered Rectangle, Slot (S), Circle (C), Arc (A),
//   Regular Polygon (G), Fillet (F), Trim (T), Point (O), Construction toggle (K).
// - Full FreeCAD Constraints (selection-first & ID-based): Coincident,
//   PointOnObject, Horizontal (line or 2 pts), Vertical (line or 2 pts),
//   Parallel, Perpendicular, Tangent, Equal, Symmetric, Midpoint, Collinear,
//   Fixed/Block, Distance/LineLength, HorizontalDistance, VerticalDistance,
//   Radius/ArcRadius, Diameter, Angle/AngleLine, Driving/Reference toggle.
// - Per-entity SVD DoF coloring (FreeCAD green for locked DoFs, blue dashed for
//   construction, cyan for selected, red for conflicting), on-canvas constraint
//   glyphs, and on-canvas dimension leaders with inline value editing.
// - Native Rust+Python backend (`/api/solve`, `/api/fit`, `/api/export/*`,
//   `/api/report/*`) — all compute runs server-side; no WASM fallback.

import {
  exportSketchDxf,
  exportSketchSvg,
  fitSketch,
  getActiveRasterSession,
  reportCsv,
  reportJson,
  solveSketch,
  type FitResponse,
  type SolveResponse,
} from './backend';
import { t, tf, type Locale, type MessageKey } from './i18n';
import type {
  SavedSketchArc,
  SavedSketchCircle,
  SavedSketchData,
  SavedSketchLine,
  SavedSketchPoint,
} from './project';
import { sketchToWorld } from './project';
import type { Affine, RasterViewer } from './viewer';

export type SketchTool =
  | 'polyline'
  | 'line'
  | 'rect'
  | 'centerRect'
  | 'slot'
  | 'circle'
  | 'arc'
  | 'arc3pt'
  | 'polygon'
  | 'fillet'
  | 'trim'
  | 'mirror'
  | 'point'
  | 'origin'
  | 'select';

export type PolylineSubMode = 'line' | 'perp' | 'tangent' | 'arc' | 'arc-free';

interface SketchSnapshot {
  points: SavedSketchPoint[];
  lines: SavedSketchLine[];
  circles: SavedSketchCircle[];
  arcs: SavedSketchArc[];
  constraints: Record<string, unknown>[];
  reference_constraints: number[];
}

export class SketchController {
  private points: SavedSketchPoint[] = [];
  private lines: SavedSketchLine[] = [];
  private circles: SavedSketchCircle[] = [];
  private arcs: SavedSketchArc[] = [];
  private constraints: Record<string, unknown>[] = [];
  private referenceConstraints: number[] = [];

  private undoStack: SketchSnapshot[] = [];
  private redoStack: SketchSnapshot[] = [];

  // Selection state for FreeCAD selection-driven constraints
  private selectedPoints: number[] = [];
  private selectedLines: number[] = [];
  private selectedCircles: number[] = [];
  private selectedArcs: number[] = [];

  private tool: SketchTool = 'polyline';
  private activeConstraintTool: string | null = null;
  private editingConstraintIdx: number | null = null;
  private dimBadgeRects: { cIdx: number; x: number; y: number; w: number; h: number }[] = [];
  private polyMode: PolylineSubMode = 'line';
  private polygonSides = 6;
  private constructionMode = false;
  private autoConstraints = true;
  private rasterSnapEnabled = true;
  private autoPinRaster = false;
  private loupeEnabled = false;
  private grayCache: { data: Uint8Array; width: number; height: number } | null = null;

  private pending: {
    x: number;
    y: number;
    pointId?: number;
    startPointId?: number;
    lastLineId?: number;
    lastArcId?: number;
  } | null = null;
  private arcStartPending: {
    centerId: number;
    startPtId?: number;
    radius: number;
    startAngle: number;
  } | null = null;
  private arc3PtPending: {
    p1Id: number;
    x1: number;
    y1: number;
    p2Id?: number;
    x2?: number;
    y2?: number;
  } | null = null;
  /** 3-point arc pending within a polyline: joint (a) + end (b) set, waiting for the rim point. */
  private polyArcPending: {
    aId: number;
    ax: number;
    ay: number;
    bId: number;
    bx: number;
    by: number;
    startId: number;
    prevLineId?: number;
    prevArcId?: number;
    tangent: boolean;
  } | null = null;
  private dragState:
    | { kind: 'origin' }
    | { kind: 'point'; id: number; lastX: number; lastY: number }
    | { kind: 'line'; id: number; lastX: number; lastY: number }
    | { kind: 'circle'; id: number }
    | { kind: 'arc-start' | 'arc-end' | 'arc-rim'; id: number }
    | { kind: 'box'; x0: number; y0: number; x1: number; y1: number }
    | null = null;
  private dragMoved = false;
  private hoverEntity: {
    kind: 'point' | 'line' | 'circle' | 'arc' | 'origin';
    id: number;
  } | null = null;
  private lastMouse: { x: number; y: number; altKey: boolean } | null = null;

  // RasterFit options (matching raster2sketcher.txt)
  private fitOpts = {
    fitGeometry: true,
    fitRotation: true,
    fitTranslation: true,
    fitScale: false,
    includeConstruction: false,
    captureRadius: 12.0,
    robustScale: 1.5,
  };
  private preFitSnapshot: { sketch: SketchSnapshot; rasterTransform: Affine } | null = null;

  private active = false;
  private resultText = '';
  private lastSolve: SolveResponse | null = null;
  private lastFitJson: string | null = null;
  private lastFit: FitResponse | null = null;

  constructor(
    private viewer: RasterViewer,
    private panel: HTMLElement,
    private locale: Locale,
    private onStatus: (msg: string, isError?: boolean) => void,
    private getMaskStrokes: () => {
      mode: 'include' | 'exclude';
      kind?: 'brush' | 'polygon' | 'rect';
      radius?: number;
      points: { x: number; y: number }[];
    }[],
    private onDofChange?: (dof: number, status: 'ok' | 'under' | 'conflict') => void,
    private onChange?: () => void,
  ) {}

  isActive(): boolean {
    return this.active;
  }

  getCursor(): string {
    if (this.dragState) return this.dragState.kind === 'box' ? 'crosshair' : 'grabbing';
    if (this.activeConstraintTool) return 'pointer';
    if (this.tool === 'select') {
      return this.hoverEntity ? 'move' : 'default';
    }
    return 'crosshair';
  }

  /** Localized label for the current tool (with polyline sub-mode). */
  toolLabel(): string {
    if (this.tool === 'polyline') {
      const sub =
        this.polyMode === 'arc'
          ? t(this.locale, 'sketch.polyArc')
          : this.polyMode === 'arc-free'
            ? t(this.locale, 'sketch.polyArcFree')
            : this.polyMode === 'perp'
              ? t(this.locale, 'sketch.polyPerp')
              : this.polyMode === 'tangent'
                ? t(this.locale, 'sketch.polyTangent')
                : t(this.locale, 'sketch.polyLine');
      return `${t(this.locale, 'sketch.tool.polyline')} · ${sub}`;
    }
    const key: Record<string, MessageKey> = {
      line: 'sketch.tool.line',
      rect: 'sketch.tool.rect',
      centerRect: 'sketch.tool.centerRect',
      slot: 'sketch.tool.slot',
      circle: 'sketch.tool.circle',
      arc: 'sketch.tool.arc',
      polygon: 'sketch.tool.polygon',
      fillet: 'sketch.tool.fillet',
      trim: 'sketch.tool.trim',
      mirror: 'sketch.tool.mirror',
      point: 'sketch.tool.point',
      select: 'sketch.tool.select',
    };
    const k = key[this.tool];
    if (k) return t(this.locale, k);
    return this.tool === 'arc3pt' ? 'Luk 3 tačke' : 'Postavi (0,0)';
  }

  /** Reflect a point across the line through `(ax, ay)` and `(bx, by)`. */
  private reflectPoint(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): { x: number; y: number } {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) return { x: px, y: py };
    const t = ((px - ax) * dx + (py - ay) * dy) / len2;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    return { x: 2 * cx - px, y: 2 * cy - py };
  }

  /**
   * Create an axisymmetric (mirrored) copy of the selected geometry across the
   * given axis line. The original geometry is preserved; new reflected entities
   * are appended.
   */
  private mirrorSelection(axis: SavedSketchLine): void {
    const pa = this.points.find((p) => p.id === axis.a);
    const pb = this.points.find((p) => p.id === axis.b);
    if (!pa || !pb) return;

    const hasSelection =
      this.selectedPoints.length +
        this.selectedLines.length +
        this.selectedCircles.length +
        this.selectedArcs.length >
      0;
    if (!hasSelection) return;

    // Collect every point id referenced by the selection.
    const pointIds = new Set<number>();
    for (const id of this.selectedPoints) pointIds.add(id);
    for (const id of this.selectedLines) {
      const l = this.lines.find((x) => x.id === id);
      if (l) {
        pointIds.add(l.a);
        pointIds.add(l.b);
      }
    }
    for (const id of this.selectedCircles) {
      const c = this.circles.find((x) => x.id === id);
      if (c) pointIds.add(c.center);
    }
    for (const id of this.selectedArcs) {
      const a = this.arcs.find((x) => x.id === id);
      if (a) {
        pointIds.add(a.center);
        if (a.startPt !== undefined) pointIds.add(a.startPt);
        if (a.endPt !== undefined) pointIds.add(a.endPt);
      }
    }

    // Reflect every involved point and remember the id mapping.
    const map = new Map<number, number>();
    for (const id of pointIds) {
      const p = this.points.find((x) => x.id === id);
      if (!p) continue;
      const r = this.reflectPoint(p.x, p.y, pa.x, pa.y, pb.x, pb.y);
      const np = this.getOrCreatePoint(r.x, r.y, true, true);
      map.set(id, np.id);
    }

    // Mirror lines.
    for (const id of this.selectedLines) {
      const l = this.lines.find((x) => x.id === id);
      if (!l) continue;
      const a2 = map.get(l.a);
      const b2 = map.get(l.b);
      if (a2 === undefined || b2 === undefined) continue;
      this.lines.push({ id: this.nextLineId(), a: a2, b: b2, construction: l.construction });
    }

    // Mirror circles.
    for (const id of this.selectedCircles) {
      const c = this.circles.find((x) => x.id === id);
      if (!c) continue;
      const c2 = map.get(c.center);
      if (c2 === undefined) continue;
      this.circles.push({
        id: this.nextCircleId(),
        center: c2,
        radius: c.radius,
        construction: c.construction,
      });
    }

    // Mirror arcs (reflection reverses the sweep direction, so start/end swap).
    for (const id of this.selectedArcs) {
      const a = this.arcs.find((x) => x.id === id);
      if (!a) continue;
      const center = this.points.find((p) => p.id === a.center);
      const c2 = map.get(a.center);
      const center2 = c2 !== undefined ? this.points.find((p) => p.id === c2) : undefined;
      if (!center || !center2) continue;
      const sOrig = {
        x: center.x + a.radius * Math.cos(a.start),
        y: center.y + a.radius * Math.sin(a.start),
      };
      const eOrig = {
        x: center.x + a.radius * Math.cos(a.end),
        y: center.y + a.radius * Math.sin(a.end),
      };
      const sRefl = this.reflectPoint(sOrig.x, sOrig.y, pa.x, pa.y, pb.x, pb.y);
      const eRefl = this.reflectPoint(eOrig.x, eOrig.y, pa.x, pa.y, pb.x, pb.y);
      this.arcs.push({
        id: this.nextArcId(),
        center: c2!,
        radius: a.radius,
        start: Math.atan2(eRefl.y - center2.y, eRefl.x - center2.x),
        end: Math.atan2(sRefl.y - center2.y, sRefl.x - center2.x),
        startPt: a.endPt !== undefined ? map.get(a.endPt) : undefined,
        endPt: a.startPt !== undefined ? map.get(a.startPt) : undefined,
        construction: a.construction,
      });
    }

    this.clearSelection();
  }

  /** Provide the current page's gray8 buffer for synchronous sub-pixel raster snapping. */
  setGrayBuffer(buf: { data: Uint8Array; width: number; height: number } | null): void {
    this.grayCache = buf;
  }

  getDof(): number {
    return this.lastSolve
      ? this.lastSolve.dof
      : 2 * this.points.length + this.circles.length + 3 * this.arcs.length;
  }

  private getScaleMm(): number {
    const ws = this.viewer.getWorldScale();
    return ws.sx > 0 && ws.sx !== 1 ? ws.sx : 1;
  }

  /** Update cursor position (canvas-relative CSS px) for live rubber-band preview & hover highlight. */
  setLastMouse(x: number, y: number, altKey = false): void {
    this.lastMouse = { x, y, altKey };
    if (this.active) {
      if (this.tool === 'select' && !this.dragState) {
        const r = this.viewer.screenToRaster(x, y);
        const orig = this.viewer.getOrigin();
        const origScreen = this.viewer.rasterToScreen(orig.x, orig.y);
        if (Math.hypot(x - origScreen.x, y - origScreen.y) <= 12) {
          this.hoverEntity = { kind: 'origin', id: 0 };
        } else if (r) {
          const hitPt = this.findNearPoint(r.x, r.y, 14);
          if (hitPt) {
            this.hoverEntity = { kind: 'point', id: hitPt.id };
          } else {
            const hitArc = this.findNearArc(r.x, r.y, 10);
            if (hitArc) {
              this.hoverEntity = { kind: 'arc', id: hitArc.id };
            } else {
              const hitCircle = this.findNearCircle(r.x, r.y, 10);
              if (hitCircle) {
                this.hoverEntity = { kind: 'circle', id: hitCircle.id };
              } else {
                const hitLine = this.findNearLine(r.x, r.y, 10);
                this.hoverEntity = hitLine ? { kind: 'line', id: hitLine.id } : null;
              }
            }
          }
        }
      } else {
        this.hoverEntity = null;
      }
      this.viewer.requestRender();
    }
  }

  /**
   * FreeCAD Sketcher Esc / Right-click / Double-click state machine:
   * 1. Close dimension editor if open.
   * 2. Finish active chain / pending geometry if in progress.
   * 3. Exit active continuous constraint tool if active.
   * 4. Switch from any geometry creation tool to Select / Move ('select') mode!
   * 5. Clear active selection if already in Select mode.
   */
  finishChain(): boolean {
    if (this.editingConstraintIdx !== null) {
      this.editingConstraintIdx = null;
      this.render();
      this.viewer.requestRender();
      return true;
    }
    if (this.pending || this.arcStartPending || this.arc3PtPending || this.polyArcPending) {
      this.pending = null;
      this.arcStartPending = null;
      this.arc3PtPending = null;
      this.polyArcPending = null;
      this.render();
      this.viewer.requestRender();
      this.onStatus(t(this.locale, 'status.ready'));
      return true;
    }
    if (this.activeConstraintTool !== null) {
      this.activeConstraintTool = null;
      this.tool = 'select';
      this.render();
      this.viewer.requestRender();
      this.onStatus(t(this.locale, 'status.ready'));
      return true;
    }
    if (this.tool !== 'select') {
      this.setTool('select');
      this.onStatus('Režim izbora / pomeranja (kliknite da izaberete, prevucite da pomerite)');
      return true;
    }
    if (
      this.selectedPoints.length > 0 ||
      this.selectedLines.length > 0 ||
      this.selectedCircles.length > 0 ||
      this.selectedArcs.length > 0
    ) {
      this.clearSelection();
      this.render();
      this.viewer.requestRender();
      return true;
    }
    return false;
  }

  clearSelection(): void {
    this.selectedPoints = [];
    this.selectedLines = [];
    this.selectedCircles = [];
    this.selectedArcs = [];
  }

  /** Line segments in raster coordinates (used by "Mask from sketch"). */
  getLineSegments(): { ax: number; ay: number; bx: number; by: number }[] {
    const out: { ax: number; ay: number; bx: number; by: number }[] = [];
    for (const l of this.lines) {
      const a = this.points.find((p) => p.id === l.a);
      const b = this.points.find((p) => p.id === l.b);
      if (a && b) out.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
    }
    return out;
  }

  exportState(): { sketch: SavedSketchData; lastFitReportJson?: string } {
    return {
      sketch: {
        points: this.points.map((p) => ({ ...p })),
        lines: this.lines.map((l) => ({ ...l })),
        circles: this.circles.map((c) => ({ ...c })),
        arcs: this.arcs.map((a) => ({ ...a })),
        constraints: this.constraints.map((c) => ({ ...c })),
        reference_constraints: [...this.referenceConstraints],
      },
      lastFitReportJson: this.lastFitJson ?? undefined,
    };
  }

  importState(state: SavedSketchData, lastFitReportJson?: string): void {
    this.points = (state.points ?? []).map((p) => ({ ...p }));
    this.lines = (state.lines ?? []).map((l) => ({ ...l }));
    this.circles = (state.circles ?? []).map((c) => ({ ...c }));
    this.arcs = (state.arcs ?? []).map((a) => ({ ...a }));
    this.constraints = (state.constraints ?? []).map((c) => ({ ...c }));
    this.referenceConstraints = [...(state.reference_constraints ?? [])];
    this.lastFitJson = lastFitReportJson ?? null;
    this.lastFit = null;
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.arcStartPending = null;
    this.arc3PtPending = null;
    this.polyArcPending = null;
    this.clearSelection();
    void this.solveSilent();
    if (this.active) this.render();
    this.viewer.requestRender();
    this.notifyDof();
  }

  activate(): void {
    this.active = true;
    this.panel.hidden = false;
    this.onStatus(t(this.locale, 'sketch.hint'));
    this.render();
    this.viewer.requestRender();
    this.notifyDof();
  }

  deactivate(): void {
    this.active = false;
    this.pending = null;
    this.arcStartPending = null;
    this.arc3PtPending = null;
    this.polyArcPending = null;
    this.dragState = null;
    this.hoverEntity = null;
    this.panel.hidden = true;
    this.viewer.requestRender();
  }

  private captureSnapshot(): SketchSnapshot {
    return {
      points: this.points.map((p) => ({ ...p })),
      lines: this.lines.map((l) => ({ ...l })),
      circles: this.circles.map((c) => ({ ...c })),
      arcs: this.arcs.map((a) => ({ ...a })),
      constraints: this.constraints.map((c) => ({ ...c })),
      reference_constraints: [...this.referenceConstraints],
    };
  }

  private pushUndo(): void {
    this.undoStack.push(this.captureSnapshot());
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): void {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.redoStack.push(this.captureSnapshot());
    this.restoreSnapshot(snap);
  }

  redo(): void {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push(this.captureSnapshot());
    this.restoreSnapshot(snap);
  }

  private restoreSnapshot(snap: SketchSnapshot): void {
    this.points = snap.points;
    this.lines = snap.lines;
    this.circles = snap.circles;
    this.arcs = snap.arcs;
    this.constraints = snap.constraints;
    this.referenceConstraints = snap.reference_constraints;
    this.pending = null;
    this.arcStartPending = null;
    this.arc3PtPending = null;
    this.polyArcPending = null;
    void this.solveSilent();
    this.render();
    this.viewer.requestRender();
    this.notifyDof();
    this.onChange?.();
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (e.key === 'Escape' || e.key === 'Enter') {
      if (this.finishChain()) return true;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.deleteSelectedEntities()) return true;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      if (e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      this.redo();
      return true;
    }
    // FreeCAD Polyline M-key: cycle Line -> Perpendicular -> Tangent -> Arc -> Free Arc.
    if ((e.key === 'm' || e.key === 'M') && this.tool === 'polyline' && this.pending) {
      const order: PolylineSubMode[] = ['line', 'perp', 'tangent', 'arc', 'arc-free'];
      this.polyMode = order[(order.indexOf(this.polyMode) + 1) % order.length];
      const label =
        this.polyMode === 'arc'
          ? 'sketch.polyArc'
          : this.polyMode === 'arc-free'
            ? 'sketch.polyArcFree'
            : this.polyMode === 'perp'
              ? 'sketch.polyPerp'
              : this.polyMode === 'tangent'
                ? 'sketch.polyTangent'
                : 'sketch.polyLine';
      this.onStatus(t(this.locale, label));
      this.render();
      this.viewer.requestRender();
      return true;
    }
    // M-key toggles between Center-Start-End Arc ('arc') and 3-Point Rim Arc ('arc3pt')
    if ((e.key === 'm' || e.key === 'M') && (this.tool === 'arc' || this.tool === 'arc3pt')) {
      this.setTool(this.tool === 'arc' ? 'arc3pt' : 'arc');
      return true;
    }
    // FreeCAD Constraint shortcuts when entities are selected in Select mode:
    const hasSelection =
      this.selectedPoints.length +
        this.selectedLines.length +
        this.selectedCircles.length +
        this.selectedArcs.length >
      0;
    if (hasSelection && (e.key === 'h' || e.key === 'H')) {
      this.applyConstraintAction('Horizontal');
      return true;
    }
    if (hasSelection && (e.key === 'n' || e.key === 'N')) {
      this.applyConstraintAction('Perpendicular');
      return true;
    }
    if (hasSelection && (e.key === 'e' || e.key === 'E')) {
      this.applyConstraintAction('Equal');
      return true;
    }
    if (hasSelection && (e.key === 'd' || e.key === 'D')) {
      this.applyConstraintAction('Distance');
      return true;
    }
    if (hasSelection && (e.key === 'b' || e.key === 'B')) {
      this.applyConstraintAction('Block');
      return true;
    }
    if (e.key === 'k' || e.key === 'K') {
      this.toggleConstructionMode();
      return true;
    }
    if (e.key === 'p' || e.key === 'P') {
      this.setTool('polyline');
      return true;
    }
    if (e.key === 'l' || e.key === 'L') {
      this.setTool('line');
      return true;
    }
    if (e.key === 'r' || e.key === 'R') {
      this.setTool(e.shiftKey ? 'centerRect' : 'rect');
      return true;
    }
    if (e.key === 's' || e.key === 'S') {
      this.setTool('slot');
      return true;
    }
    if (e.key === 'c' || e.key === 'C') {
      this.setTool('circle');
      return true;
    }
    if (e.key === 'a' || e.key === 'A') {
      this.setTool(e.shiftKey ? 'arc3pt' : 'arc');
      return true;
    }
    if (e.key === 'g' || e.key === 'G') {
      this.setTool('polygon');
      return true;
    }
    if (e.key === 'f' || e.key === 'F') {
      this.setTool('fillet');
      return true;
    }
    if (e.key === 't' || e.key === 'T') {
      this.setTool('trim');
      return true;
    }
    if (e.key === 'o' || e.key === 'O') {
      this.setTool('point');
      return true;
    }
    if (e.key === 'v' || e.key === 'V') {
      this.setTool('select');
      return true;
    }
    return false;
  }

  setTool(tool: SketchTool): void {
    this.tool = tool;
    this.activeConstraintTool = null;
    this.pending = null;
    this.arcStartPending = null;
    this.arc3PtPending = null;
    this.polyArcPending = null;
    this.hoverEntity = null;
    this.render();
    this.viewer.requestRender();
  }

  toggleConstructionMode(): void {
    if (
      this.selectedLines.length > 0 ||
      this.selectedCircles.length > 0 ||
      this.selectedArcs.length > 0
    ) {
      this.pushUndo();
      for (const id of this.selectedLines) {
        const l = this.lines.find((x) => x.id === id);
        if (l) l.construction = !l.construction;
      }
      for (const id of this.selectedCircles) {
        const c = this.circles.find((x) => x.id === id);
        if (c) c.construction = !c.construction;
      }
      for (const id of this.selectedArcs) {
        const a = this.arcs.find((x) => x.id === id);
        if (a) a.construction = !a.construction;
      }
      this.render();
      this.viewer.requestRender();
      this.onChange?.();
    } else {
      this.constructionMode = !this.constructionMode;
      this.render();
    }
  }

  deleteSelectedEntities(): boolean {
    if (
      this.selectedPoints.length === 0 &&
      this.selectedLines.length === 0 &&
      this.selectedCircles.length === 0 &&
      this.selectedArcs.length === 0
    ) {
      return false;
    }
    this.pushUndo();
    const delPts = new Set(this.selectedPoints);
    const delLines = new Set(this.selectedLines);
    const delCircles = new Set(this.selectedCircles);
    const delArcs = new Set(this.selectedArcs);

    this.lines = this.lines.filter((l) => !delLines.has(l.id) && !delPts.has(l.a) && !delPts.has(l.b));
    this.circles = this.circles.filter((c) => !delCircles.has(c.id) && !delPts.has(c.center));
    this.arcs = this.arcs.filter((a) => !delArcs.has(a.id) && !delPts.has(a.center));
    this.points = this.points.filter((p) => !delPts.has(p.id));
    this.pruneOrphanConstraints();
    this.clearSelection();
    void this.solveSilent();
    this.render();
    this.viewer.requestRender();
    this.notifyDof();
    this.onChange?.();
    return true;
  }

  /** Delete the current selection (button + Delete/Backspace shortcut). */
  deleteSelected(): void {
    if (!this.deleteSelectedEntities()) {
      this.onStatus(t(this.locale, 'sketch.selectToDelete'), true);
    }
  }

  private pruneOrphanConstraints(): void {
    const ptIds = new Set(this.points.map((p) => p.id));
    const lnIds = new Set(this.lines.map((l) => l.id));
    const ciIds = new Set(this.circles.map((c) => c.id));
    const arIds = new Set(this.arcs.map((a) => a.id));

    this.constraints = this.constraints.filter((c) => {
      const k = Object.keys(c)[0];
      const v = (c as Record<string, unknown>)[k];
      switch (k) {
        case 'Horizontal':
        case 'Vertical':
          return lnIds.has(v as number);
        case 'LineLength':
        case 'AngleLine':
          return Array.isArray(v) && lnIds.has(v[0] as number);
        case 'Parallel':
        case 'Perpendicular':
        case 'EqualLength':
        case 'Collinear':
        case 'Angle':
          return Array.isArray(v) && lnIds.has(v[0] as number) && lnIds.has(v[1] as number);
        case 'Coincident':
        case 'HorizontalPoints':
        case 'VerticalPoints':
        case 'Distance':
        case 'HorizontalDistance':
        case 'VerticalDistance':
          return Array.isArray(v) && ptIds.has(v[0] as number) && ptIds.has(v[1] as number);
        case 'FixedPoint':
          return Array.isArray(v) && ptIds.has(v[0] as number);
        case 'PointOnLine':
        case 'Midpoint':
        case 'DistancePointLine':
          return Array.isArray(v) && ptIds.has(v[0] as number) && lnIds.has(v[1] as number);
        case 'PointOnCircle':
          return Array.isArray(v) && ptIds.has(v[0] as number) && ciIds.has(v[1] as number);
        case 'PointOnArc':
          return Array.isArray(v) && ptIds.has(v[0] as number) && arIds.has(v[1] as number);
        case 'Symmetric':
          return (
            Array.isArray(v) &&
            ptIds.has(v[0] as number) &&
            ptIds.has(v[1] as number) &&
            lnIds.has(v[2] as number)
          );
        case 'SymmetricPoints':
          return (
            Array.isArray(v) &&
            ptIds.has(v[0] as number) &&
            ptIds.has(v[1] as number) &&
            ptIds.has(v[2] as number)
          );
        case 'Radius':
        case 'Diameter':
          return Array.isArray(v) && ciIds.has(v[0] as number);
        case 'ArcRadius':
          return Array.isArray(v) && arIds.has(v[0] as number);
        case 'EqualRadius':
        case 'TangentCircleCircle':
          return Array.isArray(v) && ciIds.has(v[0] as number) && ciIds.has(v[1] as number);
        case 'EqualRadiusArc':
        case 'TangentArcArc':
          return Array.isArray(v) && arIds.has(v[0] as number) && arIds.has(v[1] as number);
        case 'EqualRadiusCircleArc':
          return Array.isArray(v) && ciIds.has(v[0] as number) && arIds.has(v[1] as number);
        case 'TangentLineCircle':
        case 'PerpendicularLineCircle':
          return Array.isArray(v) && lnIds.has(v[0] as number) && ciIds.has(v[1] as number);
        case 'TangentLineArc':
        case 'PerpendicularLineArc':
          return Array.isArray(v) && lnIds.has(v[0] as number) && arIds.has(v[1] as number);
        default:
          return true;
      }
    });
  }

  /** Find an existing sketch point within `tolScreenPx` CSS pixels on screen. */
  private findNearPoint(rx: number, ry: number, tolScreenPx = 10): SavedSketchPoint | null {
    const to = this.viewer.rasterToScreen.bind(this.viewer);
    const targetScreen = to(rx, ry);
    let best: SavedSketchPoint | null = null;
    let bestDist = tolScreenPx;
    for (const p of this.points) {
      const s = to(p.x, p.y);
      const d = Math.hypot(s.x - targetScreen.x, s.y - targetScreen.y);
      if (d <= bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  }

  /** Find a line segment near `(rx, ry)` within `tolScreenPx` CSS pixels. */
  private findNearLine(rx: number, ry: number, tolScreenPx = 8): SavedSketchLine | null {
    const to = this.viewer.rasterToScreen.bind(this.viewer);
    const pScreen = to(rx, ry);
    let best: SavedSketchLine | null = null;
    let bestDist = tolScreenPx;
    for (const l of this.lines) {
      const pa = this.points.find((p) => p.id === l.a);
      const pb = this.points.find((p) => p.id === l.b);
      if (!pa || !pb) continue;
      const a = to(pa.x, pa.y);
      const b = to(pb.x, pb.y);
      const d = distToSegment(pScreen.x, pScreen.y, a.x, a.y, b.x, b.y);
      if (d <= bestDist) {
        bestDist = d;
        best = l;
      }
    }
    return best;
  }

  /** Find a circle rim near `(rx, ry)` within `tolScreenPx` CSS pixels. */
  private findNearCircle(rx: number, ry: number, tolScreenPx = 8): SavedSketchCircle | null {
    const to = this.viewer.rasterToScreen.bind(this.viewer);
    const pScreen = to(rx, ry);
    const zoom = this.viewer.getEffectiveZoom();
    let best: SavedSketchCircle | null = null;
    let bestDist = tolScreenPx;
    for (const c of this.circles) {
      const center = this.points.find((p) => p.id === c.center);
      if (!center) continue;
      const sc = to(center.x, center.y);
      const d = Math.abs(Math.hypot(pScreen.x - sc.x, pScreen.y - sc.y) - c.radius * zoom);
      if (d <= bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best;
  }

  /** Find an arc near `(rx, ry)` within `tolScreenPx` CSS pixels. */
  private findNearArc(rx: number, ry: number, tolScreenPx = 8): SavedSketchArc | null {
    const to = this.viewer.rasterToScreen.bind(this.viewer);
    const pScreen = to(rx, ry);
    const zoom = this.viewer.getEffectiveZoom();
    let best: SavedSketchArc | null = null;
    let bestDist = tolScreenPx;
    for (const a of this.arcs) {
      const center = this.points.find((p) => p.id === a.center);
      if (!center) continue;
      const sc = to(center.x, center.y);
      const d = Math.abs(Math.hypot(pScreen.x - sc.x, pScreen.y - sc.y) - a.radius * zoom);
      if (d <= bestDist && isAngleInArc(Math.atan2(ry - center.y, rx - center.x), a.start, a.end)) {
        bestDist = d;
        best = a;
      }
    }
    return best;
  }

  private nextPointId(): number {
    return this.points.reduce((m, p) => Math.max(m, p.id), 0) + 1;
  }

  private nextLineId(): number {
    return this.lines.reduce((m, l) => Math.max(m, l.id), 0) + 1;
  }

  private nextCircleId(): number {
    return this.circles.reduce((m, c) => Math.max(m, c.id), 0) + 1;
  }

  private nextArcId(): number {
    return this.arcs.reduce((m, a) => Math.max(m, a.id), 0) + 1;
  }

  /** Sub-pixel snap to a dark raster line/corner within `r = 8 px` on the PDF/image scan. */
  private snapRasterPoint(
    pt: { x: number; y: number },
    altKey = false,
  ): { x: number; y: number; snapped: boolean } {
    if (!this.rasterSnapEnabled || altKey || !this.grayCache) {
      return { x: pt.x, y: pt.y, snapped: false };
    }
    const { data, width, height } = this.grayCache;
    const r = 8;
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
        if (darkness < 28) continue;
        const score = darkness / (1 + 0.25 * dist);
        if (score > bestScore) {
          bestScore = score;
          const dL = 255 - data[v * width + (u - 1)];
          const dR = 255 - data[v * width + (u + 1)];
          const dU = 255 - data[(v - 1) * width + u];
          const dD = 255 - data[(v + 1) * width + u];
          const denomX = dL - 2 * darkness + dR;
          const denomY = dU - 2 * darkness + dD;
          const dx =
            Math.abs(denomX) > 1e-3 ? Math.max(-0.5, Math.min(0.5, (0.5 * (dL - dR)) / denomX)) : 0;
          const dy =
            Math.abs(denomY) > 1e-3 ? Math.max(-0.5, Math.min(0.5, (0.5 * (dU - dD)) / denomY)) : 0;
          bestU = u + 0.5 + dx;
          bestV = v + 0.5 + dy;
        }
      }
    }
    return bestScore > 0
      ? { x: bestU, y: bestV, snapped: true }
      : { x: pt.x, y: pt.y, snapped: false };
  }

  private snapInputCoord(x: number, y: number, altKey = false): { x: number; y: number } {
    if (altKey) return { x, y };
    // 1. Always prioritize snapping to an existing sketch vertex within 16 CSS px for 100% line continuity!
    const existing = this.findNearPoint(x, y, 16);
    if (existing) return { x: existing.x, y: existing.y };

    if (this.autoConstraints) {
      if (!this.viewer.getPage()) {
        const orig = this.viewer.getOrigin();
        const origScreen = this.viewer.rasterToScreen(orig.x, orig.y);
        const curScreen = this.viewer.rasterToScreen(x, y);
        if (Math.hypot(curScreen.x - origScreen.x, curScreen.y - origScreen.y) <= 12) {
          return { x: orig.x, y: orig.y };
        }
      }
      // Project onto a nearby line, arc, or circle if within 8 CSS px
      const hitLine = this.findNearLine(x, y, 8);
      if (hitLine) {
        const pa = this.points.find((p) => p.id === hitLine.a);
        const pb = this.points.find((p) => p.id === hitLine.b);
        if (pa && pb) return projectPointToSegment(x, y, pa.x, pa.y, pb.x, pb.y);
      }
      const hitArc = this.findNearArc(x, y, 8);
      if (hitArc) {
        const c = this.points.find((p) => p.id === hitArc.center);
        if (c) {
          const ang = Math.atan2(y - c.y, x - c.x);
          return { x: c.x + hitArc.radius * Math.cos(ang), y: c.y + hitArc.radius * Math.sin(ang) };
        }
      }
      const hitCircle = this.findNearCircle(x, y, 8);
      if (hitCircle) {
        const c = this.points.find((p) => p.id === hitCircle.center);
        if (c) {
          const ang = Math.atan2(y - c.y, x - c.x);
          return {
            x: c.x + hitCircle.radius * Math.cos(ang),
            y: c.y + hitCircle.radius * Math.sin(ang),
          };
        }
      }
    }
    if (this.rasterSnapEnabled && this.grayCache) {
      const rSnap = this.snapRasterPoint({ x, y }, altKey);
      if (rSnap.snapped) return { x: rSnap.x, y: rSnap.y };
    }
    return this.viewer.snapToGrid(x, y);
  }

  /** Return all point IDs connected to `ptId` via Coincident constraints (including `ptId` itself). */
  private getCoincidentCluster(ptId: number): number[] {
    const visited = new Set<number>([ptId]);
    const queue = [ptId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const c of this.constraints) {
        if ('Coincident' in c) {
          const [a, b] = (c as { Coincident: number[] }).Coincident;
          if (a === cur && !visited.has(b)) {
            visited.add(b);
            queue.push(b);
          } else if (b === cur && !visited.has(a)) {
            visited.add(a);
            queue.push(a);
          }
        }
      }
    }
    return [...visited];
  }

  /** Keep every arc's start/end angles and its endpoint vertices (`startPt`, `endPt`) 100% continuous. */
  private syncArcsWithEndpoints(): void {
    const twoPi = Math.PI * 2;
    for (const a of this.arcs) {
      const center = this.points.find((p) => p.id === a.center);
      if (!center) continue;
      const ps = a.startPt !== undefined ? this.points.find((p) => p.id === a.startPt) : undefined;
      const pe = a.endPt !== undefined ? this.points.find((p) => p.id === a.endPt) : undefined;
      if (ps) {
        a.start = Math.atan2(ps.y - center.y, ps.x - center.x);
        ps.x = center.x + a.radius * Math.cos(a.start);
        ps.y = center.y + a.radius * Math.sin(a.start);
      }
      if (pe) {
        const rawEnd = Math.atan2(pe.y - center.y, pe.x - center.x);
        let sweep = ((rawEnd - a.start) % twoPi + twoPi) % twoPi;
        if (sweep < 1e-4) sweep = Math.PI;
        a.end = a.start + sweep;
        pe.x = center.x + a.radius * Math.cos(rawEnd);
        pe.y = center.y + a.radius * Math.sin(rawEnd);
      }
    }
  }

  /** Ensure or update a FixedPoint constraint pinning `ptId` to `(x, y)` on the raster. */
  private setPointFixedToRaster(ptId: number, x: number, y: number): void {
    for (const c of this.constraints) {
      if ('FixedPoint' in c) {
        const arr = (c as { FixedPoint: number[] }).FixedPoint;
        if (arr[0] === ptId) {
          arr[1] = x;
          arr[2] = y;
          return;
        }
      }
    }
    this.constraints.push({ FixedPoint: [ptId, x, y] });
  }

  /** Update an existing FixedPoint constraint when the user drags a pinned point onto a new raster spot. */
  private updateExistingFixedPoint(ptId: number, x: number, y: number): void {
    for (const c of this.constraints) {
      if ('FixedPoint' in c) {
        const arr = (c as { FixedPoint: number[] }).FixedPoint;
        if (arr[0] === ptId) {
          arr[1] = x;
          arr[2] = y;
        }
      }
    }
  }

  private getOrCreatePoint(
    x: number,
    y: number,
    altKey = false,
    forceNew = false,
  ): SavedSketchPoint {
    if (!altKey && !forceNew) {
      const existing = this.findNearPoint(x, y, 16);
      if (existing) return existing;
    }
    const snapped = forceNew ? { x, y } : this.snapInputCoord(x, y, altKey);
    const pt: SavedSketchPoint = { id: this.nextPointId(), x: snapped.x, y: snapped.y };
    this.points.push(pt);
    if (this.autoPinRaster && this.viewer.getPage() && !altKey && !forceNew) {
      this.setPointFixedToRaster(pt.id, pt.x, pt.y);
      return pt;
    }
    // Auto point-on-line / point-on-arc / point-on-circle when placed directly on an existing entity
    if (this.autoConstraints && !altKey && !forceNew) {
      const orig = this.viewer.getOrigin();
      if (!this.viewer.getPage() && Math.hypot(pt.x - orig.x, pt.y - orig.y) < 1e-3) {
        this.constraints.push({ FixedPoint: [pt.id, orig.x, orig.y] });
      } else {
        const hitLine = this.findNearLine(pt.x, pt.y, 8);
        if (hitLine && hitLine.a !== pt.id && hitLine.b !== pt.id) {
          const pa = this.points.find((p) => p.id === hitLine.a);
          const pb = this.points.find((p) => p.id === hitLine.b);
          if (pa && pb) {
            const proj = projectPointToSegment(pt.x, pt.y, pa.x, pa.y, pb.x, pb.y);
            pt.x = proj.x;
            pt.y = proj.y;
          }
          this.constraints.push({ PointOnLine: [pt.id, hitLine.id] });
        } else {
          const hitArc = this.findNearArc(pt.x, pt.y, 8);
          if (hitArc && hitArc.center !== pt.id) {
            const c = this.points.find((p) => p.id === hitArc.center);
            if (c) {
              const ang = Math.atan2(pt.y - c.y, pt.x - c.x);
              pt.x = c.x + hitArc.radius * Math.cos(ang);
              pt.y = c.y + hitArc.radius * Math.sin(ang);
            }
            this.constraints.push({ PointOnArc: [pt.id, hitArc.id] });
          } else {
            const hitCircle = this.findNearCircle(pt.x, pt.y, 8);
            if (hitCircle && hitCircle.center !== pt.id) {
              const c = this.points.find((p) => p.id === hitCircle.center);
              if (c) {
                const ang = Math.atan2(pt.y - c.y, pt.x - c.x);
                pt.x = c.x + hitCircle.radius * Math.cos(ang);
                pt.y = c.y + hitCircle.radius * Math.sin(ang);
              }
              this.constraints.push({ PointOnCircle: [pt.id, hitCircle.id] });
            }
          }
        }
      }
    }
    return pt;
  }

  /** Handle pointer drag when in `select` or `origin` mode (live constraint solving + box selection). */
  handleDrag(clientX: number, clientY: number, phase: 'start' | 'move' | 'end'): boolean {
    if (!this.active || (this.tool !== 'select' && this.tool !== 'origin')) return false;
    const r = this.viewer.clientToRaster(clientX, clientY);
    if (!r) return false;
    const to = this.viewer.rasterToScreen.bind(this.viewer);
    const pScreen = to(r.x, r.y);

    if (phase === 'start') {
      this.dragMoved = false;
      if (this.tool === 'origin') {
        this.dragState = { kind: 'origin' };
        const snapped = this.snapInputCoord(r.x, r.y, this.lastMouse?.altKey ?? false);
        this.viewer.setOrigin(snapped.x, snapped.y);
        return true;
      }

      const hitPt = this.findNearPoint(r.x, r.y, 13);
      if (hitPt) {
        this.pushUndo();
        this.dragState = { kind: 'point', id: hitPt.id, lastX: r.x, lastY: r.y };
        return true;
      }

      // Check if user grabbed an arc endpoint handle (Start / End)
      for (const a of this.arcs) {
        const center = this.points.find((p) => p.id === a.center);
        if (!center) continue;
        const sx = center.x + a.radius * Math.cos(a.start);
        const sy = center.y + a.radius * Math.sin(a.start);
        const ex = center.x + a.radius * Math.cos(a.end);
        const ey = center.y + a.radius * Math.sin(a.end);
        const sScr = to(sx, sy);
        const eScr = to(ex, ey);
        if (Math.hypot(pScreen.x - sScr.x, pScreen.y - sScr.y) <= 10) {
          this.pushUndo();
          this.dragState = { kind: 'arc-start', id: a.id };
          return true;
        }
        if (Math.hypot(pScreen.x - eScr.x, pScreen.y - eScr.y) <= 10) {
          this.pushUndo();
          this.dragState = { kind: 'arc-end', id: a.id };
          return true;
        }
      }

      // Check if user grabbed the (0,0) Coordinate System Origin bullseye
      const orig = this.viewer.getOrigin();
      const origScreen = to(orig.x, orig.y);
      if (Math.hypot(pScreen.x - origScreen.x, pScreen.y - origScreen.y) <= 12) {
        this.dragState = { kind: 'origin' };
        return true;
      }

      const hitArc = this.findNearArc(r.x, r.y, 10);
      if (hitArc) {
        this.pushUndo();
        this.dragState = { kind: 'arc-rim', id: hitArc.id };
        return true;
      }
      const hitCircle = this.findNearCircle(r.x, r.y, 10);
      if (hitCircle) {
        this.pushUndo();
        this.dragState = { kind: 'circle', id: hitCircle.id };
        return true;
      }
      const hitLine = this.findNearLine(r.x, r.y, 10);
      if (hitLine) {
        this.pushUndo();
        this.dragState = { kind: 'line', id: hitLine.id, lastX: r.x, lastY: r.y };
        return true;
      }

      // FreeCAD Sketcher Marquee Window / Crossing Box Selection on empty space!
      this.dragState = {
        kind: 'box',
        x0: pScreen.x,
        y0: pScreen.y,
        x1: pScreen.x,
        y1: pScreen.y,
      };
      return true;
    }

    if (phase === 'move' && this.dragState) {
      this.dragMoved = true;
      if (this.dragState.kind === 'box') {
        this.dragState.x1 = pScreen.x;
        this.dragState.y1 = pScreen.y;
        this.viewer.requestRender();
        return true;
      }
      if (this.dragState.kind === 'origin') {
        // Snap the origin to sketch points (and lines/arcs/raster/grid) while
        // dragging, matching the click-path snap behaviour.
        const snapped = this.snapInputCoord(r.x, r.y, this.lastMouse?.altKey ?? false);
        this.viewer.setOrigin(snapped.x, snapped.y);
        return true;
      }
      if (this.dragState.kind === 'point') {
        const pt = this.points.find((p) => p.id === (this.dragState as { id: number }).id);
        if (pt) {
          if (this.selectedPoints.includes(pt.id) && this.selectedPoints.length > 1) {
            const dx = r.x - this.dragState.lastX;
            const dy = r.y - this.dragState.lastY;
            this.dragState.lastX = r.x;
            this.dragState.lastY = r.y;
            const moveIds = new Set<number>();
            for (const pid of this.selectedPoints) {
              for (const cid of this.getCoincidentCluster(pid)) moveIds.add(cid);
            }
            for (const pid of moveIds) {
              const sp = this.points.find((p) => p.id === pid);
              if (sp) {
                sp.x += dx;
                sp.y += dy;
                this.updateExistingFixedPoint(sp.id, sp.x, sp.y);
              }
            }
          } else {
            const alt = this.lastMouse?.altKey ?? false;
            const rSnap =
              !alt && this.rasterSnapEnabled && this.grayCache
                ? this.snapRasterPoint(r, false)
                : { x: r.x, y: r.y, snapped: false };
            for (const cid of this.getCoincidentCluster(pt.id)) {
              const cp = this.points.find((p) => p.id === cid);
              if (cp) {
                cp.x = rSnap.x;
                cp.y = rSnap.y;
                this.updateExistingFixedPoint(cp.id, cp.x, cp.y);
              }
            }
          }
          this.syncArcsWithEndpoints();
          void this.solveSilent();
          this.viewer.requestRender();
        }
      } else if (this.dragState.kind === 'circle') {
        const c = this.circles.find((x) => x.id === (this.dragState as { id: number }).id);
        const center = c ? this.points.find((p) => p.id === c.center) : null;
        if (c && center) {
          c.radius = Math.max(1, Math.hypot(r.x - center.x, r.y - center.y));
          void this.solveSilent();
          this.viewer.requestRender();
        }
      } else if (
        this.dragState.kind === 'arc-start' ||
        this.dragState.kind === 'arc-end' ||
        this.dragState.kind === 'arc-rim'
      ) {
        const a = this.arcs.find((x) => x.id === (this.dragState as { id: number }).id);
        const center = a ? this.points.find((p) => p.id === a.center) : null;
        if (a && center) {
          if (this.dragState.kind === 'arc-rim') {
            a.radius = Math.max(1, Math.hypot(r.x - center.x, r.y - center.y));
          } else if (this.dragState.kind === 'arc-start') {
            a.start = Math.atan2(r.y - center.y, r.x - center.x);
          } else {
            const ang = Math.atan2(r.y - center.y, r.x - center.x);
            let sweep = ((ang - a.start) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
            if (sweep < 1e-3) sweep = Math.PI * 2;
            a.end = a.start + sweep;
          }
          if (a.startPt !== undefined) {
            const ps = this.points.find((p) => p.id === a.startPt);
            if (ps) {
              ps.x = center.x + a.radius * Math.cos(a.start);
              ps.y = center.y + a.radius * Math.sin(a.start);
            }
          }
          if (a.endPt !== undefined) {
            const pe = this.points.find((p) => p.id === a.endPt);
            if (pe) {
              pe.x = center.x + a.radius * Math.cos(a.end);
              pe.y = center.y + a.radius * Math.sin(a.end);
            }
          }
          void this.solveSilent();
          this.viewer.requestRender();
        }
      } else if (this.dragState.kind === 'line') {
        const l = this.lines.find((x) => x.id === (this.dragState as { id: number }).id);
        if (l) {
          const dx = r.x - this.dragState.lastX;
          const dy = r.y - this.dragState.lastY;
          this.dragState.lastX = r.x;
          this.dragState.lastY = r.y;
          const basePtIds = new Set<number>([l.a, l.b]);
          if (this.selectedLines.includes(l.id)) {
            for (const lid of this.selectedLines) {
              const sl = this.lines.find((x) => x.id === lid);
              if (sl) {
                basePtIds.add(sl.a);
                basePtIds.add(sl.b);
              }
            }
            for (const pid of this.selectedPoints) basePtIds.add(pid);
          }
          const movePtIds = new Set<number>();
          for (const pid of basePtIds) {
            for (const cid of this.getCoincidentCluster(pid)) movePtIds.add(cid);
          }
          for (const pid of movePtIds) {
            const pt = this.points.find((p) => p.id === pid);
            if (pt) {
              pt.x += dx;
              pt.y += dy;
              this.updateExistingFixedPoint(pt.id, pt.x, pt.y);
            }
          }
          this.syncArcsWithEndpoints();
          void this.solveSilent();
          this.viewer.requestRender();
        }
      }
      return true;
    }

    if (phase === 'end' && this.dragState) {
      // A click (down+up without movement) toggles selection of the entity.
      if (!this.dragMoved && this.dragState.kind !== 'box' && this.dragState.kind !== 'origin') {
        const kind = this.dragState.kind;
        const id = (this.dragState as { id: number }).id;
        this.dragState = null;
        this.dragMoved = false;
        // Revert the pushUndo() that `start` made in anticipation of a drag.
        this.undoStack.pop();
        if (kind === 'point') toggleInArray(this.selectedPoints, id);
        else if (kind === 'line') toggleInArray(this.selectedLines, id);
        else if (kind === 'circle') toggleInArray(this.selectedCircles, id);
        else if (kind === 'arc-start' || kind === 'arc-end' || kind === 'arc-rim')
          toggleInArray(this.selectedArcs, id);
        this.render();
        this.viewer.requestRender();
        return true;
      }
      if (this.dragState.kind === 'box') {
        const { x0, y0, x1, y1 } = this.dragState;
        this.dragState = null;
        if (Math.hypot(x1 - x0, y1 - y0) > 6) {
          this.applyBoxSelection(x0, y0, x1, y1);
          this.render();
          this.viewer.requestRender();
          return true;
        }
        return false;
      }
      // Auto-Coincident when dropping a dragged point onto another existing point!
      if (this.dragState.kind === 'point' && this.autoConstraints && !(this.lastMouse?.altKey)) {
        const draggedId = this.dragState.id;
        const draggedPt = this.points.find((p) => p.id === draggedId);
        if (draggedPt) {
          const cluster = new Set(this.getCoincidentCluster(draggedId));
          const ds = to(draggedPt.x, draggedPt.y);
          for (const other of this.points) {
            if (cluster.has(other.id)) continue;
            const os = to(other.x, other.y);
            if (Math.hypot(ds.x - os.x, ds.y - os.y) <= 12) {
              draggedPt.x = other.x;
              draggedPt.y = other.y;
              this.constraints.push({ Coincident: [draggedId, other.id] });
              void this.solveSilent();
              break;
            }
          }
        }
      }
      this.dragState = null;
      this.render();
      this.viewer.requestRender();
      this.onChange?.();
      return true;
    }
    return false;
  }

  /** FreeCAD Window (Left->Right) and Crossing (Right->Left) Box Selection. */
  private applyBoxSelection(x0: number, y0: number, x1: number, y1: number): void {
    const to = this.viewer.rasterToScreen.bind(this.viewer);
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const crossing = x1 < x0; // Right-to-left drag = crossing selection

    const inBox = (sx: number, sy: number): boolean =>
      sx >= minX && sx <= maxX && sy >= minY && sy <= maxY;

    for (const p of this.points) {
      const s = to(p.x, p.y);
      if (inBox(s.x, s.y) && !this.selectedPoints.includes(p.id)) {
        this.selectedPoints.push(p.id);
      }
    }
    for (const l of this.lines) {
      const pa = this.points.find((p) => p.id === l.a);
      const pb = this.points.find((p) => p.id === l.b);
      if (!pa || !pb) continue;
      const a = to(pa.x, pa.y);
      const b = to(pb.x, pb.y);
      const hit = crossing
        ? inBox(a.x, a.y) ||
          inBox(b.x, b.y) ||
          segmentIntersectsRect(a.x, a.y, b.x, b.y, minX, minY, maxX, maxY)
        : inBox(a.x, a.y) && inBox(b.x, b.y);
      if (hit && !this.selectedLines.includes(l.id)) {
        this.selectedLines.push(l.id);
      }
    }
    const zoom = this.viewer.getEffectiveZoom();
    for (const c of this.circles) {
      const center = this.points.find((p) => p.id === c.center);
      if (!center) continue;
      const sc = to(center.x, center.y);
      const rScr = c.radius * zoom;
      const hit = crossing
        ? sc.x + rScr >= minX && sc.x - rScr <= maxX && sc.y + rScr >= minY && sc.y - rScr <= maxY
        : sc.x - rScr >= minX && sc.x + rScr <= maxX && sc.y - rScr >= minY && sc.y + rScr <= maxY;
      if (hit && !this.selectedCircles.includes(c.id)) {
        this.selectedCircles.push(c.id);
      }
    }
    for (const a of this.arcs) {
      const center = this.points.find((p) => p.id === a.center);
      if (!center) continue;
      const sc = to(center.x, center.y);
      const rScr = a.radius * zoom;
      const hit = crossing
        ? sc.x + rScr >= minX && sc.x - rScr <= maxX && sc.y + rScr >= minY && sc.y - rScr <= maxY
        : sc.x - rScr >= minX && sc.x + rScr <= maxX && sc.y - rScr >= minY && sc.y + rScr <= maxY;
      if (hit && !this.selectedArcs.includes(a.id)) {
        this.selectedArcs.push(a.id);
      }
    }
  }

  private addAutoConstraintForSegment(a: SavedSketchPoint, b: SavedSketchPoint, lineId: number): void {
    // When reconstructing over a PDF/raster scan, keep clicked endpoints at their exact raster positions
    // unless the user explicitly applies a Horizontal/Vertical constraint from the toolbar.
    if (!this.autoConstraints || this.viewer.getPage() !== null) return;
    // Measure the direction in the coordinate-system frame (screen axes) so that
    // near-horizontal/vertical detection follows the fixed axes, not the raster.
    const t = this.viewer.getRasterTransform();
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const screenX = t[0] * dx + t[2] * dy;
    const screenY = t[1] * dx + t[3] * dy;
    const len = Math.hypot(screenX, screenY);
    if (len > 2) {
      if (Math.abs(screenY) / len < Math.sin((5 * Math.PI) / 180)) {
        this.constraints.push({ Horizontal: lineId });
      } else if (Math.abs(screenX) / len < Math.sin((5 * Math.PI) / 180)) {
        this.constraints.push({ Vertical: lineId });
      }
    }
  }

  /** Handle entity selection (and FreeCAD Continuous Constraint Mode) in `select` mode. */
  private handleSelectClick(rx: number, ry: number): boolean {
    const pScreen = this.viewer.rasterToScreen(rx, ry);
    // 1. Check if the user clicked an on-canvas Dimension Badge to edit its value!
    for (const b of this.dimBadgeRects) {
      if (
        pScreen.x >= b.x &&
        pScreen.x <= b.x + b.w &&
        pScreen.y >= b.y &&
        pScreen.y <= b.y + b.h
      ) {
        this.editingConstraintIdx = b.cIdx;
        this.render();
        return true;
      }
    }

    const afterSelect = (): boolean => {
      if (this.activeConstraintTool && this.canApplyConstraintNow(this.activeConstraintTool)) {
        this.applyConstraintAction(this.activeConstraintTool);
      } else {
        this.render();
        this.viewer.requestRender();
      }
      return true;
    };

    const hitPt = this.findNearPoint(rx, ry, 13);
    if (hitPt) {
      toggleInArray(this.selectedPoints, hitPt.id);
      return afterSelect();
    }
    const hitLine = this.findNearLine(rx, ry, 10);
    if (hitLine) {
      toggleInArray(this.selectedLines, hitLine.id);
      return afterSelect();
    }
    const hitCircle = this.findNearCircle(rx, ry, 10);
    if (hitCircle) {
      toggleInArray(this.selectedCircles, hitCircle.id);
      return afterSelect();
    }
    const hitArc = this.findNearArc(rx, ry, 10);
    if (hitArc) {
      toggleInArray(this.selectedArcs, hitArc.id);
      return afterSelect();
    }
    if (
      this.selectedPoints.length > 0 ||
      this.selectedLines.length > 0 ||
      this.selectedCircles.length > 0 ||
      this.selectedArcs.length > 0
    ) {
      this.clearSelection();
      this.render();
      this.viewer.requestRender();
      return true;
    }
    return false;
  }

  /** Handle a viewer click; returns true when consumed. */
  handleClick(clientX: number, clientY: number, altKey = false): boolean {
    if (!this.active) return false;
    const rawR = this.viewer.clientToRaster(clientX, clientY);
    if (!rawR) return true;

    if (this.tool === 'select') {
      return this.handleSelectClick(rawR.x, rawR.y);
    }

    const r = this.snapInputCoord(rawR.x, rawR.y, altKey);

    if (this.tool === 'origin') {
      this.viewer.setOrigin(r.x, r.y);
      this.onStatus(`(0,0) → (${r.x.toFixed(1)}, ${r.y.toFixed(1)}) px`);
      this.render();
      this.viewer.requestRender();
      return true;
    }

    if (this.tool === 'point') {
      this.pushUndo();
      this.getOrCreatePoint(rawR.x, rawR.y, altKey);
      void this.solveSilent();
      this.render();
      this.viewer.requestRender();
      this.notifyDof();
      this.onChange?.();
      return true;
    }

    if (this.tool === 'trim') {
      const hitLine = this.findNearLine(rawR.x, rawR.y, 10);
      if (hitLine) {
        this.pushUndo();
        this.trimLineAtClick(hitLine, rawR.x, rawR.y);
        void this.solveSilent();
        this.render();
        this.viewer.requestRender();
        this.notifyDof();
        this.onChange?.();
      }
      return true;
    }

    if (this.tool === 'fillet') {
      const cornerPt = this.findNearPoint(rawR.x, rawR.y, 16);
      if (cornerPt) {
        const connected = this.lines.filter((l) => l.a === cornerPt.id || l.b === cornerPt.id);
        if (connected.length >= 2) {
          this.pushUndo();
          this.createCornerFillet(cornerPt, connected[0], connected[1]);
          void this.solveSilent();
          this.render();
          this.viewer.requestRender();
          this.notifyDof();
          this.onChange?.();
        }
      }
      return true;
    }

    if (this.tool === 'mirror') {
      const axis = this.findNearLine(rawR.x, rawR.y, 12);
      if (axis) {
        this.pushUndo();
        this.mirrorSelection(axis);
        this.setTool('select');
        void this.solveSilent();
        this.render();
        this.viewer.requestRender();
        this.notifyDof();
        this.onChange?.();
      } else {
        this.onStatus(t(this.locale, 'sketch.mirror.hint'));
      }
      return true;
    }

    if (this.tool === 'circle') {
      if (!this.pending) {
        this.pending = { x: r.x, y: r.y };
        this.onStatus(t(this.locale, 'sketch.hint'));
      } else {
        this.pushUndo();
        const center = this.getOrCreatePoint(this.pending.x, this.pending.y, altKey);
        const radius = Math.max(1, Math.hypot(r.x - center.x, r.y - center.y));
        this.circles.push({
          id: this.nextCircleId(),
          center: center.id,
          radius,
          construction: this.constructionMode,
        });
        this.pending = null;
        void this.solveSilent();
        this.render();
        this.onStatus(t(this.locale, 'status.ready'));
        this.notifyDof();
        this.onChange?.();
      }
      this.viewer.requestRender();
      return true;
    }

    if (this.tool === 'arc3pt') {
      if (!this.arc3PtPending) {
        this.pushUndo();
        const p1 = this.getOrCreatePoint(rawR.x, rawR.y, altKey);
        this.arc3PtPending = { p1Id: p1.id, x1: p1.x, y1: p1.y };
        this.onStatus('Luk 3 tačke: kliknite 2. krajnju tačku (ili M za centar-početak-kraj)');
      } else if (this.arc3PtPending.p2Id === undefined) {
        if (Math.hypot(r.x - this.arc3PtPending.x1, r.y - this.arc3PtPending.y1) < 1.5) {
          return true;
        }
        const p2 = this.getOrCreatePoint(rawR.x, rawR.y, altKey);
        this.arc3PtPending = {
          ...this.arc3PtPending,
          p2Id: p2.id,
          x2: p2.x,
          y2: p2.y,
        };
        this.onStatus('Luk 3 tačke: kliknite 3. tačku na luku');
      } else {
        const { p1Id, x1, y1, p2Id, x2, y2 } = this.arc3PtPending;
        const circ = circumcircleArc(x1, y1, x2!, y2!, r.x, r.y);
        if (circ) {
          const cPt = this.getOrCreatePoint(circ.cx, circ.cy, true, true);
          const arcId = this.nextArcId();
          const a1 = Math.atan2(y1 - circ.cy, x1 - circ.cx);
          const startMatchesP1 = Math.abs( Math.atan2(Math.sin(circ.startAngle - a1), Math.cos(circ.startAngle - a1)) ) < 1e-2;
          this.arcs.push({
            id: arcId,
            center: cPt.id,
            radius: circ.radius,
            start: circ.startAngle,
            end: circ.endAngle,
            startPt: startMatchesP1 ? p1Id : p2Id,
            endPt: startMatchesP1 ? p2Id : p1Id,
            construction: this.constructionMode,
          });
          this.constraints.push({ PointOnArc: [p1Id, arcId] });
          this.constraints.push({ PointOnArc: [p2Id!, arcId] });
        }
        this.arc3PtPending = null;
        this.polyArcPending = null;
        void this.solveSilent();
        this.render();
        this.onStatus(t(this.locale, 'status.ready'));
        this.notifyDof();
        this.onChange?.();
      }
      this.viewer.requestRender();
      return true;
    }

    if (this.tool === 'arc') {
      if (!this.pending && !this.arcStartPending) {
        this.pending = { x: r.x, y: r.y };
        this.onStatus('Luk (centar): kliknite početnu tačku na luku (ili M za luk 3 tačke)');
      } else if (this.pending && !this.arcStartPending) {
        this.pushUndo();
        const center = this.getOrCreatePoint(this.pending.x, this.pending.y, altKey);
        const startPt = this.getOrCreatePoint(rawR.x, rawR.y, altKey);
        const radius = Math.max(1, Math.hypot(startPt.x - center.x, startPt.y - center.y));
        const startAngle = Math.atan2(startPt.y - center.y, startPt.x - center.x);
        this.arcStartPending = {
          centerId: center.id,
          startPtId: startPt.id,
          radius,
          startAngle,
        };
        this.pending = null;
        this.onStatus('Luk: kliknite krajnji ugao (držite Alt za suprotan smer)');
      } else if (this.arcStartPending) {
        const center = this.points.find((p) => p.id === this.arcStartPending!.centerId)!;
        const rawEnd = Math.atan2(r.y - center.y, r.x - center.x);
        let sweep =
          ((rawEnd - this.arcStartPending.startAngle) % (2 * Math.PI) + 2 * Math.PI) %
          (2 * Math.PI);
        if (sweep < 1e-3) sweep = Math.PI;
        const startAngle = altKey ? rawEnd : this.arcStartPending.startAngle;
        const endAngle = altKey ? rawEnd + (2 * Math.PI - sweep) : startAngle + sweep;
        const endPt = this.getOrCreatePoint(
          center.x + this.arcStartPending.radius * Math.cos(rawEnd),
          center.y + this.arcStartPending.radius * Math.sin(rawEnd),
          altKey,
        );
        const arcId = this.nextArcId();
        const sPtId = this.arcStartPending.startPtId;
        this.arcs.push({
          id: arcId,
          center: center.id,
          radius: this.arcStartPending.radius,
          start: startAngle,
          end: endAngle,
          startPt: altKey ? endPt.id : sPtId,
          endPt: altKey ? sPtId : endPt.id,
          construction: this.constructionMode,
        });
        if (sPtId !== undefined) {
          this.constraints.push({ PointOnArc: [sPtId, arcId] });
        }
        this.constraints.push({ PointOnArc: [endPt.id, arcId] });
        this.arcStartPending = null;
        void this.solveSilent();
        this.render();
        this.onStatus(t(this.locale, 'status.ready'));
        this.notifyDof();
        this.onChange?.();
      }
      this.viewer.requestRender();
      return true;
    }

    if (this.tool === 'rect') {
      if (!this.pending) {
        const snapPt = !altKey ? this.findNearPoint(rawR.x, rawR.y, 16) : null;
        this.pending = {
          x: snapPt ? snapPt.x : r.x,
          y: snapPt ? snapPt.y : r.y,
          pointId: snapPt?.id,
        };
        this.onStatus(t(this.locale, 'sketch.hint'));
      } else {
        const x0 = this.pending.x;
        const y0 = this.pending.y;
        const x1 = r.x;
        const y1 = r.y;
        if (Math.abs(x1 - x0) > 1 && Math.abs(y1 - y0) > 1) {
          this.pushUndo();
          const p1 =
            (this.pending.pointId !== undefined
              ? this.points.find((p) => p.id === this.pending!.pointId)
              : null) ?? this.getOrCreatePoint(x0, y0, altKey);
          const p2 = this.getOrCreatePoint(x1, y0, true, true);
          const p3 = this.getOrCreatePoint(x1, y1, altKey);
          const p4 = this.getOrCreatePoint(x0, y1, true, true);
          const l1 = this.nextLineId();
          this.lines.push({ id: l1, a: p1.id, b: p2.id, construction: this.constructionMode });
          const l2 = this.nextLineId();
          this.lines.push({ id: l2, a: p2.id, b: p3.id, construction: this.constructionMode });
          const l3 = this.nextLineId();
          this.lines.push({ id: l3, a: p3.id, b: p4.id, construction: this.constructionMode });
          const l4 = this.nextLineId();
          this.lines.push({ id: l4, a: p4.id, b: p1.id, construction: this.constructionMode });
          if (this.autoConstraints && !altKey) {
            this.constraints.push({ Horizontal: l1 });
            this.constraints.push({ Vertical: l2 });
            this.constraints.push({ Horizontal: l3 });
            this.constraints.push({ Vertical: l4 });
          }
        }
        this.pending = null;
        void this.solveSilent();
        this.render();
        this.onStatus(t(this.locale, 'status.ready'));
        this.notifyDof();
        this.onChange?.();
      }
      this.viewer.requestRender();
      return true;
    }

    if (this.tool === 'centerRect') {
      if (!this.pending) {
        this.pending = { x: r.x, y: r.y };
        this.onStatus(t(this.locale, 'sketch.hint'));
      } else {
        const cx = this.pending.x;
        const cy = this.pending.y;
        const dx = Math.abs(r.x - cx);
        const dy = Math.abs(r.y - cy);
        if (dx > 1 && dy > 1) {
          this.pushUndo();
          const cPt = this.getOrCreatePoint(cx, cy, altKey);
          const p1 = this.getOrCreatePoint(cx - dx, cy - dy, true, true);
          const p2 = this.getOrCreatePoint(cx + dx, cy - dy, true, true);
          const p3 = this.getOrCreatePoint(cx + dx, cy + dy, true, true);
          const p4 = this.getOrCreatePoint(cx - dx, cy + dy, true, true);
          const l1 = this.nextLineId();
          this.lines.push({ id: l1, a: p1.id, b: p2.id, construction: this.constructionMode });
          const l2 = this.nextLineId();
          this.lines.push({ id: l2, a: p2.id, b: p3.id, construction: this.constructionMode });
          const l3 = this.nextLineId();
          this.lines.push({ id: l3, a: p3.id, b: p4.id, construction: this.constructionMode });
          const l4 = this.nextLineId();
          this.lines.push({ id: l4, a: p4.id, b: p1.id, construction: this.constructionMode });
          if (this.autoConstraints && !altKey) {
            this.constraints.push({ Horizontal: l1 });
            this.constraints.push({ Vertical: l2 });
            this.constraints.push({ Horizontal: l3 });
            this.constraints.push({ Vertical: l4 });
            this.constraints.push({ SymmetricPoints: [p1.id, p3.id, cPt.id] });
          }
        }
        this.pending = null;
        void this.solveSilent();
        this.render();
        this.onStatus(t(this.locale, 'status.ready'));
        this.notifyDof();
        this.onChange?.();
      }
      this.viewer.requestRender();
      return true;
    }

    if (this.tool === 'slot') {
      if (!this.pending) {
        this.pending = { x: r.x, y: r.y };
        this.onStatus(t(this.locale, 'sketch.hint'));
      } else {
        const ax = this.pending.x;
        const ay = this.pending.y;
        const bx = r.x;
        const by = r.y;
        const len = Math.hypot(bx - ax, by - ay);
        if (len > 4) {
          this.pushUndo();
          const rad = Math.max(8, len * 0.25);
          const angle = Math.atan2(by - ay, bx - ax);
          const nx = -Math.sin(angle) * rad;
          const ny = Math.cos(angle) * rad;
          const c1 = this.getOrCreatePoint(ax, ay, altKey);
          const c2 = this.getOrCreatePoint(bx, by, altKey);
          const p1 = this.getOrCreatePoint(ax + nx, ay + ny, true, true);
          const p2 = this.getOrCreatePoint(bx + nx, by + ny, true, true);
          const p3 = this.getOrCreatePoint(bx - nx, by - ny, true, true);
          const p4 = this.getOrCreatePoint(ax - nx, ay - ny, true, true);
          const lTop = this.nextLineId();
          this.lines.push({ id: lTop, a: p1.id, b: p2.id, construction: this.constructionMode });
          const lBot = this.nextLineId();
          this.lines.push({ id: lBot, a: p3.id, b: p4.id, construction: this.constructionMode });
          const aRight = this.nextArcId();
          this.arcs.push({
            id: aRight,
            center: c2.id,
            radius: rad,
            start: angle - Math.PI / 2,
            end: angle + Math.PI / 2,
            startPt: p3.id,
            endPt: p2.id,
            construction: this.constructionMode,
          });
          const aLeft = this.nextArcId();
          this.arcs.push({
            id: aLeft,
            center: c1.id,
            radius: rad,
            start: angle + Math.PI / 2,
            end: angle + (3 * Math.PI) / 2,
            startPt: p1.id,
            endPt: p4.id,
            construction: this.constructionMode,
          });
          this.constraints.push({ PointOnArc: [p2.id, aRight] });
          this.constraints.push({ PointOnArc: [p3.id, aRight] });
          this.constraints.push({ PointOnArc: [p1.id, aLeft] });
          this.constraints.push({ PointOnArc: [p4.id, aLeft] });
          if (this.autoConstraints && !altKey) {
            this.constraints.push({ Parallel: [lTop, lBot] });
            this.constraints.push({ EqualRadiusArc: [aRight, aLeft] });
            this.constraints.push({ TangentLineArc: [lTop, aRight] });
            this.constraints.push({ TangentLineArc: [lBot, aRight] });
            this.constraints.push({ TangentLineArc: [lTop, aLeft] });
            this.constraints.push({ TangentLineArc: [lBot, aLeft] });
          }
        }
        this.pending = null;
        void this.solveSilent();
        this.render();
        this.onStatus(t(this.locale, 'status.ready'));
        this.notifyDof();
        this.onChange?.();
      }
      this.viewer.requestRender();
      return true;
    }

    if (this.tool === 'polygon') {
      if (!this.pending) {
        this.pending = { x: r.x, y: r.y };
        this.onStatus(t(this.locale, 'sketch.hint'));
      } else {
        const cx = this.pending.x;
        const cy = this.pending.y;
        const rad = Math.hypot(r.x - cx, r.y - cy);
        if (rad > 2) {
          this.pushUndo();
          const n = Math.max(3, Math.min(12, this.polygonSides));
          const baseAngle = Math.atan2(r.y - cy, r.x - cx);
          const centerPt = this.getOrCreatePoint(cx, cy, altKey);
          const constCircleId = this.nextCircleId();
          this.circles.push({
            id: constCircleId,
            center: centerPt.id,
            radius: rad,
            construction: true,
          });
          const verts: SavedSketchPoint[] = [];
          for (let i = 0; i < n; i += 1) {
            const ang = baseAngle + (i * 2 * Math.PI) / n;
            const vp = this.getOrCreatePoint(
              cx + rad * Math.cos(ang),
              cy + rad * Math.sin(ang),
              true,
              true,
            );
            verts.push(vp);
            if (this.autoConstraints && !altKey) {
              this.constraints.push({ PointOnCircle: [vp.id, constCircleId] });
            }
          }
          const sideIds: number[] = [];
          for (let i = 0; i < n; i += 1) {
            const lid = this.nextLineId();
            this.lines.push({
              id: lid,
              a: verts[i].id,
              b: verts[(i + 1) % n].id,
              construction: this.constructionMode,
            });
            sideIds.push(lid);
          }
          if (this.autoConstraints && !altKey) {
            for (let i = 1; i < sideIds.length; i += 1) {
              this.constraints.push({ EqualLength: [sideIds[0], sideIds[i]] });
            }
          }
        }
        this.pending = null;
        void this.solveSilent();
        this.render();
        this.onStatus(t(this.locale, 'status.ready'));
        this.notifyDof();
        this.onChange?.();
      }
      this.viewer.requestRender();
      return true;
    }

    if (this.tool === 'polyline') {
      // Rim-point click completes a pending 3-point tangent/free arc.
      if (this.polyArcPending) {
        const pa = this.polyArcPending;
        const circ = circumcircleArc(pa.ax, pa.ay, pa.bx, pa.by, r.x, r.y);
        if (circ) {
          const cPt = this.getOrCreatePoint(circ.cx, circ.cy, true, true);
          const arcId = this.nextArcId();
          const a1 = Math.atan2(pa.ay - circ.cy, pa.ax - circ.cx);
          const startMatchesA =
            Math.abs(Math.atan2(Math.sin(circ.startAngle - a1), Math.cos(circ.startAngle - a1))) < 1e-2;
          this.arcs.push({
            id: arcId,
            center: cPt.id,
            radius: circ.radius,
            start: circ.startAngle,
            end: circ.endAngle,
            startPt: startMatchesA ? pa.aId : pa.bId,
            endPt: startMatchesA ? pa.bId : pa.aId,
            construction: this.constructionMode,
          });
          this.constraints.push({ PointOnArc: [pa.aId, arcId] });
          this.constraints.push({ PointOnArc: [pa.bId, arcId] });
          if (pa.tangent) {
            if (pa.prevLineId !== undefined) {
              this.constraints.push({ TangentLineArc: [pa.prevLineId, arcId] });
            } else if (pa.prevArcId !== undefined) {
              this.constraints.push({ TangentArcArc: [pa.prevArcId, arcId] });
            }
          }
          // Continue the chain from the arc's end point.
          this.pending = {
            x: pa.bx,
            y: pa.by,
            pointId: pa.bId,
            startPointId: pa.startId,
            lastLineId: undefined,
            lastArcId: arcId,
          };
          this.polyArcPending = null;
          this.polyMode = 'line';
          this.resultText = '';
          void this.solveSilent();
          this.render();
          this.notifyDof();
          this.onChange?.();
          this.onStatus(t(this.locale, 'sketch.finishChain'));
        } else {
          this.onStatus('Luk: tri tačke su kolinearne — kliknite drugu tačku na luku');
        }
        this.viewer.requestRender();
        return true;
      }

      if (!this.pending) {
        const snapPt = !altKey ? this.findNearPoint(rawR.x, rawR.y, 16) : null;
        this.pending = {
          x: snapPt ? snapPt.x : r.x,
          y: snapPt ? snapPt.y : r.y,
          pointId: snapPt?.id,
          startPointId: snapPt?.id,
        };
        this.polyMode = 'line';
        this.render();
        this.onStatus(t(this.locale, 'sketch.finishChain'));
      } else {
        const prevPt =
          this.pending.pointId !== undefined
            ? this.points.find((p) => p.id === this.pending!.pointId)
            : null;
        const startX = prevPt ? prevPt.x : this.pending.x;
        const startY = prevPt ? prevPt.y : this.pending.y;
        if (Math.hypot(r.x - startX, r.y - startY) < 1.5) {
          return true;
        }
        this.pushUndo();
        const a = prevPt ?? this.getOrCreatePoint(startX, startY, altKey);
        const b = this.getOrCreatePoint(rawR.x, rawR.y, altKey);
        // Pin the shared joint on every directional continuation (tangent,
        // perpendicular, tangent-arc, free-arc) so the solve swings the new
        // segment into place instead of sliding the joint along the previous
        // entity. Plain `line` mode adds no directional constraint and keeps its
        // vertices draggable, so it is left alone.
        const isContinuation =
          this.pending.lastLineId !== undefined || this.pending.lastArcId !== undefined;
        if (isContinuation && this.polyMode !== 'line') {
          this.setPointFixedToRaster(a.id, a.x, a.y);
        }
        let newLineId: number | undefined;
        if (a.id !== b.id) {
          if (this.polyMode === 'arc' || this.polyMode === 'arc-free') {
            // 3-point arc: the joint is one endpoint; this click fixes the
            // second endpoint, and the next click defines the rim point.
            this.polyArcPending = {
              aId: a.id,
              ax: a.x,
              ay: a.y,
              bId: b.id,
              bx: b.x,
              by: b.y,
              startId: this.pending.startPointId ?? a.id,
              prevLineId: this.pending.lastLineId,
              prevArcId: this.pending.lastArcId,
              tangent: this.polyMode === 'arc',
            };
            this.pending = null;
            this.onStatus(
              this.polyMode === 'arc'
                ? 'Tangentni luk: kliknite tačku na luku'
                : 'Luk: kliknite tačku na luku',
            );
            this.render();
            this.viewer.requestRender();
            return true;
          } else {
            const lineId = this.nextLineId();
            this.lines.push({
              id: lineId,
              a: a.id,
              b: b.id,
              construction: this.constructionMode,
            });
            newLineId = lineId;
            if (this.polyMode === 'perp') {
              if (this.pending.lastLineId !== undefined) {
                this.constraints.push({ Perpendicular: [this.pending.lastLineId, lineId] });
              } else if (this.pending.lastArcId !== undefined) {
                this.constraints.push({ PerpendicularLineArc: [lineId, this.pending.lastArcId] });
              }
            } else if (this.polyMode === 'tangent') {
              if (this.pending.lastLineId !== undefined) {
                // Tangent to a line == collinear (continue straight).
                this.constraints.push({ Collinear: [this.pending.lastLineId, lineId] });
              } else if (this.pending.lastArcId !== undefined) {
                this.constraints.push({ TangentLineArc: [lineId, this.pending.lastArcId] });
              }
            } else {
              this.addAutoConstraintForSegment(a, b, lineId);
            }
          }
        }
        const startId = this.pending.startPointId ?? a.id;
        if (b.id === startId && a.id !== startId) {
          this.pending = null;
          this.onStatus(t(this.locale, 'status.ready'));
        } else {
          this.pending = {
            x: b.x,
            y: b.y,
            pointId: b.id,
            startPointId: startId,
            lastLineId: newLineId,
            lastArcId: undefined,
          };
          this.onStatus(t(this.locale, 'sketch.finishChain'));
        }
        this.resultText = '';
        void this.solveSilent();
        this.render();
        this.notifyDof();
        this.onChange?.();
      }
      this.viewer.requestRender();
      return true;
    }

    // Single 'line' tool: two clicks per line segment.
    if (!this.pending) {
      const snapPt = !altKey ? this.findNearPoint(rawR.x, rawR.y, 16) : null;
      this.pending = {
        x: snapPt ? snapPt.x : r.x,
        y: snapPt ? snapPt.y : r.y,
        pointId: snapPt?.id,
      };
      this.onStatus(t(this.locale, 'sketch.hint'));
    } else {
      const prevPt =
        this.pending.pointId !== undefined
          ? this.points.find((p) => p.id === this.pending!.pointId)
          : null;
      const startX = prevPt ? prevPt.x : this.pending.x;
      const startY = prevPt ? prevPt.y : this.pending.y;
      if (Math.hypot(r.x - startX, r.y - startY) < 1.5) {
        return true;
      }
      this.pushUndo();
      const a = prevPt ?? this.getOrCreatePoint(startX, startY, altKey);
      const b = this.getOrCreatePoint(rawR.x, rawR.y, altKey);
      if (a.id !== b.id) {
        const lineId = this.nextLineId();
        this.lines.push({
          id: lineId,
          a: a.id,
          b: b.id,
          construction: this.constructionMode,
        });
        this.addAutoConstraintForSegment(a, b, lineId);
      }

      this.pending = null;
      this.resultText = '';
      void this.solveSilent();
      this.render();
      this.onStatus(t(this.locale, 'status.ready'));
      this.notifyDof();
      this.onChange?.();
    }
    this.viewer.requestRender();
    return true;
  }

  private createCornerFillet(
    corner: SavedSketchPoint,
    l1: SavedSketchLine,
    l2: SavedSketchLine,
  ): void {
    const p1 = this.points.find((p) => p.id === (l1.a === corner.id ? l1.b : l1.a));
    const p2 = this.points.find((p) => p.id === (l2.a === corner.id ? l2.b : l2.a));
    if (!p1 || !p2) return;
    const len1 = Math.hypot(p1.x - corner.x, p1.y - corner.y);
    const len2 = Math.hypot(p2.x - corner.x, p2.y - corner.y);
    const setback = Math.min(len1, len2) * 0.25;
    if (setback < 1) return;

    const u1x = (p1.x - corner.x) / len1;
    const u1y = (p1.y - corner.y) / len1;
    const u2x = (p2.x - corner.x) / len2;
    const u2y = (p2.y - corner.y) / len2;

    const t1 = this.getOrCreatePoint(corner.x + u1x * setback, corner.y + u1y * setback, true, true);
    const t2 = this.getOrCreatePoint(corner.x + u2x * setback, corner.y + u2y * setback, true, true);
    if (l1.a === corner.id) l1.a = t1.id;
    else l1.b = t1.id;
    if (l2.a === corner.id) l2.a = t2.id;
    else l2.b = t2.id;

    const bx = u1x + u2x;
    const by = u1y + u2y;
    const bLen = Math.hypot(bx, by) || 1;
    const halfAngle = Math.acos(Math.max(-0.99, Math.min(0.99, u1x * u2x + u1y * u2y))) / 2;
    const rad = setback * Math.tan(halfAngle);
    const centerDist = setback / Math.max(0.1, Math.cos(halfAngle));
    const centerPt = this.getOrCreatePoint(
      corner.x + (bx / bLen) * centerDist,
      corner.y + (by / bLen) * centerDist,
      true,
      true,
    );
    const a1 = Math.atan2(t1.y - centerPt.y, t1.x - centerPt.x);
    const a2 = Math.atan2(t2.y - centerPt.y, t2.x - centerPt.x);
    const twoPi = Math.PI * 2;
    const sweep12 = ((a2 - a1) % twoPi + twoPi) % twoPi;
    const useA1Start = sweep12 <= Math.PI;
    const arcId = this.nextArcId();
    this.arcs.push({
      id: arcId,
      center: centerPt.id,
      radius: Math.max(1, rad),
      start: useA1Start ? a1 : a2,
      end: useA1Start ? a1 + sweep12 : a2 + (twoPi - sweep12),
      startPt: useA1Start ? t1.id : t2.id,
      endPt: useA1Start ? t2.id : t1.id,
      construction: false,
    });
    this.constraints.push({ PointOnArc: [t1.id, arcId] });
    this.constraints.push({ PointOnArc: [t2.id, arcId] });
    this.constraints.push({ TangentLineArc: [l1.id, arcId] });
    this.constraints.push({ TangentLineArc: [l2.id, arcId] });
  }

  private trimLineAtClick(target: SavedSketchLine, clickX: number, clickY: number): void {
    const pa = this.points.find((p) => p.id === target.a);
    const pb = this.points.find((p) => p.id === target.b);
    if (!pa || !pb) return;
    // Find intersections with all other lines along parameter t in (0.01, 0.99)
    const ts: number[] = [0, 1];
    for (const other of this.lines) {
      if (other.id === target.id) continue;
      const oa = this.points.find((p) => p.id === other.a);
      const ob = this.points.find((p) => p.id === other.b);
      if (!oa || !ob) continue;
      const tHit = segmentIntersectionT(pa.x, pa.y, pb.x, pb.y, oa.x, oa.y, ob.x, ob.y);
      if (tHit !== null && tHit > 0.01 && tHit < 0.99) {
        ts.push(tHit);
      }
    }
    ts.sort((a, b) => a - b);
    if (ts.length <= 2) {
      // No interior intersections -> remove the segment
      this.lines = this.lines.filter((l) => l.id !== target.id);
      this.pruneOrphanConstraints();
      return;
    }
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len2 = dx * dx + dy * dy || 1;
    const tClick = Math.max(0, Math.min(1, ((clickX - pa.x) * dx + (clickY - pa.y) * dy) / len2));
    // Find interval [ts[k], ts[k+1]] containing tClick
    let k = 0;
    for (let i = 0; i < ts.length - 1; i += 1) {
      if (tClick >= ts[i] && tClick <= ts[i + 1]) {
        k = i;
        break;
      }
    }
    if (k === 0) {
      const splitPt = this.getOrCreatePoint(pa.x + dx * ts[1], pa.y + dy * ts[1], true);
      target.a = splitPt.id;
    } else if (k === ts.length - 2) {
      const splitPt = this.getOrCreatePoint(pa.x + dx * ts[k], pa.y + dy * ts[k], true);
      target.b = splitPt.id;
    } else {
      const pLeft = this.getOrCreatePoint(pa.x + dx * ts[k], pa.y + dy * ts[k], true);
      const pRight = this.getOrCreatePoint(pa.x + dx * ts[k + 1], pa.y + dy * ts[k + 1], true);
      const oldB = target.b;
      target.b = pLeft.id;
      this.lines.push({
        id: this.nextLineId(),
        a: pRight.id,
        b: oldB,
        construction: target.construction,
      });
    }
  }

  private isPointLocked(ptId: number): boolean {
    const cp = this.lastSolve?.constrained_params;
    if (!cp) return false;
    const idx = this.points.findIndex((p) => p.id === ptId);
    if (idx < 0 || 2 * idx + 1 >= cp.length) return false;
    return Boolean(cp[2 * idx] && cp[2 * idx + 1]);
  }

  private isCircleLocked(circleId: number): boolean {
    const cp = this.lastSolve?.constrained_params;
    if (!cp) return false;
    const cIdx = this.circles.findIndex((c) => c.id === circleId);
    if (cIdx < 0) return false;
    const c = this.circles[cIdx];
    const rLocked = Boolean(cp[2 * this.points.length + cIdx]);
    return this.isPointLocked(c.center) && rLocked;
  }

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (
      !this.active &&
      this.points.length === 0 &&
      this.lines.length === 0 &&
      this.circles.length === 0 &&
      this.arcs.length === 0
    ) {
      return;
    }
    const to = this.viewer.rasterToScreen.bind(this.viewer);
    const m = this.viewer.getCombinedTransform();
    const accent = getComputedStyle(this.panel).getPropertyValue('--color-accent').trim() || '#2465c7';
    const success = '#16a34a'; // FreeCAD Fully Constrained Green
    const constructionColor = '#3b82f6'; // FreeCAD Construction Blue
    const selectColor = '#0ea5e9'; // FreeCAD Selection Cyan
    const hoverColor = '#f59f00'; // Hover highlight Gold
    const warning = getComputedStyle(this.panel).getPropertyValue('--color-warning').trim() || '#b54708';
    const danger = getComputedStyle(this.panel).getPropertyValue('--color-danger').trim() || '#dc2626';

    const lineColor = (l: SavedSketchLine): string => {
      if (this.selectedLines.includes(l.id)) return selectColor;
      if (this.hoverEntity?.kind === 'line' && this.hoverEntity.id === l.id) return hoverColor;
      if (this.lastSolve && this.lastSolve.conflicting.length > 0) return danger;
      if (l.construction) return constructionColor;
      const stat = this.lastFit?.primitive_stats?.find((s) => s.kind === 'line' && s.id === l.id);
      if (stat) {
        if (stat.rms_px < 0.3) return success;
        if (stat.rms_px < 1.0) return warning;
        return danger;
      }
      if ((this.lastSolve && this.lastSolve.dof === 0) || (this.isPointLocked(l.a) && this.isPointLocked(l.b))) {
        return success;
      }
      return accent;
    };

    ctx.save();
    ctx.lineWidth = 2.25;
    ctx.font = '12px Arial, sans-serif';

    // Lines.
    for (const l of this.lines) {
      const pa = this.points.find((p) => p.id === l.a);
      const pb = this.points.find((p) => p.id === l.b);
      if (!pa || !pb) continue;
      const a = to(pa.x, pa.y);
      const b = to(pb.x, pb.y);
      const isHi =
        this.selectedLines.includes(l.id) ||
        (this.hoverEntity?.kind === 'line' && this.hoverEntity.id === l.id);
      ctx.strokeStyle = lineColor(l);
      ctx.lineWidth = isHi ? 3.25 : 2.25;
      ctx.setLineDash(l.construction ? [6, 4] : []);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Circles (path built in raster space via combined transform m so zoom/rotation is 100% locked).
    for (const c of this.circles) {
      const center = this.points.find((p) => p.id === c.center);
      if (!center) continue;
      const isSel = this.selectedCircles.includes(c.id);
      const isHov = this.hoverEntity?.kind === 'circle' && this.hoverEntity.id === c.id;
      ctx.strokeStyle = isSel
        ? selectColor
        : isHov
          ? hoverColor
          : c.construction
            ? constructionColor
            : this.isCircleLocked(c.id) || (this.lastSolve && this.lastSolve.dof === 0)
              ? success
              : accent;
      ctx.lineWidth = isSel || isHov ? 3.25 : 2.25;
      ctx.setLineDash(c.construction ? [6, 4] : []);
      ctx.save();
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.beginPath();
      ctx.arc(center.x, center.y, c.radius, 0, Math.PI * 2);
      ctx.restore();
      ctx.stroke();
    }

    // Arcs (path built in raster space via combined transform m so zoom/rotation is 100% locked).
    for (const a of this.arcs) {
      const center = this.points.find((p) => p.id === a.center);
      if (!center) continue;
      const isSel = this.selectedArcs.includes(a.id);
      const isHov = this.hoverEntity?.kind === 'arc' && this.hoverEntity.id === a.id;
      ctx.strokeStyle = isSel
        ? selectColor
        : isHov
          ? hoverColor
          : a.construction
            ? constructionColor
            : this.lastSolve && this.lastSolve.dof === 0
              ? success
              : accent;
      ctx.lineWidth = isSel || isHov ? 3.25 : 2.25;
      ctx.setLineDash(a.construction ? [6, 4] : []);
      ctx.save();
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.beginPath();
      ctx.arc(center.x, center.y, a.radius, a.start, a.end);
      ctx.restore();
      ctx.stroke();

      // Draw endpoint & midpoint grab handles when arc is selected or hovered
      if (isSel || isHov) {
        ctx.save();
        ctx.setLineDash([]);
        const sx = center.x + a.radius * Math.cos(a.start);
        const sy = center.y + a.radius * Math.sin(a.start);
        const ex = center.x + a.radius * Math.cos(a.end);
        const ey = center.y + a.radius * Math.sin(a.end);
        const midAng = a.start + (((a.end - a.start) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) / 2;
        const mx = center.x + a.radius * Math.cos(midAng);
        const my = center.y + a.radius * Math.sin(midAng);
        for (const hp of [to(sx, sy), to(mx, my), to(ex, ey)]) {
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = isSel ? selectColor : hoverColor;
          ctx.lineWidth = 2;
          ctx.fillRect(hp.x - 4, hp.y - 4, 8, 8);
          ctx.strokeRect(hp.x - 4, hp.y - 4, 8, 8);
        }
        ctx.restore();
      }
    }

    ctx.setLineDash([]);

    // Points.
    for (const p of this.points) {
      const s = to(p.x, p.y);
      const selected = this.selectedPoints.includes(p.id);
      const hovered = this.hoverEntity?.kind === 'point' && this.hoverEntity.id === p.id;
      const locked = this.isPointLocked(p.id) || (this.lastSolve && this.lastSolve.dof === 0);
      if (selected || hovered) {
        ctx.save();
        ctx.strokeStyle = selected ? selectColor : hoverColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.fillStyle = selected ? selectColor : hovered ? hoverColor : locked ? success : '#e03131';
      ctx.beginPath();
      ctx.arc(s.x, s.y, selected || hovered ? 5.5 : 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw FreeCAD Marquee Box Selection (Left-to-Right = Window Blue, Right-to-Left = Crossing Green)
    if (this.dragState?.kind === 'box' && this.lastMouse) {
      const x0 = this.dragState.x0;
      const y0 = this.dragState.y0;
      const x1 = this.lastMouse.x;
      const y1 = this.lastMouse.y;
      const crossing = x1 < x0;
      const rx = Math.min(x0, x1);
      const ry = Math.min(y0, y1);
      const rw = Math.abs(x1 - x0);
      const rh = Math.abs(y1 - y0);
      ctx.save();
      ctx.fillStyle = crossing ? 'rgba(34, 197, 94, 0.14)' : 'rgba(14, 165, 233, 0.14)';
      ctx.strokeStyle = crossing ? '#22c55e' : '#0ea5e9';
      ctx.lineWidth = 1.75;
      ctx.setLineDash(crossing ? [6, 4] : []);
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
      ctx.fillStyle = crossing ? '#15803d' : '#0369a1';
      ctx.font = 'bold 11px Arial, sans-serif';
      ctx.fillText(crossing ? 'Crossing Select' : 'Window Select', rx + 6, Math.max(14, ry - 5));
      ctx.restore();
    }

    // Highlight (0,0) Origin bullseye when hovered or in 'origin' tool
    if (this.tool === 'origin' || this.hoverEntity?.kind === 'origin') {
      const orig = this.viewer.getOrigin();
      const os = to(orig.x, orig.y);
      ctx.save();
      ctx.strokeStyle = hoverColor;
      ctx.lineWidth = 2.25;
      ctx.beginPath();
      ctx.arc(os.x, os.y, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // On-Canvas FreeCAD Constraint Glyphs & Dimension Leaders
    this.drawConstraintsOverlay(ctx, to, danger, constructionColor);

    // Live cursor snap highlight + rubber-band preview when active.
    if (this.active && this.lastMouse) {
      if (this.activeConstraintTool) {
        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
        const badgeText = `Constraint: ${this.activeConstraintTool} (click entities · Esc to exit)`;
        const bw = ctx.measureText(badgeText).width + 14;
        ctx.fillRect(this.lastMouse.x + 14, this.lastMouse.y + 14, bw, 22);
        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 11px Arial, sans-serif';
        ctx.fillText(badgeText, this.lastMouse.x + 21, this.lastMouse.y + 29);
        ctx.restore();
      }
      if (this.tool !== 'select') {
        const toolText = this.toolLabel();
        ctx.save();
        ctx.font = 'bold 11px Arial, sans-serif';
        const bw = ctx.measureText(toolText).width + 14;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.fillRect(this.lastMouse.x + 14, this.lastMouse.y - 32, bw, 20);
        ctx.fillStyle = '#7dd3fc';
        ctx.fillText(toolText, this.lastMouse.x + 21, this.lastMouse.y - 18);
        ctx.restore();
      }
      const rect = ctx.canvas.getBoundingClientRect();
      const curRaster = this.viewer.clientToRaster(
        rect.left + this.lastMouse.x,
        rect.top + this.lastMouse.y,
      );
      if (curRaster) {
        const snapPt = !this.lastMouse.altKey
          ? this.findNearPoint(curRaster.x, curRaster.y, 16)
          : null;
        if (snapPt) {
          const sp = to(snapPt.x, snapPt.y);
          ctx.save();
          ctx.strokeStyle = success;
          ctx.lineWidth = 2.25;
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, 9, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = success;
          ctx.font = 'bold 11px Arial, sans-serif';
          ctx.fillText('● Coinc', sp.x + 11, sp.y - 8);
          ctx.restore();
        }

        const rSnap =
          !snapPt && this.rasterSnapEnabled && this.grayCache
            ? this.snapRasterPoint(curRaster, this.lastMouse.altKey)
            : { x: curRaster.x, y: curRaster.y, snapped: false };
        if (rSnap.snapped) {
          const rsp = to(rSnap.x, rSnap.y);
          ctx.save();
          ctx.strokeStyle = '#d9480f';
          ctx.lineWidth = 1.75;
          ctx.beginPath();
          ctx.arc(rsp.x, rsp.y, 6, 0, Math.PI * 2);
          ctx.moveTo(rsp.x - 9, rsp.y);
          ctx.lineTo(rsp.x + 9, rsp.y);
          ctx.moveTo(rsp.x, rsp.y - 9);
          ctx.lineTo(rsp.x, rsp.y + 9);
          ctx.stroke();
          ctx.restore();
        }

        const snappedCoord = snapPt
          ? { x: snapPt.x, y: snapPt.y }
          : rSnap.snapped
            ? { x: rSnap.x, y: rSnap.y }
            : this.snapInputCoord(curRaster.x, curRaster.y, this.lastMouse.altKey);
        const targetX = snappedCoord.x;
        const targetY = snappedCoord.y;
        const targetScreen = to(targetX, targetY);
        const scaleMm = this.getScaleMm();
        const unitLabel = 'mm';

        if (this.pending) {
          const pendPt =
            this.pending.pointId !== undefined
              ? this.points.find((p) => p.id === this.pending!.pointId)
              : null;
          const pendX = pendPt ? pendPt.x : this.pending.x;
          const pendY = pendPt ? pendPt.y : this.pending.y;
          const startScreen = to(pendX, pendY);
          ctx.save();
          ctx.strokeStyle = accent;
          ctx.fillStyle = accent;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.arc(startScreen.x, startScreen.y, 4.5, 0, Math.PI * 2);
          ctx.fill();

          if (this.tool === 'line' || this.tool === 'polyline') {
            const dx = targetX - pendX;
            const dy = targetY - pendY;
            const len = Math.hypot(dx, dy);
            const deg = (Math.atan2(-dy, dx) * 180) / Math.PI;
            let hvBadge = this.tool === 'polyline' && this.polyMode !== 'line' ? ` [${this.polyMode}]` : '';
            if (this.autoConstraints && !this.lastMouse.altKey && len > 2 && hvBadge === '') {
              if (Math.abs(dy) / len < Math.sin((5 * Math.PI) / 180)) hvBadge = ' [H]';
              else if (Math.abs(dx) / len < Math.sin((5 * Math.PI) / 180)) hvBadge = ' [V]';
            }
            ctx.beginPath();
            ctx.moveTo(startScreen.x, startScreen.y);
            ctx.lineTo(targetScreen.x, targetScreen.y);
            ctx.stroke();
            ctx.fillText(
              `${(len * scaleMm).toFixed(1)} ${unitLabel} · ${deg.toFixed(1)}°${hvBadge}`,
              targetScreen.x + 10,
              targetScreen.y - 10,
            );
          } else if (this.tool === 'rect') {
            const w = targetScreen.x - startScreen.x;
            const h = targetScreen.y - startScreen.y;
            ctx.strokeRect(startScreen.x, startScreen.y, w, h);
            const rw = Math.abs(targetX - pendX) * scaleMm;
            const rh = Math.abs(targetY - pendY) * scaleMm;
            ctx.fillText(
              `${rw.toFixed(1)} × ${rh.toFixed(1)} ${unitLabel}`,
              targetScreen.x + 10,
              targetScreen.y - 10,
            );
          } else if (this.tool === 'centerRect') {
            const hw = Math.abs(targetScreen.x - startScreen.x);
            const hh = Math.abs(targetScreen.y - startScreen.y);
            ctx.strokeRect(startScreen.x - hw, startScreen.y - hh, hw * 2, hh * 2);
          } else if (this.tool === 'circle' || this.tool === 'polygon' || this.tool === 'arc') {
            const rPx = Math.hypot(targetX - pendX, targetY - pendY);
            ctx.save();
            ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
            ctx.beginPath();
            ctx.arc(pendX, pendY, rPx, 0, Math.PI * 2);
            ctx.restore();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(startScreen.x, startScreen.y);
            ctx.lineTo(targetScreen.x, targetScreen.y);
            ctx.stroke();
            ctx.fillText(
              `R ${(rPx * scaleMm).toFixed(1)} ${unitLabel}`,
              targetScreen.x + 10,
              targetScreen.y - 10,
            );
          } else if (this.tool === 'slot') {
            ctx.beginPath();
            ctx.moveTo(startScreen.x, startScreen.y);
            ctx.lineTo(targetScreen.x, targetScreen.y);
            ctx.stroke();
          }
          ctx.restore();
        } else if (this.arcStartPending) {
          const center = this.points.find((p) => p.id === this.arcStartPending!.centerId);
          if (center) {
            const sc = to(center.x, center.y);
            const rawEnd = Math.atan2(targetY - center.y, targetX - center.x);
            let sweep =
              ((rawEnd - this.arcStartPending.startAngle) % (2 * Math.PI) + 2 * Math.PI) %
              (2 * Math.PI);
            if (sweep < 1e-3) sweep = Math.PI;
            const startAngle = this.lastMouse.altKey ? rawEnd : this.arcStartPending.startAngle;
            const endAngle = this.lastMouse.altKey
              ? rawEnd + (2 * Math.PI - sweep)
              : startAngle + sweep;
            const endRimScreen = to(
              center.x + this.arcStartPending.radius * Math.cos(rawEnd),
              center.y + this.arcStartPending.radius * Math.sin(rawEnd),
            );
            ctx.save();
            ctx.strokeStyle = accent;
            ctx.fillStyle = accent;
            ctx.setLineDash([5, 4]);
            ctx.save();
            ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
            ctx.beginPath();
            ctx.arc(center.x, center.y, this.arcStartPending.radius, startAngle, endAngle);
            ctx.restore();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(sc.x, sc.y);
            ctx.lineTo(endRimScreen.x, endRimScreen.y);
            ctx.stroke();
            const degSweep = (((endAngle - startAngle) * 180) / Math.PI).toFixed(1);
            ctx.fillText(
              `R ${(this.arcStartPending.radius * scaleMm).toFixed(1)} ${unitLabel} · Δ∠ ${degSweep}°`,
              endRimScreen.x + 10,
              endRimScreen.y - 10,
            );
            ctx.restore();
          }
        } else if (this.arc3PtPending) {
          const s1 = to(this.arc3PtPending.x1, this.arc3PtPending.y1);
          ctx.save();
          ctx.strokeStyle = accent;
          ctx.fillStyle = accent;
          ctx.setLineDash([5, 4]);
          if (this.arc3PtPending.p2Id === undefined) {
            ctx.beginPath();
            ctx.moveTo(s1.x, s1.y);
            ctx.lineTo(targetScreen.x, targetScreen.y);
            ctx.stroke();
            const chord = Math.hypot(targetX - this.arc3PtPending.x1, targetY - this.arc3PtPending.y1);
            ctx.fillText(
              `Chord ${(chord * scaleMm).toFixed(1)} ${unitLabel}`,
              targetScreen.x + 10,
              targetScreen.y - 10,
            );
          } else {
            const circ = circumcircleArc(
              this.arc3PtPending.x1,
              this.arc3PtPending.y1,
              this.arc3PtPending.x2!,
              this.arc3PtPending.y2!,
              targetX,
              targetY,
            );
            if (circ) {
              ctx.save();
              ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
              ctx.beginPath();
              ctx.arc(circ.cx, circ.cy, circ.radius, circ.startAngle, circ.endAngle);
              ctx.restore();
              ctx.stroke();
              ctx.fillText(
                `R ${(circ.radius * scaleMm).toFixed(1)} ${unitLabel}`,
                targetScreen.x + 10,
                targetScreen.y - 10,
              );
            }
          }
          ctx.restore();
        } else if (this.polyArcPending) {
          const pa = this.polyArcPending;
          const circ = circumcircleArc(pa.ax, pa.ay, pa.bx, pa.by, targetX, targetY);
          ctx.save();
          ctx.strokeStyle = accent;
          ctx.fillStyle = accent;
          ctx.setLineDash([5, 4]);
          if (circ) {
            ctx.save();
            ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
            ctx.beginPath();
            ctx.arc(circ.cx, circ.cy, circ.radius, circ.startAngle, circ.endAngle);
            ctx.restore();
            ctx.stroke();
            ctx.fillText(
              `R ${(circ.radius * scaleMm).toFixed(1)} ${unitLabel}`,
              targetScreen.x + 10,
              targetScreen.y - 10,
            );
          }
          ctx.restore();
        }
        if (this.loupeEnabled) {
          this.drawSketchLoupe(ctx, this.lastMouse.x, this.lastMouse.y, targetX, targetY, accent);
        }
      }
    } else if (this.pending) {
      const s = to(this.pending.x, this.pending.y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawSketchLoupe(
    ctx: CanvasRenderingContext2D,
    mouseX: number,
    mouseY: number,
    rasterX: number,
    rasterY: number,
    accent: string,
  ): void {
    const page = this.viewer.getPage();
    if (!page || page.levels.length === 0) return;
    const level0 = page.levels[0];
    const radius = 56;
    const mag = 8;
    const srcSpan = (radius * 2) / mag;
    const cx = mouseX > radius * 2 + 30 ? mouseX - radius - 22 : mouseX + radius + 22;
    const cy = mouseY > radius * 2 + 30 ? mouseY - radius - 22 : mouseY + radius + 22;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.imageSmoothingEnabled = false;

    const tileSize = 256;
    const u0 = rasterX - srcSpan / 2;
    const v0 = rasterY - srcSpan / 2;
    const col0 = Math.max(0, Math.floor(u0 / tileSize));
    const row0 = Math.max(0, Math.floor(v0 / tileSize));
    const col1 = Math.min(level0.tileCols - 1, Math.floor((u0 + srcSpan) / tileSize));
    const row1 = Math.min(level0.tileRows - 1, Math.floor((v0 + srcSpan) / tileSize));
    for (let r = row0; r <= row1; r += 1) {
      for (let c = col0; c <= col1; c += 1) {
        const tile = level0.tiles[r * level0.tileCols + c];
        if (!tile) continue;
        const dx = cx - radius + (c * tileSize - u0) * mag;
        const dy = cy - radius + (r * tileSize - v0) * mag;
        ctx.drawImage(tile, dx, dy, tile.width * mag, tile.height * mag);
      }
    }
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#d9480f';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy);
    ctx.lineTo(cx + 10, cy);
    ctx.moveTo(cx, cy - 10);
    ctx.lineTo(cx, cy + 10);
    ctx.stroke();
    ctx.restore();
  }

  private drawConstraintsOverlay(
    ctx: CanvasRenderingContext2D,
    to: (rx: number, ry: number) => { x: number; y: number },
    drivingColor: string,
    refColor: string,
  ): void {
    const scaleMm = this.getScaleMm();
    this.dimBadgeRects = [];
    ctx.save();
    ctx.font = 'bold 11px Arial, sans-serif';

    this.constraints.forEach((c, idx) => {
      const key = Object.keys(c)[0];
      const val = (c as Record<string, unknown>)[key];
      const isRef = this.referenceConstraints.includes(idx);
      const dimColor = isRef ? refColor : drivingColor;

      const drawBadge = (
        sx: number,
        sy: number,
        text: string,
        color = '#d9480f',
        clickableIdx?: number,
      ): void => {
        const w = ctx.measureText(text).width + 8;
        ctx.fillStyle =
          clickableIdx !== undefined && this.editingConstraintIdx === clickableIdx
            ? '#fef08a'
            : 'rgba(255, 255, 255, 0.92)';
        ctx.fillRect(sx - w / 2, sy - 9, w, 16);
        ctx.strokeStyle = color;
        ctx.lineWidth =
          clickableIdx !== undefined && this.editingConstraintIdx === clickableIdx ? 2 : 1;
        ctx.strokeRect(sx - w / 2, sy - 9, w, 16);
        ctx.fillStyle = color;
        ctx.fillText(text, sx - w / 2 + 4, sy + 3);
        if (clickableIdx !== undefined) {
          this.dimBadgeRects.push({
            cIdx: clickableIdx,
            x: sx - w / 2 - 4,
            y: sy - 11,
            w: w + 8,
            h: 20,
          });
        }
      };

      if (key === 'Horizontal' || key === 'Vertical') {
        const l = this.lines.find((x) => x.id === (val as number));
        if (!l) return;
        const pa = this.points.find((p) => p.id === l.a);
        const pb = this.points.find((p) => p.id === l.b);
        if (!pa || !pb) return;
        const a = to(pa.x, pa.y);
        const b = to(pb.x, pb.y);
        drawBadge((a.x + b.x) / 2, (a.y + b.y) / 2 - 12, key === 'Horizontal' ? 'H' : 'V');
      } else if (key === 'Parallel' || key === 'Perpendicular' || key === 'EqualLength') {
        const arr = val as number[];
        const l = this.lines.find((x) => x.id === arr[0]);
        if (!l) return;
        const pa = this.points.find((p) => p.id === l.a);
        const pb = this.points.find((p) => p.id === l.b);
        if (!pa || !pb) return;
        const a = to(pa.x, pa.y);
        const b = to(pb.x, pb.y);
        const sym = key === 'Parallel' ? '∥' : key === 'Perpendicular' ? '⊥' : '=';
        drawBadge((a.x + b.x) / 2 + 12, (a.y + b.y) / 2 + 12, sym);
      } else if (key === 'Coincident') {
        const arr = val as number[];
        const pt = this.points.find((p) => p.id === arr[0]);
        if (!pt) return;
        const s = to(pt.x, pt.y);
        ctx.save();
        ctx.strokeStyle = '#d9480f';
        ctx.lineWidth = 1.75;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 7.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      } else if (key === 'FixedPoint') {
        const arr = val as number[];
        const pt = this.points.find((p) => p.id === arr[0]);
        if (!pt) return;
        const s = to(pt.x, pt.y);
        drawBadge(s.x + 12, s.y - 10, '🔒');
      } else if (key === 'Distance' || key === 'HorizontalDistance' || key === 'VerticalDistance') {
        const arr = val as number[];
        const p1 = this.points.find((p) => p.id === arr[0]);
        const p2 = this.points.find((p) => p.id === arr[1]);
        if (!p1 || !p2) return;
        const a = to(p1.x, p1.y);
        const b = to(p2.x, p2.y);
        const mmVal = (arr[2] * scaleMm).toFixed(1);
        const prefix = key === 'HorizontalDistance' ? 'ΔX ' : key === 'VerticalDistance' ? 'ΔY ' : '';
        ctx.strokeStyle = dimColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y - 18);
        ctx.lineTo(b.x, b.y - 18);
        ctx.stroke();
        ctx.setLineDash([]);
        drawBadge((a.x + b.x) / 2, (a.y + b.y) / 2 - 22, `${prefix}${mmVal} mm`, dimColor, idx);
      } else if (key === 'DistancePointLine') {
        const arr = val as number[];
        const pt = this.points.find((p) => p.id === arr[0]);
        if (!pt) return;
        const s = to(pt.x, pt.y);
        const mmVal = (arr[2] * scaleMm).toFixed(1);
        drawBadge(s.x + 18, s.y - 18, `${mmVal} mm`, dimColor, idx);
      } else if (key === 'LineLength') {
        const arr = val as number[];
        const l = this.lines.find((x) => x.id === arr[0]);
        if (!l) return;
        const pa = this.points.find((p) => p.id === l.a);
        const pb = this.points.find((p) => p.id === l.b);
        if (!pa || !pb) return;
        const a = to(pa.x, pa.y);
        const b = to(pb.x, pb.y);
        const mmVal = (arr[1] * scaleMm).toFixed(1);
        drawBadge((a.x + b.x) / 2, (a.y + b.y) / 2 - 22, `${mmVal} mm`, dimColor, idx);
      } else if (key === 'Radius' || key === 'Diameter' || key === 'ArcRadius') {
        const arr = val as number[];
        const c =
          key === 'ArcRadius'
            ? this.arcs.find((x) => x.id === arr[0])
            : this.circles.find((x) => x.id === arr[0]);
        if (!c) return;
        const center = this.points.find((p) => p.id === c.center);
        if (!center) return;
        const sc = to(center.x, center.y);
        const mmVal = (arr[1] * scaleMm).toFixed(1);
        const prefix = key === 'Diameter' ? '⌀ ' : 'R ';
        drawBadge(sc.x + 24, sc.y - 18, `${prefix}${mmVal} mm`, dimColor, idx);
      } else if (key === 'Angle' || key === 'AngleLine') {
        const arr = val as number[];
        const rad = key === 'Angle' ? arr[2] : arr[1];
        const l = this.lines.find((x) => x.id === arr[0]);
        if (!l) return;
        const pa = this.points.find((p) => p.id === l.a);
        if (!pa) return;
        const sa = to(pa.x, pa.y);
        drawBadge(sa.x + 22, sa.y - 16, `∠ ${((rad * 180) / Math.PI).toFixed(1)}°`, dimColor, idx);
      }
    });

    ctx.restore();
  }

  private applyParams(params: number[]): void {
    for (let i = 0; i < this.points.length; i += 1) {
      this.points[i].x = params[2 * i];
      this.points[i].y = params[2 * i + 1];
    }
    const cBase = 2 * this.points.length;
    for (let j = 0; j < this.circles.length; j += 1) {
      this.circles[j].radius = Math.abs(params[cBase + j]);
    }
    const aBase = cBase + this.circles.length;
    for (let k = 0; k < this.arcs.length; k += 1) {
      this.arcs[k].radius = Math.abs(params[aBase + 3 * k]);
      this.arcs[k].start = params[aBase + 3 * k + 1];
      this.arcs[k].end = params[aBase + 3 * k + 2];
    }
    this.syncArcsWithEndpoints();
    if (this.pending?.pointId !== undefined) {
      const pendPt = this.points.find((p) => p.id === this.pending!.pointId);
      if (pendPt) {
        this.pending.x = pendPt.x;
        this.pending.y = pendPt.y;
      }
    }
  }

  private async solveSilent(): Promise<void> {
    if (this.points.length === 0) return;
    if (this.constraints.length === 0) {
      this.syncArcsWithEndpoints();
      this.lastSolve = null;
      this.notifyDof();
      return;
    }
    try {
      const sketch = this.buildSolveSketch();
      const result = await solveSketch(sketch, true);
      this.applyParams(result.params);
      this.lastSolve = result;
      this.notifyDof();
    } catch {
      // Ignore transient drag solve errors.
    }
  }

  async solve(): Promise<void> {
    this.pending = null;
    this.arcStartPending = null;
    if (this.points.length < 2 && this.circles.length === 0 && this.arcs.length === 0) {
      this.onStatus(t(this.locale, 'sketch.none'), true);
      return;
    }
    try {
      const sketch = this.buildSolveSketch();
      const result = await solveSketch(sketch, false);
      this.applyParams(result.params);
      this.lastSolve = result;
      this.resultText = result.converged
        ? tf(this.locale, 'sketch.result', { r: result.max_residual.toExponential(2) })
        : t(this.locale, 'error.failed');
      this.onStatus(this.resultText, !result.converged);
      this.render();
      this.viewer.requestRender();
      this.notifyDof();
      this.onChange?.();
    } catch (err) {
      this.onStatus(t(this.locale, 'error.failed'), true);
      console.error('sketch solve failed', err);
    }
  }

  async fit(previewOnly = false): Promise<void> {
    this.pending = null;
    this.arcStartPending = null;
    if (this.points.length < 2 && this.circles.length === 0 && this.arcs.length === 0) {
      this.onStatus(t(this.locale, 'sketch.none'), true);
      return;
    }
    try {
      const session = getActiveRasterSession();
      if (!session || session.ridges.length === 0) {
        this.onStatus(t(this.locale, 'sketch.none'), true);
        return;
      }
      if (previewOnly && !this.preFitSnapshot) {
        this.preFitSnapshot = {
          sketch: this.captureSnapshot(),
          rasterTransform: this.viewer.getRasterTransform(),
        };
      } else if (!previewOnly) {
        this.preFitSnapshot = null;
        this.pushUndo();
      }

      const fitterParams = {
        max_iterations: 40,
        capture_radius: this.fitOpts.captureRadius,
        sample_step: 2.0,
        tikhonov: 1e-6,
        constraint_penalty: 1e-3,
        fit_geometry: this.fitOpts.fitGeometry,
        fit_rotation: this.fitOpts.fitRotation,
        fit_translation: this.fitOpts.fitTranslation,
        fit_scale: this.fitOpts.fitScale,
        include_construction: this.fitOpts.includeConstruction,
        robust_scale: this.fitOpts.robustScale,
        tangent_weight: 0.1,
      };

      const maskStrokes = this.getMaskStrokes();
      const payload: Record<string, unknown> = {
        sketch: this.buildSketch(),
        // Server-side ridges are in the same pixel frame as the displayed
        // raster (the server is the single source of truth), so they match
        // the sketch coordinates directly.
        centerlines: session.ridges,
        initial: [0, 0, 0],
        params: fitterParams,
      };
      if (maskStrokes.length > 0) {
        payload.mask_strokes = maskStrokes.map((s) => ({
          mode: s.mode === 'include' ? 'Include' : 'Exclude',
          kind: s.kind === 'rect' ? 'Rect' : s.kind === 'polygon' ? 'Polygon' : 'Brush',
          radius: s.radius ?? 6.0,
          points: s.points,
        }));
        payload.mask_params = {
          enabled: true,
          base_all: !maskStrokes.some((s) => s.mode === 'include'),
          feather: 3.0,
        };
      }

      const resultJson = await fitSketch(payload);
      const result = JSON.parse(resultJson) as FitResponse;
      this.lastFitJson = resultJson;
      this.lastFit = result;

      const [theta, tx, ty] = result.transform;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const mappedParams = [...result.params];
      for (let i = 0; i < this.points.length; i += 1) {
        const ptId = this.points[i].id;
        const fixedC = this.constraints.find(
          (c) => 'FixedPoint' in c && (c as { FixedPoint: number[] }).FixedPoint[0] === ptId,
        ) as { FixedPoint: number[] } | undefined;
        if (fixedC) {
          mappedParams[2 * i] = fixedC.FixedPoint[1];
          mappedParams[2 * i + 1] = fixedC.FixedPoint[2];
        } else {
          const x = result.params[2 * i];
          const y = result.params[2 * i + 1];
          mappedParams[2 * i] = cosT * x - sinT * y + tx;
          mappedParams[2 * i + 1] = sinT * x + cosT * y + ty;
        }
      }
      const aBase = 2 * this.points.length + this.circles.length;
      for (let k = 0; k < this.arcs.length; k += 1) {
        mappedParams[aBase + 3 * k + 1] += theta;
        mappedParams[aBase + 3 * k + 2] += theta;
      }
      this.applyParams(mappedParams);

      this.resultText = tf(this.locale, 'sketch.fitResult', {
        r: result.rms_px.toFixed(3),
        t: ((theta * 180) / Math.PI).toFixed(3),
      });
      this.onStatus(this.resultText);
      this.render();
      this.viewer.requestRender();
      this.onChange?.();
    } catch (err) {
      this.onStatus(t(this.locale, 'error.failed'), true);
      console.error('fit failed', err);
    }
  }

  cancelFitPreview(): void {
    if (!this.preFitSnapshot) return;
    this.viewer.setRasterTransform(this.preFitSnapshot.rasterTransform);
    this.restoreSnapshot(this.preFitSnapshot.sketch);
    this.preFitSnapshot = null;
    this.lastFit = null;
    this.resultText = '';
    this.render();
    this.viewer.requestRender();
  }

  async exportDxf(): Promise<void> {
    const dxf = await exportSketchDxf(this.buildWorldSketch());
    this.downloadText(dxf, 'sketch.dxf', 'application/dxf');
    document.documentElement.dataset.exported = 'dxf';
  }

  async exportSvg(): Promise<void> {
    const svg = await exportSketchSvg(this.buildWorldSketch());
    this.downloadText(svg, 'sketch.svg', 'image/svg+xml');
    document.documentElement.dataset.exported = 'svg';
  }

  /**
   * Build the sketch in CAD world coordinates (mm, y-up) for export. The editor
   * stores geometry in raster pixels (y-down); the DXF/SVG exporters assume mm
   * y-up, so this applies the calibration scale/flip/origin and arc mirroring.
   */
  private buildWorldSketch(): SavedSketchData {
    return sketchToWorld(
      this.buildSketch(),
      this.viewer.getWorldScale(),
      this.viewer.getOrigin(),
    );
  }

  async exportReportJson(): Promise<void> {
    if (!this.lastFitJson) return;
    const json = await reportJson(JSON.parse(this.lastFitJson) as Record<string, unknown>);
    this.downloadText(json, 'fit-report.json', 'application/json');
    document.documentElement.dataset.exported = 'json';
  }

  async exportReportCsv(): Promise<void> {
    if (!this.lastFitJson) return;
    const csv = await reportCsv(JSON.parse(this.lastFitJson) as Record<string, unknown>);
    this.downloadText(csv, 'fit-report.csv', 'text/csv');
    document.documentElement.dataset.exported = 'csv';
  }

  private downloadText(content: string, filename: string, mime: string): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  clear(): void {
    this.pushUndo();
    this.points = [];
    this.lines = [];
    this.circles = [];
    this.arcs = [];
    this.constraints = [];
    this.referenceConstraints = [];
    this.pending = null;
    this.arcStartPending = null;
    this.clearSelection();
    this.lastSolve = null;
    this.lastFit = null;
    this.lastFitJson = null;
    this.resultText = '';
    this.render();
    this.viewer.requestRender();
    this.onStatus(t(this.locale, 'status.ready'));
    this.notifyDof();
    this.onChange?.();
  }

  private notifyDof(): void {
    const dof = this.getDof();
    const status =
      this.lastSolve && this.lastSolve.conflicting.length > 0
        ? 'conflict'
        : dof === 0 && this.points.length > 0
          ? 'ok'
          : 'under';
    this.onDofChange?.(dof, status);
  }

  buildSketch(): SavedSketchData {
    const lines: SavedSketchLine[] =
      this.lines.length > 0
        ? this.lines.map((l) => ({ ...l, construction: Boolean(l.construction) }))
        : [];
    if (lines.length === 0 && this.points.length >= 2) {
      for (let i = 0; i + 1 < this.points.length; i += 2) {
        lines.push({
          id: i / 2 + 1,
          a: this.points[i].id,
          b: this.points[i + 1].id,
          construction: false,
        });
      }
    }
    const constraints = [...this.constraints];
    return {
      points: this.points.map((p) => ({ id: p.id, x: p.x, y: p.y })),
      lines,
      circles: this.circles.map((c) => ({ ...c, construction: Boolean(c.construction) })),
      arcs: this.arcs.map((a) => ({ ...a, construction: Boolean(a.construction) })),
      constraints,
      reference_constraints: [...this.referenceConstraints],
    };
  }

  /**
   * Build the sketch for constraint solving, tagging the coordinate-system frame
   * so Horizontal/Vertical constraints reference the fixed axes instead of the
   * (possibly levelled) raster pixel axes.
   */
  private buildSolveSketch(): SavedSketchData {
    const sketch = this.buildSketch();
    const t = this.viewer.getRasterTransform();
    sketch.frame = [t[0], t[1], t[2], t[3]];
    return sketch;
  }

  /** Apply a FreeCAD Sketcher constraint to the currently selected canvas entities! */
  /** True when the current selection satisfies the minimum requirements for `action`. */
  private canApplyConstraintNow(action: string): boolean {
    const p = this.selectedPoints.length;
    const l = this.selectedLines.length;
    const c = this.selectedCircles.length;
    const a = this.selectedArcs.length;
    switch (action) {
      case 'Horizontal':
      case 'Vertical':
        return l > 0 || p >= 2;
      case 'Coincident':
        return p >= 2;
      case 'PointOnObject':
        return (p >= 1 && l >= 1) || (p >= 1 && c >= 1) || (p >= 1 && a >= 1);
      case 'Parallel':
      case 'Collinear':
        return l >= 2;
      case 'Perpendicular':
        return l >= 2 || (l >= 1 && c >= 1) || (l >= 1 && a >= 1);
      case 'Tangent':
        return (l >= 1 && c >= 1) || (l >= 1 && a >= 1) || c >= 2 || a >= 2;
      case 'Equal':
        return l >= 2 || c >= 2 || a >= 2 || (c >= 1 && a >= 1);
      case 'Symmetric':
        return (p >= 2 && l >= 1) || p >= 3 || (p === 1 && l === 1);
      case 'Midpoint':
        return p >= 1 && l >= 1;
      case 'Block':
        return p > 0 || l > 0;
      case 'Distance':
        return p >= 2 || l >= 1;
      case 'HorizontalDistance':
      case 'VerticalDistance':
        return p >= 2 || l >= 1;
      case 'Radius':
        return c >= 1 || a >= 1;
      case 'Diameter':
        return c >= 1;
      case 'Angle':
        return l >= 1;
      default:
        return false;
    }
  }

  applyConstraintAction(action: string, customValueMmOrDeg?: number): void {
    const scaleMm = this.getScaleMm();
    const valInput = this.panel.querySelector<HTMLInputElement>('#sketch-c-val');
    const rawVal =
      customValueMmOrDeg !== undefined
        ? customValueMmOrDeg
        : valInput
          ? Number(valInput.value)
          : 50;

    this.pushUndo();
    let added = false;

    if (action === 'Horizontal') {
      if (this.selectedLines.length > 0) {
        for (const lid of this.selectedLines) {
          this.constraints.push({ Horizontal: lid });
          added = true;
        }
      } else if (this.selectedPoints.length >= 2) {
        this.constraints.push({
          HorizontalPoints: [this.selectedPoints[0], this.selectedPoints[1]],
        });
        added = true;
      }
    } else if (action === 'Vertical') {
      if (this.selectedLines.length > 0) {
        for (const lid of this.selectedLines) {
          this.constraints.push({ Vertical: lid });
          added = true;
        }
      } else if (this.selectedPoints.length >= 2) {
        this.constraints.push({
          VerticalPoints: [this.selectedPoints[0], this.selectedPoints[1]],
        });
        added = true;
      }
    } else if (action === 'Coincident') {
      if (this.selectedPoints.length >= 2) {
        this.constraints.push({ Coincident: [this.selectedPoints[0], this.selectedPoints[1]] });
        added = true;
      }
    } else if (action === 'PointOnObject') {
      if (this.selectedPoints.length >= 1 && this.selectedLines.length >= 1) {
        this.constraints.push({ PointOnLine: [this.selectedPoints[0], this.selectedLines[0]] });
        added = true;
      } else if (this.selectedPoints.length >= 1 && this.selectedCircles.length >= 1) {
        this.constraints.push({
          PointOnCircle: [this.selectedPoints[0], this.selectedCircles[0]],
        });
        added = true;
      } else if (this.selectedPoints.length >= 1 && this.selectedArcs.length >= 1) {
        this.constraints.push({ PointOnArc: [this.selectedPoints[0], this.selectedArcs[0]] });
        added = true;
      }
    } else if (action === 'Parallel') {
      if (this.selectedLines.length >= 2) {
        this.constraints.push({ Parallel: [this.selectedLines[0], this.selectedLines[1]] });
        added = true;
      }
    } else if (action === 'Perpendicular') {
      if (this.selectedLines.length >= 2) {
        this.constraints.push({ Perpendicular: [this.selectedLines[0], this.selectedLines[1]] });
        added = true;
      } else if (this.selectedLines.length >= 1 && this.selectedCircles.length >= 1) {
        this.constraints.push({
          PerpendicularLineCircle: [this.selectedLines[0], this.selectedCircles[0]],
        });
        added = true;
      } else if (this.selectedLines.length >= 1 && this.selectedArcs.length >= 1) {
        this.constraints.push({
          PerpendicularLineArc: [this.selectedLines[0], this.selectedArcs[0]],
        });
        added = true;
      }
    } else if (action === 'Tangent') {
      if (this.selectedLines.length >= 1 && this.selectedCircles.length >= 1) {
        this.constraints.push({
          TangentLineCircle: [this.selectedLines[0], this.selectedCircles[0]],
        });
        added = true;
      } else if (this.selectedLines.length >= 1 && this.selectedArcs.length >= 1) {
        this.constraints.push({ TangentLineArc: [this.selectedLines[0], this.selectedArcs[0]] });
        added = true;
      } else if (this.selectedCircles.length >= 2) {
        this.constraints.push({
          TangentCircleCircle: [this.selectedCircles[0], this.selectedCircles[1]],
        });
        added = true;
      } else if (this.selectedArcs.length >= 2) {
        this.constraints.push({ TangentArcArc: [this.selectedArcs[0], this.selectedArcs[1]] });
        added = true;
      }
    } else if (action === 'Equal') {
      if (this.selectedLines.length >= 2) {
        this.constraints.push({ EqualLength: [this.selectedLines[0], this.selectedLines[1]] });
        added = true;
      } else if (this.selectedCircles.length >= 2) {
        this.constraints.push({ EqualRadius: [this.selectedCircles[0], this.selectedCircles[1]] });
        added = true;
      } else if (this.selectedArcs.length >= 2) {
        this.constraints.push({ EqualRadiusArc: [this.selectedArcs[0], this.selectedArcs[1]] });
        added = true;
      } else if (this.selectedCircles.length >= 1 && this.selectedArcs.length >= 1) {
        this.constraints.push({
          EqualRadiusCircleArc: [this.selectedCircles[0], this.selectedArcs[0]],
        });
        added = true;
      }
    } else if (action === 'Symmetric') {
      if (this.selectedPoints.length >= 2 && this.selectedLines.length >= 1) {
        this.constraints.push({
          Symmetric: [this.selectedPoints[0], this.selectedPoints[1], this.selectedLines[0]],
        });
        added = true;
      } else if (this.selectedPoints.length >= 3) {
        this.constraints.push({
          SymmetricPoints: [
            this.selectedPoints[0],
            this.selectedPoints[1],
            this.selectedPoints[2],
          ],
        });
        added = true;
      } else if (this.selectedPoints.length === 1 && this.selectedLines.length === 1) {
        this.constraints.push({ Midpoint: [this.selectedPoints[0], this.selectedLines[0]] });
        added = true;
      }
    } else if (action === 'Midpoint') {
      if (this.selectedPoints.length >= 1 && this.selectedLines.length >= 1) {
        this.constraints.push({ Midpoint: [this.selectedPoints[0], this.selectedLines[0]] });
        added = true;
      }
    } else if (action === 'Collinear') {
      if (this.selectedLines.length >= 2) {
        this.constraints.push({ Collinear: [this.selectedLines[0], this.selectedLines[1]] });
        added = true;
      }
    } else if (action === 'Block') {
      if (this.selectedPoints.length > 0) {
        for (const pid of this.selectedPoints) {
          const pt = this.points.find((p) => p.id === pid);
          if (pt) {
            if (this.rasterSnapEnabled && this.grayCache) {
              const rSnap = this.snapRasterPoint({ x: pt.x, y: pt.y }, false);
              if (rSnap.snapped) {
                pt.x = rSnap.x;
                pt.y = rSnap.y;
              }
            }
            this.setPointFixedToRaster(pt.id, pt.x, pt.y);
            added = true;
          }
        }
      } else if (this.selectedLines.length > 0) {
        for (const lid of this.selectedLines) {
          const l = this.lines.find((x) => x.id === lid);
          if (l) {
            const pa = this.points.find((p) => p.id === l.a);
            const pb = this.points.find((p) => p.id === l.b);
            if (pa && pb) {
              this.setPointFixedToRaster(pa.id, pa.x, pa.y);
              this.setPointFixedToRaster(pb.id, pb.x, pb.y);
              added = true;
            }
          }
        }
      }
    } else if (action === 'Distance') {
      const dInternal = rawVal / scaleMm;
      if (this.selectedPoints.length >= 2) {
        this.constraints.push({
          Distance: [this.selectedPoints[0], this.selectedPoints[1], dInternal],
        });
        added = true;
      } else if (this.selectedPoints.length === 1 && this.selectedLines.length === 1) {
        this.constraints.push({
          DistancePointLine: [this.selectedPoints[0], this.selectedLines[0], dInternal],
        });
        added = true;
      } else if (this.selectedLines.length >= 1) {
        this.constraints.push({ LineLength: [this.selectedLines[0], dInternal] });
        added = true;
      }
    } else if (action === 'HorizontalDistance' || action === 'VerticalDistance') {
      const dInternal = rawVal / scaleMm;
      let p1: number | undefined;
      let p2: number | undefined;
      if (this.selectedPoints.length >= 2) {
        [p1, p2] = this.selectedPoints;
      } else if (this.selectedLines.length >= 1) {
        const l = this.lines.find((x) => x.id === this.selectedLines[0]);
        if (l) {
          p1 = l.a;
          p2 = l.b;
        }
      }
      if (p1 !== undefined && p2 !== undefined) {
        this.constraints.push(
          action === 'HorizontalDistance'
            ? { HorizontalDistance: [p1, p2, dInternal] }
            : { VerticalDistance: [p1, p2, dInternal] },
        );
        added = true;
      }
    } else if (action === 'Radius') {
      const rInternal = rawVal / scaleMm;
      if (this.selectedCircles.length >= 1) {
        this.constraints.push({ Radius: [this.selectedCircles[0], rInternal] });
        added = true;
      } else if (this.selectedArcs.length >= 1) {
        this.constraints.push({ ArcRadius: [this.selectedArcs[0], rInternal] });
        added = true;
      }
    } else if (action === 'Diameter') {
      const dInternal = rawVal / scaleMm;
      if (this.selectedCircles.length >= 1) {
        this.constraints.push({ Diameter: [this.selectedCircles[0], dInternal] });
        added = true;
      }
    } else if (action === 'Angle') {
      const rad = (rawVal * Math.PI) / 180;
      if (this.selectedLines.length >= 2) {
        this.constraints.push({ Angle: [this.selectedLines[0], this.selectedLines[1], rad] });
        added = true;
      } else if (this.selectedLines.length === 1) {
        this.constraints.push({ AngleLine: [this.selectedLines[0], rad] });
        added = true;
      }
    }

    if (!added) {
      this.undoStack.pop();
      this.onStatus(t(this.locale, 'sketch.selectForConstraint'), true);
      return;
    }

    void this.solve();
  }

  private addConstraintFromUi(type: string, e1: number, e2: number, val: number): void {
    const scaleMm = this.getScaleMm();
    this.pushUndo();
    switch (type) {
      case 'Horizontal':
        this.constraints.push({ Horizontal: e1 });
        break;
      case 'Vertical':
        this.constraints.push({ Vertical: e1 });
        break;
      case 'HorizontalPoints':
        this.constraints.push({ HorizontalPoints: [e1, e2] });
        break;
      case 'VerticalPoints':
        this.constraints.push({ VerticalPoints: [e1, e2] });
        break;
      case 'Coincident':
        this.constraints.push({ Coincident: [e1, e2] });
        break;
      case 'PointOnLine':
        this.constraints.push({ PointOnLine: [e1, e2] });
        break;
      case 'PointOnCircle':
        this.constraints.push({ PointOnCircle: [e1, e2] });
        break;
      case 'Parallel':
        this.constraints.push({ Parallel: [e1, e2] });
        break;
      case 'Perpendicular':
        this.constraints.push({ Perpendicular: [e1, e2] });
        break;
      case 'TangentLineCircle':
        this.constraints.push({ TangentLineCircle: [e1, e2] });
        break;
      case 'EqualLength':
        this.constraints.push({ EqualLength: [e1, e2] });
        break;
      case 'EqualRadius':
        this.constraints.push({ EqualRadius: [e1, e2] });
        break;
      case 'LineLength':
        this.constraints.push({ LineLength: [e1, val / scaleMm] });
        break;
      case 'Distance':
        this.constraints.push({ Distance: [e1, e2, val / scaleMm] });
        break;
      case 'DistancePointLine':
        this.constraints.push({ DistancePointLine: [e1, e2, val / scaleMm] });
        break;
      case 'HorizontalDistance':
        this.constraints.push({ HorizontalDistance: [e1, e2, val / scaleMm] });
        break;
      case 'VerticalDistance':
        this.constraints.push({ VerticalDistance: [e1, e2, val / scaleMm] });
        break;
      case 'Radius':
        this.constraints.push({ Radius: [e1, val / scaleMm] });
        break;
      case 'Diameter':
        this.constraints.push({ Diameter: [e1, val / scaleMm] });
        break;
      case 'Angle':
        this.constraints.push({ Angle: [e1, e2, (val * Math.PI) / 180] });
        break;
      case 'AngleLine':
        this.constraints.push({ AngleLine: [e1, (val * Math.PI) / 180] });
        break;
      case 'Midpoint':
        this.constraints.push({ Midpoint: [e1, e2] });
        break;
      case 'Collinear':
        this.constraints.push({ Collinear: [e1, e2] });
        break;
      case 'FixedPoint': {
        const pt = this.points.find((p) => p.id === e1);
        this.constraints.push({ FixedPoint: [e1, pt ? pt.x : 0, pt ? pt.y : 0] });
        break;
      }
    }
    void this.solve();
  }

  private render(): void {
    const locale = this.locale;
    const dof = this.getDof();
    const redundant = this.lastSolve?.redundant ?? [];
    const conflicting = this.lastSolve?.conflicting ?? [];

    const solverBannerHtml =
      conflicting.length > 0
        ? `<button id="sketch-remove-conflict" class="btn sketch-banner sketch-banner-conflict" type="button">⚠ ${tf(locale, 'sketch.conflictWarn', { list: conflicting.map((i) => `#${i + 1}`).join(', ') })}</button>`
        : redundant.length > 0
          ? `<button id="sketch-remove-redundant" class="btn sketch-banner sketch-banner-redundant" type="button">⚠ ${tf(locale, 'sketch.redundantWarn', { list: redundant.map((i) => `#${i + 1}`).join(', ') })}</button>`
          : dof === 0 && this.points.length > 0
            ? `<div class="sketch-status sketch-status-ok">✓ ${t(locale, 'sketch.fullyConstrained')}</div>`
            : `<div class="sketch-status sketch-status-hint">${tf(locale, 'sketch.underConstrained', { dof })}</div>`;

    const selectionSummary = [
      ...this.selectedPoints.map((id) => `Pt#${id}`),
      ...this.selectedLines.map((id) => `Ln#${id}`),
      ...this.selectedCircles.map((id) => `Cir#${id}`),
      ...this.selectedArcs.map((id) => `Arc#${id}`),
    ].join(', ');

    const constraintsHtml = this.constraints
      .map((c, idx) => {
        const key = Object.keys(c)[0] ?? 'Constraint';
        const val = JSON.stringify((c as Record<string, unknown>)[key]);
        const isRef = this.referenceConstraints.includes(idx);
        const isConflict = conflicting.includes(idx);
        const isRedundant = redundant.includes(idx);
        return `
          <li class="cal-segment${isConflict ? ' segment-conflict' : isRedundant ? ' segment-redundant' : ''}">
            <input type="checkbox" class="sketch-c-ref" data-index="${idx}" ${!isRef ? 'checked' : ''} title="Driving" />
            <span class="cal-label">#${idx + 1} ${escapeHtml(key)} ${escapeHtml(val)}</span>
            <button class="sketch-c-del tool-btn cal-delete" type="button" data-index="${idx}" aria-label="Delete">×</button>
          </li>`;
      })
      .join('');

    const elementsHtml = [
      ...this.lines.map(
        (l) =>
          `<li class="cal-segment"><span class="cal-label">Linija #${l.id} (P${l.a}→P${l.b})${l.construction ? ' [C]' : ''}</span><button class="sketch-el-sel btn" type="button" data-kind="line" data-id="${l.id}">${this.selectedLines.includes(l.id) ? '✓' : 'Izb'}</button></li>`,
      ),
      ...this.circles.map(
        (c) =>
          `<li class="cal-segment"><span class="cal-label">Kružnica #${c.id} (R=${c.radius.toFixed(1)})${c.construction ? ' [C]' : ''}</span><button class="sketch-el-sel btn" type="button" data-kind="circle" data-id="${c.id}">${this.selectedCircles.includes(c.id) ? '✓' : 'Izb'}</button></li>`,
      ),
      ...this.arcs.map(
        (a) =>
          `<li class="cal-segment"><span class="cal-label">Luk #${a.id} (R=${a.radius.toFixed(1)})${a.construction ? ' [C]' : ''}</span><button class="sketch-el-sel btn" type="button" data-kind="arc" data-id="${a.id}">${this.selectedArcs.includes(a.id) ? '✓' : 'Izb'}</button></li>`,
      ),
    ].join('');

    const orig = this.viewer.getOrigin();

    this.panel.innerHTML = `
      <div class="panel-head">
        <h2 class="panel-title">${t(locale, 'sketch.title')}</h2>
        <button id="sketch-close" class="tool-btn" type="button" aria-label="${t(locale, 'calibrate.close')}">×</button>
      </div>
      ${solverBannerHtml}
      <p class="cal-hint">${selectionSummary ? `Izb: ${escapeHtml(selectionSummary)}` : t(locale, this.pending || this.arcStartPending || this.arc3PtPending ? 'sketch.finishChain' : 'sketch.hint')}</p>

      <details class="sketch-toolbar-box" role="group" open aria-label="Izbor i koordinatni sistem">
        <summary class="sketch-toolbar-title">1 · Izbor i koordinatni sistem (0,0)</summary>
        <div class="cal-actions">
          <button id="sketch-tool-select" class="btn ${this.tool === 'select' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.select')}">↖ Izaberi / Pomeri (V)</button>
          <button id="sketch-tool-origin" class="btn ${this.tool === 'origin' ? 'btn-tool-active' : ''}" type="button" title="Pomeri (0,0) koordinatni početak">🎯 Postavi (0,0) [${Math.round(orig.x)}, ${Math.round(orig.y)}]</button>
          <button id="sketch-origin-reset" class="btn" type="button" title="Resetuj (0,0) na donji levi ugao">↺ (0,0) Donji levi</button>
          <button id="sketch-undo" class="btn" type="button" title="${t(locale, 'sketch.undo')}">↶</button>
          <button id="sketch-redo" class="btn" type="button" title="${t(locale, 'sketch.redo')}">↷</button>
          <button id="sketch-delete" class="btn" type="button" title="${t(locale, 'sketch.delete')}">🗑</button>
        </div>
        <div class="cal-actions">
          <label class="cal-label"><input id="sketch-raster-snap" type="checkbox" ${this.rasterSnapEnabled ? 'checked' : ''} /> 🧲 Snap na raster</label>
          <label class="cal-label"><input id="sketch-pin-raster" type="checkbox" ${this.autoPinRaster ? 'checked' : ''} /> 📌 Prikvači na raster</label>
          <label class="cal-label"><input id="sketch-loupe" type="checkbox" ${this.loupeEnabled ? 'checked' : ''} /> 🔍 8×</label>
          <label class="cal-label"><input id="sketch-construction" type="checkbox" ${this.constructionMode ? 'checked' : ''} /> ${t(locale, 'sketch.construction')}</label>
          <label class="cal-label"><input id="sketch-auto" type="checkbox" ${this.autoConstraints ? 'checked' : ''} /> ${t(locale, 'sketch.autoConstraint')}</label>
          <label class="cal-label"><input id="sketch-grid-snap" type="checkbox" ${this.viewer.isGridSnapEnabled() ? 'checked' : ''} /> ${t(locale, 'sketch.gridSnap')}</label>
        </div>
      </details>

      <details class="sketch-toolbar-box" role="group" open aria-label="Alati za geometriju">
        <summary class="sketch-toolbar-title">2 · Crtanje i izmena geometrije</summary>
        <div class="cal-actions">
          <button id="sketch-tool-polyline" class="btn ${this.tool === 'polyline' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.polyline')}">Polilinija (P)</button>
          <button id="sketch-tool-line" class="btn ${this.tool === 'line' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.line')}">╱ Linija (L)</button>
          <button id="sketch-tool-rect" class="btn ${this.tool === 'rect' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.rect')}">▭ Pravougaonik (R)</button>
          <button id="sketch-tool-center-rect" class="btn ${this.tool === 'centerRect' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.centerRect')}">⊡ C-Prav.</button>
          <button id="sketch-tool-slot" class="btn ${this.tool === 'slot' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.slot')}">⬭ Slot (S)</button>
          <button id="sketch-tool-circle" class="btn ${this.tool === 'circle' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.circle')}">◯ Kružnica (C)</button>
          <button id="sketch-tool-arc" class="btn ${this.tool === 'arc' ? 'btn-tool-active' : ''}" type="button" title="Luk centar-početak-kraj (A)">◜ Luk C-P-K (A)</button>
          <button id="sketch-tool-arc3pt" class="btn ${this.tool === 'arc3pt' ? 'btn-tool-active' : ''}" type="button" title="Luk 3 tačke (Shift+A ili M)">⌒ Luk 3T</button>
          <button id="sketch-tool-polygon" class="btn ${this.tool === 'polygon' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.polygon')}">⬡ Poligon (G)</button>
          <button id="sketch-tool-fillet" class="btn ${this.tool === 'fillet' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.fillet')}">╭ Zaobljenje (F)</button>
          <button id="sketch-tool-trim" class="btn ${this.tool === 'trim' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.trim')}">✂ Odseci (T)</button>
          <button id="sketch-tool-mirror" class="btn ${this.tool === 'mirror' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.mirror')}">⇋ Ogledalo</button>
          <button id="sketch-tool-point" class="btn ${this.tool === 'point' ? 'btn-tool-active' : ''}" type="button" title="${t(locale, 'sketch.tool.point')}">• Tačka (O)</button>
        </div>
        ${
          this.pending || this.arcStartPending || this.arc3PtPending
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
          <button class="btn sketch-fc-c" data-action="Symmetric" type="button" title="Simetrija">>< Sim</button>
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
          <input id="sketch-c-val" class="cal-length w-54" type="number" value="50" aria-label="Value" />
          <button id="sketch-c-add" class="btn" type="button">+</button>
        </div>
      </details>

      <details class="sketch-toolbar-box" role="group" open aria-label="Rešavanje, fit i izvoz">
        <summary class="sketch-toolbar-title">5 · Rešavanje, RasterFit i izvoz</summary>
        <div class="cal-actions">
          <button id="sketch-solve" class="btn btn-primary" type="button">${t(locale, 'sketch.solve')}</button>
          <button id="sketch-fit" class="btn" type="button">${t(locale, 'sketch.fit')}</button>
          <button id="sketch-fit-preview" class="btn" type="button">${t(locale, 'sketch.fitPreview')}</button>
          ${this.preFitSnapshot ? `<button id="sketch-fit-cancel" class="btn" type="button">${t(locale, 'sketch.fitCancel')}</button>` : ''}
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
          <label class="cal-label"><input id="fit-opt-geom" type="checkbox" ${this.fitOpts.fitGeometry ? 'checked' : ''} /> ${t(locale, 'sketch.fitGeometry')}</label>
          <label class="cal-label"><input id="fit-opt-rot" type="checkbox" ${this.fitOpts.fitRotation ? 'checked' : ''} /> ${t(locale, 'sketch.fitRotation')}</label>
          <label class="cal-label"><input id="fit-opt-trans" type="checkbox" ${this.fitOpts.fitTranslation ? 'checked' : ''} /> ${t(locale, 'sketch.fitTranslation')}</label>
          <label class="cal-label"><input id="fit-opt-scale" type="checkbox" ${this.fitOpts.fitScale ? 'checked' : ''} /> ${t(locale, 'sketch.fitScale')}</label>
          <label class="cal-label"><input id="fit-opt-const" type="checkbox" ${this.fitOpts.includeConstruction ? 'checked' : ''} /> ${t(locale, 'sketch.construction')}</label>
        </div>
      </details>

      ${constraintsHtml ? `<ol class="cal-segments">${constraintsHtml}</ol>` : ''}
      ${elementsHtml ? `<details class="mb-8"><summary class="cal-subhead cursor-pointer">${t(locale, 'sketch.elements')} (${this.lines.length + this.circles.length + this.arcs.length})</summary><ol class="cal-segments">${elementsHtml}</ol></details>` : ''}

      <p class="cal-empty" id="sketch-result">${escapeHtml(this.resultText)}</p>
    `;

    this.panel.querySelector('#sketch-close')!.addEventListener('click', () => this.deactivate());
    this.panel.querySelector('#sketch-tool-polyline')!.addEventListener('click', () => this.setTool('polyline'));
    this.panel.querySelector('#sketch-tool-line')!.addEventListener('click', () => this.setTool('line'));
    this.panel.querySelector('#sketch-tool-rect')!.addEventListener('click', () => this.setTool('rect'));
    this.panel.querySelector('#sketch-tool-center-rect')!.addEventListener('click', () => this.setTool('centerRect'));
    this.panel.querySelector('#sketch-tool-slot')!.addEventListener('click', () => this.setTool('slot'));
    this.panel.querySelector('#sketch-tool-circle')!.addEventListener('click', () => this.setTool('circle'));
    this.panel.querySelector('#sketch-tool-arc')!.addEventListener('click', () => this.setTool('arc'));
    this.panel.querySelector('#sketch-tool-arc3pt')!.addEventListener('click', () => this.setTool('arc3pt'));
    this.panel.querySelector('#sketch-tool-polygon')!.addEventListener('click', () => this.setTool('polygon'));
    this.panel.querySelector('#sketch-tool-fillet')!.addEventListener('click', () => this.setTool('fillet'));
    this.panel.querySelector('#sketch-tool-trim')!.addEventListener('click', () => this.setTool('trim'));
    this.panel.querySelector('#sketch-tool-mirror')!.addEventListener('click', () => this.setTool('mirror'));
    this.panel.querySelector('#sketch-tool-point')!.addEventListener('click', () => this.setTool('point'));
    this.panel.querySelector('#sketch-tool-select')!.addEventListener('click', () => this.setTool('select'));
    this.panel.querySelector('#sketch-tool-origin')!.addEventListener('click', () => this.setTool('origin'));
    this.panel.querySelector('#sketch-origin-reset')!.addEventListener('click', () => {
      this.viewer.resetOrigin();
      const o = this.viewer.getOrigin();
      this.onStatus(`(0,0) → (${o.x.toFixed(0)}, ${o.y.toFixed(0)}) px`);
      this.render();
    });

    this.panel.querySelector('#sketch-finish-chain')?.addEventListener('click', () => {
      this.finishChain();
    });
    this.panel.querySelector('#sketch-remove-conflict')?.addEventListener('click', () => {
      if (conflicting.length > 0) {
        this.pushUndo();
        this.constraints.splice(conflicting[conflicting.length - 1], 1);
        void this.solve();
      }
    });
    this.panel.querySelector('#sketch-remove-redundant')?.addEventListener('click', () => {
      if (redundant.length > 0) {
        this.pushUndo();
        this.constraints.splice(redundant[redundant.length - 1], 1);
        void this.solve();
      }
    });

    this.panel.querySelector<HTMLInputElement>('#sketch-raster-snap')?.addEventListener('change', (e) => {
      this.rasterSnapEnabled = (e.target as HTMLInputElement).checked;
      this.viewer.requestRender();
    });
    this.panel.querySelector<HTMLInputElement>('#sketch-pin-raster')?.addEventListener('change', (e) => {
      this.autoPinRaster = (e.target as HTMLInputElement).checked;
    });
    this.panel.querySelector<HTMLInputElement>('#sketch-loupe')?.addEventListener('change', (e) => {
      this.loupeEnabled = (e.target as HTMLInputElement).checked;
      this.viewer.requestRender();
    });
    this.panel.querySelector<HTMLInputElement>('#sketch-construction')!.addEventListener('change', (e) => {
      this.constructionMode = (e.target as HTMLInputElement).checked;
    });
    this.panel.querySelector<HTMLInputElement>('#sketch-auto')!.addEventListener('change', (e) => {
      this.autoConstraints = (e.target as HTMLInputElement).checked;
    });
    this.panel.querySelector<HTMLInputElement>('#sketch-grid-snap')!.addEventListener('change', (e) => {
      this.viewer.setGridSnapEnabled((e.target as HTMLInputElement).checked);
    });

    this.panel.querySelectorAll<HTMLButtonElement>('.sketch-fc-c').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action) this.applyConstraintAction(action);
      });
    });

    this.panel.querySelectorAll<HTMLButtonElement>('.sketch-el-sel').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.kind;
        const id = Number(btn.dataset.id);
        if (kind === 'line') toggleInArray(this.selectedLines, id);
        else if (kind === 'circle') toggleInArray(this.selectedCircles, id);
        else if (kind === 'arc') toggleInArray(this.selectedArcs, id);
        this.render();
        this.viewer.requestRender();
      });
    });

    this.panel.querySelector('#sketch-solve')!.addEventListener('click', () => void this.solve());
    this.panel.querySelector('#sketch-fit')!.addEventListener('click', () => void this.fit(false));
    this.panel.querySelector('#sketch-fit-preview')!.addEventListener('click', () => void this.fit(true));
    this.panel.querySelector('#sketch-fit-cancel')?.addEventListener('click', () => this.cancelFitPreview());
    this.panel.querySelector('#sketch-undo')!.addEventListener('click', () => this.undo());
    this.panel.querySelector('#sketch-redo')!.addEventListener('click', () => this.redo());
    this.panel.querySelector('#sketch-delete')!.addEventListener('click', () => this.deleteSelected());
    this.panel.querySelector('#sketch-clear')!.addEventListener('click', () => this.clear());

    this.panel.querySelector<HTMLInputElement>('#fit-opt-geom')?.addEventListener('change', (e) => {
      this.fitOpts.fitGeometry = (e.target as HTMLInputElement).checked;
    });
    this.panel.querySelector<HTMLInputElement>('#fit-opt-rot')?.addEventListener('change', (e) => {
      this.fitOpts.fitRotation = (e.target as HTMLInputElement).checked;
    });
    this.panel.querySelector<HTMLInputElement>('#fit-opt-trans')?.addEventListener('change', (e) => {
      this.fitOpts.fitTranslation = (e.target as HTMLInputElement).checked;
    });
    this.panel.querySelector<HTMLInputElement>('#fit-opt-scale')?.addEventListener('change', (e) => {
      this.fitOpts.fitScale = (e.target as HTMLInputElement).checked;
    });
    this.panel.querySelector<HTMLInputElement>('#fit-opt-const')?.addEventListener('change', (e) => {
      this.fitOpts.includeConstruction = (e.target as HTMLInputElement).checked;
    });

    this.panel.querySelector('#sketch-c-add')!.addEventListener('click', () => {
      const type = (this.panel.querySelector('#sketch-c-type') as HTMLSelectElement).value;
      const e1 = Number((this.panel.querySelector('#sketch-c-e1') as HTMLInputElement).value);
      const e2 = Number((this.panel.querySelector('#sketch-c-e2') as HTMLInputElement).value);
      const val = Number((this.panel.querySelector('#sketch-c-val') as HTMLInputElement).value);
      this.addConstraintFromUi(type, e1, e2, val);
    });

    this.panel.querySelectorAll<HTMLInputElement>('.sketch-c-ref').forEach((el) => {
      const idx = Number(el.dataset.index);
      el.addEventListener('change', () => {
        if (el.checked) {
          this.referenceConstraints = this.referenceConstraints.filter((i) => i !== idx);
        } else if (!this.referenceConstraints.includes(idx)) {
          this.referenceConstraints.push(idx);
        }
        void this.solveSilent();
        this.viewer.requestRender();
        this.onChange?.();
      });
    });

    this.panel.querySelectorAll<HTMLButtonElement>('.sketch-c-del').forEach((el) => {
      const idx = Number(el.dataset.index);
      el.addEventListener('click', () => {
        this.pushUndo();
        this.constraints.splice(idx, 1);
        this.referenceConstraints = this.referenceConstraints
          .filter((i) => i !== idx)
          .map((i) => (i > idx ? i - 1 : i));
        void this.solveSilent();
        this.render();
        this.viewer.requestRender();
        this.onChange?.();
      });
    });

    this.panel.querySelector('#export-dxf')!.addEventListener('click', () => void this.exportDxf());
    this.panel.querySelector('#export-svg')!.addEventListener('click', () => void this.exportSvg());
    this.panel.querySelector('#export-json')!.addEventListener('click', () => void this.exportReportJson());
    this.panel.querySelector('#export-csv')!.addEventListener('click', () => void this.exportReportCsv());
  }
}

function toggleInArray(arr: number[], id: number): void {
  const idx = arr.indexOf(id);
  if (idx >= 0) arr.splice(idx, 1);
  else arr.push(id);
}

function isAngleInArc(ang: number, start: number, end: number, tolRad = 0.2): boolean {
  const twoPi = Math.PI * 2;
  const sweep = ((end - start) % twoPi + twoPi) % twoPi || twoPi;
  const rel = ((ang - start) % twoPi + twoPi) % twoPi;
  return rel <= sweep + tolRad || rel >= twoPi - tolRad;
}

function circumcircleArc(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
): { cx: number; cy: number; radius: number; startAngle: number; endAngle: number } | null {
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-5) return null;
  const s1 = x1 * x1 + y1 * y1;
  const s2 = x2 * x2 + y2 * y2;
  const s3 = x3 * x3 + y3 * y3;
  const cx = (s1 * (y2 - y3) + s2 * (y3 - y1) + s3 * (y1 - y2)) / d;
  const cy = (s1 * (x3 - x2) + s2 * (x1 - x3) + s3 * (x2 - x1)) / d;
  const radius = Math.hypot(x1 - cx, y1 - cy);
  if (!Number.isFinite(radius) || radius < 1 || radius > 1e6) return null;

  const twoPi = Math.PI * 2;
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  const a2 = Math.atan2(y2 - cy, x2 - cx);
  const a3 = Math.atan2(y3 - cy, x3 - cx);
  const sweep12 = ((a2 - a1) % twoPi + twoPi) % twoPi;
  const sweep13 = ((a3 - a1) % twoPi + twoPi) % twoPi;

  if (sweep13 <= sweep12) {
    return { cx, cy, radius, startAngle: a1, endAngle: a1 + sweep12 };
  }
  return { cx, cy, radius, startAngle: a2, endAngle: a2 + (twoPi - sweep12) };
}

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function projectPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { x: number; y: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return { x: ax, y: ay };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return { x: ax + t * dx, y: ay + t * dy };
}

function segmentIntersectsRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  if (
    (ax >= minX && ax <= maxX && ay >= minY && ay <= maxY) ||
    (bx >= minX && bx <= maxX && by >= minY && by <= maxY)
  ) {
    return true;
  }
  return (
    segmentIntersectionT(ax, ay, bx, by, minX, minY, maxX, minY) !== null ||
    segmentIntersectionT(ax, ay, bx, by, maxX, minY, maxX, maxY) !== null ||
    segmentIntersectionT(ax, ay, bx, by, maxX, maxY, minX, maxY) !== null ||
    segmentIntersectionT(ax, ay, bx, by, minX, maxY, minX, minY) !== null
  );
}

function segmentIntersectionT(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  x4: number,
  y4: number,
): number | null {
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return t;
  return null;
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
