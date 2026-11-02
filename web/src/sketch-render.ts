// Canvas overlay rendering for the sketch editor: entities, selection,
// constraint glyphs, rubber-band previews, snap indicators, loupe.
// Consumes the controller's public (internal) state — see sketch-ui.ts.

import type { SavedSketchLine } from './project';
import { circumcircleArc } from './sketch-geometry';
import type { SketchController } from './sketch-ui';


interface OverlayColors {
  accent: string;
  success: string;
  constructionColor: string;
  selectColor: string;
  hoverColor: string;
  warning: string;
  danger: string;
}

interface StaticCacheEntry {
  key: string;
  canvas: HTMLCanvasElement;
}

let staticCache: StaticCacheEntry | null = null;

/** Cheap O(n) fingerprint of everything the static overlay layer draws. */
function staticFingerprint(
  sk: SketchController,
  m: number[],
  w: number,
  h: number,
  colors: OverlayColors,
): string {
  let h1 = 0;
  let h2 = 0;
  const mix = (v: number): void => {
    h1 = (h1 * 31 + v) | 0;
    h2 = (h2 * 131 + v * 7) | 0;
  };
  for (const p of sk.points) {
    mix(p.id);
    mix(Math.round(p.x * 512));
    mix(Math.round(p.y * 512));
  }
  for (const l of sk.lines) {
    mix(l.id);
    mix(l.a);
    mix(l.b);
    mix(l.construction ? 1 : 0);
  }
  for (const c of sk.circles) {
    mix(c.id);
    mix(Math.round(c.radius * 512));
    mix(c.construction ? 1 : 0);
  }
  for (const a of sk.arcs) {
    mix(a.id);
    mix(Math.round(a.radius * 512));
    mix(Math.round(a.start * 4096));
    mix(Math.round(a.end * 4096));
    mix(a.construction ? 1 : 0);
  }
  for (const id of sk.selectedPoints) mix(id);
  for (const id of sk.selectedLines) mix(id + 5000);
  for (const id of sk.selectedCircles) mix(id + 10000);
  for (const id of sk.selectedArcs) mix(id + 15000);
  mix(sk.hoverEntity ? sk.hoverEntity.id + sk.hoverEntity.kind.length * 1000 : -1);
  mix(sk.editingConstraintIdx ?? -1);
  mix(sk.lastSolve ? sk.lastSolve.dof : -1);
  mix(sk.lastSolve ? sk.lastSolve.conflicting.length : -1);
  mix(sk.lastFit ? Math.round(sk.lastFit.rms_px * 1000) : -1);
  mix(sk.lastFit?.primitive_stats?.length ?? -1);
  for (const idx of sk.referenceConstraints) mix(idx + 20000);
  let cHash = 0;
  for (const c of sk.constraints) {
    const s = JSON.stringify(c);
    for (let i = 0; i < s.length; i += 1) cHash = (cHash * 33 + s.charCodeAt(i)) | 0;
  }
  const mKey = m.map((v) => v.toFixed(4)).join(',');
  return `${h1}:${h2}:${cHash}:${mKey}:${w}x${h}:${colors.accent}|${colors.warning}|${colors.danger}`;
}

