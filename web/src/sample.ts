// Bundled synthetic drawing used by "Try a sample". Generates a simple
// technical-drawing-like raster (rectangle, circle, diagonal, dimension ticks)
// in-memory, so the full import → pyramid → viewer path can be exercised
// without a user-supplied file.

import type { PageMeta } from './raster';

export const SAMPLE_SIZE = { width: 1600, height: 1200 };

export interface SampleRaster {
  bitmap: ImageBitmap;
  meta: PageMeta;
  name: string;
}

export function createSampleRaster(): SampleRaster {
  const { width, height } = SAMPLE_SIZE;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#101418';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Outer rectangle with a centered circle and a diagonal.
  const margin = 160;
  const right = width - margin;
  const bottom = height - margin;
  ctx.strokeRect(margin, margin, right - margin, bottom - margin);

  const cx = width / 2;
  const cy = height / 2;
  ctx.beginPath();
  ctx.arc(cx, cy, 200, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(margin, bottom);
  ctx.lineTo(right, margin);
  ctx.stroke();

  // A horizontal center line with dimension-style ticks.
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(margin, cy);
  ctx.lineTo(right, cy);
  ctx.stroke();

  return {
    bitmap: canvas.transferToImageBitmap(),
    meta: { pageIndex: 0, width, height, dpi: 0 },
    name: 'sample',
  };
}
