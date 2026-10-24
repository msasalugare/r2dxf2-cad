// Dot-grid viewer background. M0: static grid + pan/zoom-ready coordinate math.

export interface Viewer {
  resize(): void;
  destroy(): void;
}

const GRID_SPACING = 24; // px, mirrors --geometry-viewer-grid-spacing in tokens
const DOT_RADIUS = 1;

/**
 * Paint a dot grid over the full canvas. The grid color is read from the CSS
 * custom property so light/dark themes both work without JS knowledge of the
 * palette.
 */
export function initViewer(canvas: HTMLCanvasElement): Viewer {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { resize: () => {}, destroy: () => {} };
  }

  const dpr = window.devicePixelRatio || 1;

  function draw(): void {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

    const style = getComputedStyle(canvas);
    const dot = style.getPropertyValue('--color-viewer-grid-dot').trim() || '#d3d7dc';

    ctx!.clearRect(0, 0, w, h);
    ctx!.fillStyle = dot;
    for (let x = GRID_SPACING / 2; x < w; x += GRID_SPACING) {
      for (let y = GRID_SPACING / 2; y < h; y += GRID_SPACING) {
        ctx!.beginPath();
        ctx!.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
        ctx!.fill();
      }
    }
  }

  function resize(): void {
    draw();
  }

  draw();
  window.addEventListener('resize', resize);

  return {
    resize,
    destroy() {
      window.removeEventListener('resize', resize);
    },
  };
}