export function drawSketchOverlay(sk: SketchController, ctx: CanvasRenderingContext2D): void {
    if (
      !sk.active &&
      sk.points.length === 0 &&
      sk.lines.length === 0 &&
      sk.circles.length === 0 &&
      sk.arcs.length === 0
    ) {
      return;
    }
    const to = sk.viewer.rasterToScreen.bind(sk.viewer);
    const m = sk.viewer.getCombinedTransform();
    const colors: OverlayColors = {
      accent: getComputedStyle(sk.panel).getPropertyValue('--color-accent').trim() || '#2465c7',
      success: '#16a34a', // FreeCAD Fully Constrained Green
      constructionColor: '#3b82f6', // FreeCAD Construction Blue
      selectColor: '#0ea5e9', // FreeCAD Selection Cyan
      hoverColor: '#f59f00', // Hover highlight Gold
      warning: getComputedStyle(sk.panel).getPropertyValue('--color-warning').trim() || '#b54708',
      danger: getComputedStyle(sk.panel).getPropertyValue('--color-danger').trim() || '#dc2626',
    };

        // Static layer (committed entities + constraint glyphs) is cached in an
    // offscreen canvas and re-rendered only when the fingerprint changes;
    // cursor-driven previews are always drawn on top.
    const key = staticFingerprint(sk, m, ctx.canvas.width, ctx.canvas.height, colors);
    if (!staticCache || staticCache.key !== key) {
      const off = staticCache?.canvas ?? document.createElement('canvas');
      if (off.width !== ctx.canvas.width || off.height !== ctx.canvas.height) {
        off.width = ctx.canvas.width;
        off.height = ctx.canvas.height;
      }
      const octx = off.getContext('2d');
      if (octx) {
        const dpr = window.devicePixelRatio || 1;
        octx.setTransform(1, 0, 0, 1, 0, 0);
        octx.clearRect(0, 0, off.width, off.height);
        octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderStaticEntities(sk, octx, to, m, colors);
        staticCache = { key, canvas: off };
      }
    }
    if (staticCache) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(staticCache.canvas, 0, 0);
      ctx.restore();
    } else {
      renderStaticEntities(sk, ctx, to, m, colors);
    }

    // Draw FreeCAD Marquee Box Selection (Left-to-Right = Window Blue, Right-to-Left = Crossing Green)
    if (sk.dragState?.kind === 'box' && sk.lastMouse) {
      const x0 = sk.dragState.x0;
      const y0 = sk.dragState.y0;
      const x1 = sk.lastMouse.x;
      const y1 = sk.lastMouse.y;
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
      ctx.fillText(crossing ? 'Presijecajući izbor' : 'Izbor okvirom', rx + 6, Math.max(14, ry - 5));
      ctx.restore();
    }

    // Highlight (0,0) Origin bullseye when hovered or in 'origin' tool
    if (sk.tool === 'origin' || sk.hoverEntity?.kind === 'origin') {
      const orig = sk.viewer.getOrigin();
      const os = to(orig.x, orig.y);
      ctx.save();
      ctx.strokeStyle = colors.hoverColor;
      ctx.lineWidth = 2.25;
      ctx.beginPath();
      ctx.arc(os.x, os.y, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // On-Canvas FreeCAD Constraint Glyphs & Dimension Leaders

    // Live cursor snap highlight + rubber-band preview when active.
    if (sk.active && sk.lastMouse) {
      if (sk.activeConstraintTool) {
        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
        const badgeText = `Ograničenje: ${sk.activeConstraintTool} (klikni elemente · Esc za izlaz)`;
        const bw = ctx.measureText(badgeText).width + 14;
        ctx.fillRect(sk.lastMouse.x + 14, sk.lastMouse.y + 14, bw, 22);
        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 11px Arial, sans-serif';
        ctx.fillText(badgeText, sk.lastMouse.x + 21, sk.lastMouse.y + 29);
        ctx.restore();
      }
      if (sk.tool !== 'select') {
        const toolText = sk.toolLabel();
        ctx.save();
        ctx.font = 'bold 11px Arial, sans-serif';
        const bw = ctx.measureText(toolText).width + 14;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.fillRect(sk.lastMouse.x + 14, sk.lastMouse.y - 32, bw, 20);
        ctx.fillStyle = '#7dd3fc';
        ctx.fillText(toolText, sk.lastMouse.x + 21, sk.lastMouse.y - 18);
        ctx.restore();
      }
      const rect = ctx.canvas.getBoundingClientRect();
      const curRaster = sk.viewer.clientToRaster(
        rect.left + sk.lastMouse.x,
        rect.top + sk.lastMouse.y,
      );
      if (curRaster) {
        const snapPt = !sk.lastMouse.altKey
          ? sk.findNearPoint(curRaster.x, curRaster.y, 16)
          : null;
        if (snapPt) {
          const sp = to(snapPt.x, snapPt.y);
          ctx.save();
          ctx.strokeStyle = colors.success;
          ctx.lineWidth = 2.25;
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, 9, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = colors.success;
          ctx.font = 'bold 11px Arial, sans-serif';
          ctx.fillText('● Podud.', sp.x + 11, sp.y - 8);
          ctx.restore();
        }

        const rSnap =
          !snapPt && sk.rasterSnapEnabled && sk.grayCache
            ? sk.snapRasterPoint(curRaster, sk.lastMouse.altKey)
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
            : sk.snapInputCoord(curRaster.x, curRaster.y, sk.lastMouse.altKey);
        const targetX = snappedCoord.x;
        const targetY = snappedCoord.y;
        const targetScreen = to(targetX, targetY);
        const scaleMm = sk.getScaleMm();
        const unitLabel = 'mm';

        if (sk.pending) {
          const pendPt =
            sk.pending.pointId !== undefined
              ? sk.points.find((p) => p.id === sk.pending!.pointId)
              : null;
          const pendX = pendPt ? pendPt.x : sk.pending.x;
          const pendY = pendPt ? pendPt.y : sk.pending.y;
          const startScreen = to(pendX, pendY);
          ctx.save();
          ctx.strokeStyle = colors.accent;
          ctx.fillStyle = colors.accent;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.arc(startScreen.x, startScreen.y, 4.5, 0, Math.PI * 2);
          ctx.fill();

          if (sk.tool === 'line' || sk.tool === 'polyline') {
            const dx = targetX - pendX;
            const dy = targetY - pendY;
            const len = Math.hypot(dx, dy);
            const deg = (Math.atan2(-dy, dx) * 180) / Math.PI;
            let hvBadge = sk.tool === 'polyline' && sk.polyMode !== 'line' ? ` [${sk.polyMode}]` : '';
            if (sk.autoConstraints && !sk.lastMouse.altKey && len > 2 && hvBadge === '') {
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
          } else if (sk.tool === 'rect' || sk.tool === 'roundedRect') {
            const w = targetScreen.x - startScreen.x;
            const h = targetScreen.y - startScreen.y;
            ctx.strokeRect(startScreen.x, startScreen.y, w, h);
            const rw = Math.abs(targetX - pendX) * scaleMm;
            const rh = Math.abs(targetY - pendY) * sk.getScaleMm('y');
            ctx.fillText(
              `${rw.toFixed(1)} × ${rh.toFixed(1)} ${unitLabel}`,
              targetScreen.x + 10,
              targetScreen.y - 10,
            );
          } else if (sk.tool === 'centerRect') {
            const hw = Math.abs(targetScreen.x - startScreen.x);
            const hh = Math.abs(targetScreen.y - startScreen.y);
            ctx.strokeRect(startScreen.x - hw, startScreen.y - hh, hw * 2, hh * 2);
          } else if (sk.tool === 'circle' || sk.tool === 'polygon' || sk.tool === 'arc') {
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
          } else if (sk.tool === 'slot') {
            ctx.beginPath();
            ctx.moveTo(startScreen.x, startScreen.y);
            ctx.lineTo(targetScreen.x, targetScreen.y);
            ctx.stroke();
          }
          ctx.restore();
        } else if (sk.arcStartPending) {
          const center = sk.points.find((p) => p.id === sk.arcStartPending!.centerId);
          if (center) {
            const sc = to(center.x, center.y);
            const rawEnd = Math.atan2(targetY - center.y, targetX - center.x);
            let sweep =
              ((rawEnd - sk.arcStartPending.startAngle) % (2 * Math.PI) + 2 * Math.PI) %
              (2 * Math.PI);
            if (sweep < 1e-3) sweep = Math.PI;
            const startAngle = sk.lastMouse.altKey ? rawEnd : sk.arcStartPending.startAngle;
            const endAngle = sk.lastMouse.altKey
              ? rawEnd + (2 * Math.PI - sweep)
              : startAngle + sweep;
            const endRimScreen = to(
              center.x + sk.arcStartPending.radius * Math.cos(rawEnd),
              center.y + sk.arcStartPending.radius * Math.sin(rawEnd),
            );
            ctx.save();
            ctx.strokeStyle = colors.accent;
            ctx.fillStyle = colors.accent;
            ctx.setLineDash([5, 4]);
            ctx.save();
            ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
            ctx.beginPath();
            ctx.arc(center.x, center.y, sk.arcStartPending.radius, startAngle, endAngle);
            ctx.restore();
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(sc.x, sc.y);
            ctx.lineTo(endRimScreen.x, endRimScreen.y);
            ctx.stroke();
            const degSweep = (((endAngle - startAngle) * 180) / Math.PI).toFixed(1);
            ctx.fillText(
              `R ${(sk.arcStartPending.radius * scaleMm).toFixed(1)} ${unitLabel} · Δ∠ ${degSweep}°`,
              endRimScreen.x + 10,
              endRimScreen.y - 10,
            );
            ctx.restore();
          }
        } else if (sk.arc3PtPending) {
          const s1 = to(sk.arc3PtPending.x1, sk.arc3PtPending.y1);
          ctx.save();
          ctx.strokeStyle = colors.accent;
          ctx.fillStyle = colors.accent;
          ctx.setLineDash([5, 4]);
          if (sk.arc3PtPending.p2Id === undefined) {
            ctx.beginPath();
            ctx.moveTo(s1.x, s1.y);
            ctx.lineTo(targetScreen.x, targetScreen.y);
            ctx.stroke();
            const chord = Math.hypot(targetX - sk.arc3PtPending.x1, targetY - sk.arc3PtPending.y1);
            ctx.fillText(
              `Tetiva ${(chord * scaleMm).toFixed(1)} ${unitLabel}`,
              targetScreen.x + 10,
              targetScreen.y - 10,
            );
          } else {
            const circ = circumcircleArc(
              sk.arc3PtPending.x1,
              sk.arc3PtPending.y1,
              sk.arc3PtPending.x2!,
              sk.arc3PtPending.y2!,
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
        } else if (sk.polyArcPending) {
          const pa = sk.polyArcPending;
          const circ = circumcircleArc(pa.ax, pa.ay, pa.bx, pa.by, targetX, targetY);
          ctx.save();
          ctx.strokeStyle = colors.accent;
          ctx.fillStyle = colors.accent;
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
        if (sk.loupeEnabled) {
          drawSketchLoupe(sk, ctx, sk.lastMouse.x, sk.lastMouse.y, targetX, targetY, colors.accent);
        }
      }
    } else if (sk.pending) {
      const s = to(sk.pending.x, sk.pending.y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    
  }



function renderStaticEntities(
  sk: SketchController,
  ctx: CanvasRenderingContext2D,
  to: (rx: number, ry: number) => { x: number; y: number },
  m: number[],
  colors: OverlayColors,
): void {
const lineColor = (l: SavedSketchLine): string => {
      if (sk.selectedLines.includes(l.id)) return colors.selectColor;
      if (sk.hoverEntity?.kind === 'line' && sk.hoverEntity.id === l.id) return colors.hoverColor;
      if (sk.lastSolve && sk.lastSolve.conflicting.length > 0) return colors.danger;
      if (l.construction) return colors.constructionColor;
      const stat = sk.lastFit?.primitive_stats?.find((s) => s.kind === 'line' && s.id === l.id);
      if (stat) {
        if (stat.rms_px < 0.3) return colors.success;
        if (stat.rms_px < 1.0) return colors.warning;
        return colors.danger;
      }
      if ((sk.lastSolve && sk.lastSolve.dof === 0) || (sk.isPointLocked(l.a) && sk.isPointLocked(l.b))) {
        return colors.success;
      }
      return colors.accent;
    };

    ctx.save();
    ctx.lineWidth = 2.25;
    ctx.font = '12px Arial, sans-serif';

    // Lines.
    for (const l of sk.lines) {
      const pa = sk.points.find((p) => p.id === l.a);
      const pb = sk.points.find((p) => p.id === l.b);
      if (!pa || !pb) continue;
      const a = to(pa.x, pa.y);
      const b = to(pb.x, pb.y);
      const isHi =
        sk.selectedLines.includes(l.id) ||
        (sk.hoverEntity?.kind === 'line' && sk.hoverEntity.id === l.id);
      ctx.strokeStyle = lineColor(l);
      ctx.lineWidth = isHi ? 3.25 : 2.25;
      ctx.setLineDash(l.construction ? [6, 4] : []);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Circles (path built in raster space via combined transform m so zoom/rotation is 100% locked).
    for (const c of sk.circles) {
      const center = sk.points.find((p) => p.id === c.center);
      if (!center) continue;
      const isSel = sk.selectedCircles.includes(c.id);
      const isHov = sk.hoverEntity?.kind === 'circle' && sk.hoverEntity.id === c.id;
      ctx.strokeStyle = isSel
        ? colors.selectColor
        : isHov
          ? colors.hoverColor
          : c.construction
            ? colors.constructionColor
            : sk.isCircleLocked(c.id) || (sk.lastSolve && sk.lastSolve.dof === 0)
              ? colors.success
              : colors.accent;
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
    for (const a of sk.arcs) {
      const center = sk.points.find((p) => p.id === a.center);
      if (!center) continue;
      const isSel = sk.selectedArcs.includes(a.id);
      const isHov = sk.hoverEntity?.kind === 'arc' && sk.hoverEntity.id === a.id;
      ctx.strokeStyle = isSel
        ? colors.selectColor
        : isHov
          ? colors.hoverColor
          : a.construction
            ? colors.constructionColor
            : sk.lastSolve && sk.lastSolve.dof === 0
              ? colors.success
              : colors.accent;
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
          ctx.strokeStyle = isSel ? colors.selectColor : colors.hoverColor;
          ctx.lineWidth = 2;
          ctx.fillRect(hp.x - 4, hp.y - 4, 8, 8);
          ctx.strokeRect(hp.x - 4, hp.y - 4, 8, 8);
        }
        ctx.restore();
      }
    }

    ctx.setLineDash([]);

    // Points.
    for (const p of sk.points) {
      const s = to(p.x, p.y);
      const selected = sk.selectedPoints.includes(p.id);
      const hovered = sk.hoverEntity?.kind === 'point' && sk.hoverEntity.id === p.id;
      const locked = sk.isPointLocked(p.id) || (sk.lastSolve && sk.lastSolve.dof === 0);
      if (selected || hovered) {
        ctx.save();
        ctx.strokeStyle = selected ? colors.selectColor : colors.hoverColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.fillStyle = selected ? colors.selectColor : hovered ? colors.hoverColor : locked ? colors.success : '#e03131';
      ctx.beginPath();
      ctx.arc(s.x, s.y, selected || hovered ? 5.5 : 4, 0, Math.PI * 2);
      ctx.fill();
    }

  drawConstraintsOverlay(sk, ctx, to, colors.danger, colors.constructionColor);
  ctx.restore();
}

function drawSketchLoupe(
  sk: SketchController,
    ctx: CanvasRenderingContext2D,
    mouseX: number,
    mouseY: number,
    rasterX: number,
    rasterY: number,
    accent: string,
  ): void {
    const page = sk.viewer.getPage();
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


function drawConstraintsOverlay(
  sk: SketchController,
    ctx: CanvasRenderingContext2D,
    to: (rx: number, ry: number) => { x: number; y: number },
    drivingColor: string,
    refColor: string,
  ): void {
    sk.dimBadgeRects = [];
    ctx.save();
    ctx.font = 'bold 11px Arial, sans-serif';

    sk.constraints.forEach((c, idx) => {
      const key = Object.keys(c)[0];
      const val = (c as Record<string, unknown>)[key];
      const isRef = sk.referenceConstraints.includes(idx);
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
          clickableIdx !== undefined && sk.editingConstraintIdx === clickableIdx
            ? '#fef08a'
            : 'rgba(255, 255, 255, 0.92)';
        ctx.fillRect(sx - w / 2, sy - 9, w, 16);
        ctx.strokeStyle = color;
        ctx.lineWidth =
          clickableIdx !== undefined && sk.editingConstraintIdx === clickableIdx ? 2 : 1;
        ctx.strokeRect(sx - w / 2, sy - 9, w, 16);
        ctx.fillStyle = color;
        ctx.fillText(text, sx - w / 2 + 4, sy + 3);
        if (clickableIdx !== undefined) {
          sk.dimBadgeRects.push({
            cIdx: clickableIdx,
            x: sx - w / 2 - 4,
            y: sy - 11,
            w: w + 8,
            h: 20,
          });
        }
      };

      if (key === 'Horizontal' || key === 'Vertical') {
        const l = sk.lines.find((x) => x.id === (val as number));
        if (!l) return;
        const pa = sk.points.find((p) => p.id === l.a);
        const pb = sk.points.find((p) => p.id === l.b);
        if (!pa || !pb) return;
        const a = to(pa.x, pa.y);
        const b = to(pb.x, pb.y);
        drawBadge((a.x + b.x) / 2, (a.y + b.y) / 2 - 12, key === 'Horizontal' ? 'H' : 'V');
      } else if (key === 'Parallel' || key === 'Perpendicular' || key === 'EqualLength') {
        const arr = val as number[];
        const l = sk.lines.find((x) => x.id === arr[0]);
        if (!l) return;
        const pa = sk.points.find((p) => p.id === l.a);
        const pb = sk.points.find((p) => p.id === l.b);
        if (!pa || !pb) return;
        const a = to(pa.x, pa.y);
        const b = to(pb.x, pb.y);
        const sym = key === 'Parallel' ? '∥' : key === 'Perpendicular' ? '⊥' : '=';
        drawBadge((a.x + b.x) / 2 + 12, (a.y + b.y) / 2 + 12, sym);
      } else if (key === 'Coincident') {
        const arr = val as number[];
        const pt = sk.points.find((p) => p.id === arr[0]);
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
        const pt = sk.points.find((p) => p.id === arr[0]);
        if (!pt) return;
        const s = to(pt.x, pt.y);
        drawBadge(s.x + 12, s.y - 10, '🔒');
      } else if (key === 'Distance' || key === 'HorizontalDistance' || key === 'VerticalDistance') {
        const arr = val as number[];
        const p1 = sk.points.find((p) => p.id === arr[0]);
        const p2 = sk.points.find((p) => p.id === arr[1]);
        if (!p1 || !p2) return;
        const a = to(p1.x, p1.y);
        const b = to(p2.x, p2.y);
        const mmVal = (sk.dimensionDisplayValue(c, idx) ?? 0).toFixed(1);
        const prefix = key === 'HorizontalDistance' ? 'ΔX ' : key === 'VerticalDistance' ? 'ΔY ' : '';
        ctx.strokeStyle = dimColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y - 18);
        ctx.lineTo(b.x, b.y - 18);
        ctx.stroke();
        ctx.setLineDash([]);
        drawBadge(
          (a.x + b.x) / 2,
          (a.y + b.y) / 2 - 22,
          `${prefix}${mmVal} mm`,
          dimColor,
          isRef ? undefined : idx,
        );
      } else if (key === 'DistancePointLine') {
        const arr = val as number[];
        const pt = sk.points.find((p) => p.id === arr[0]);
        if (!pt) return;
        const s = to(pt.x, pt.y);
        const mmVal = (sk.dimensionDisplayValue(c, idx) ?? 0).toFixed(1);
        drawBadge(s.x + 18, s.y - 18, `${mmVal} mm`, dimColor, isRef ? undefined : idx);
      } else if (key === 'LineLength') {
        const arr = val as number[];
        const l = sk.lines.find((x) => x.id === arr[0]);
        if (!l) return;
        const pa = sk.points.find((p) => p.id === l.a);
        const pb = sk.points.find((p) => p.id === l.b);
        if (!pa || !pb) return;
        const a = to(pa.x, pa.y);
        const b = to(pb.x, pb.y);
        const mmVal = (sk.dimensionDisplayValue(c, idx) ?? 0).toFixed(1);
        drawBadge(
          (a.x + b.x) / 2,
          (a.y + b.y) / 2 - 22,
          `${mmVal} mm`,
          dimColor,
          isRef ? undefined : idx,
        );
      } else if (key === 'Radius' || key === 'Diameter' || key === 'ArcRadius') {
        const arr = val as number[];
        const entity =
          key === 'ArcRadius'
            ? sk.arcs.find((x) => x.id === arr[0])
            : sk.circles.find((x) => x.id === arr[0]);
        if (!entity) return;
        const center = sk.points.find((p) => p.id === entity.center);
        if (!center) return;
        const sc = to(center.x, center.y);
        const mmVal = (sk.dimensionDisplayValue(c, idx) ?? 0).toFixed(1);
        const prefix = key === 'Diameter' ? '⌀ ' : 'R ';
        drawBadge(sc.x + 24, sc.y - 18, `${prefix}${mmVal} mm`, dimColor, isRef ? undefined : idx);
      } else if (key === 'Angle' || key === 'AngleLine') {
        const arr = val as number[];
        const l = sk.lines.find((x) => x.id === arr[0]);
        if (!l) return;
        const pa = sk.points.find((p) => p.id === l.a);
        if (!pa) return;
        const sa = to(pa.x, pa.y);
        const degVal = (sk.dimensionDisplayValue(c, idx) ?? 0).toFixed(1);
        drawBadge(sa.x + 22, sa.y - 16, `∠ ${degVal}°`, dimColor, isRef ? undefined : idx);
      }
    });

    ctx.restore();
  }


