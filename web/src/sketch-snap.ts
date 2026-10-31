// Sub-pixel raster snapping for the sketch editor.
// Scores dark pixels near the cursor and refines to sub-pixel via
// parabolic interpolation of the darkness profile.

export interface GrayBuffer {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface SnapResult {
  x: number;
  y: number;
  snapped: boolean;
}

/** Sub-pixel snap to a dark raster line/corner within `r = 8 px` on the PDF/image scan. */
export function snapToDarkRidge(buf: GrayBuffer, pt: { x: number; y: number }): SnapResult {
  const { data, width, height } = buf;
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
  return bestScore > 0 ? { x: bestU, y: bestV, snapped: true } : { x: pt.x, y: pt.y, snapped: false };
}
