// Raster worker: decodes a full-res ImageBitmap into a gray8 analysis buffer
// and an ImageBitmap tile pyramid, then transfers the pyramid back to the
// main thread. The gray8 buffer stays here (keyed by page index) for the
// calibration/ridge milestones (M2/M3).

import {
  computeLevels,
  TILE_SIZE,
  type PageMeta,
  type PyramidLevel,
  type RasterPage,
} from './raster';

interface BuildRequest {
  type: 'build';
  id: number;
  meta: PageMeta;
  bitmap: ImageBitmap;
}

interface FreeRequest {
  type: 'free';
  pageIndex: number;
}

type Request = BuildRequest | FreeRequest;

interface BuildOk {
  id: number;
  ok: true;
  page: RasterPage;
}

interface BuildErr {
  id: number;
  ok: false;
  error: string;
}

type Response = BuildOk | BuildErr;

// Minimal worker global typing without pulling in the whole `webworker` lib
// (which would collide with the DOM lib used by the rest of the app).
const worker = globalThis as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(msg: Response, transfer?: Transferable[]): void;
};

/** gray8 buffers, keyed by page index, retained for M2/M3. */
const grayBuffers = new Map<number, Uint8Array>();

/** Luminance (Rec. 709) from an RGBA pixel array. */
function toGray8(rgba: Uint8ClampedArray): Uint8Array {
  const gray = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
    gray[j] = Math.round(0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]);
  }
  return gray;
}

async function buildPyramid(bitmap: ImageBitmap, meta: PageMeta): Promise<PyramidLevel[]> {
  const metas = computeLevels(meta.width, meta.height, TILE_SIZE);
  const levels: PyramidLevel[] = [];

  // One full-res draw feeds both the gray8 buffer and the level-0 tiles.
  const full = new OffscreenCanvas(meta.width, meta.height);
  const fctx = full.getContext('2d', { willReadFrequently: true });
  if (!fctx) throw new Error('OffscreenCanvas 2D context unavailable');
  fctx.drawImage(bitmap, 0, 0, meta.width, meta.height);
  grayBuffers.set(meta.pageIndex, toGray8(fctx.getImageData(0, 0, meta.width, meta.height).data));

  // The current level's full bitmap; higher levels are drawn from the previous.
  let source: ImageBitmap | OffscreenCanvas = full;

  for (const m of metas) {
    let levelSource: ImageBitmap | OffscreenCanvas = source;
    if (m.level > 0) {
      const canvas = new OffscreenCanvas(m.width, m.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
      ctx.drawImage(source, 0, 0, m.width, m.height);
      levelSource = canvas;
      source = canvas;
    }

    const tiles: ImageBitmap[] = [];
    for (let row = 0; row < m.tileRows; row += 1) {
      for (let col = 0; col < m.tileCols; col += 1) {
        const w = Math.min(TILE_SIZE, m.width - col * TILE_SIZE);
        const h = Math.min(TILE_SIZE, m.height - row * TILE_SIZE);
        tiles.push(await createImageBitmap(levelSource, col * TILE_SIZE, row * TILE_SIZE, w, h));
      }
    }
    levels.push({ ...m, tiles });
  }

  return levels;
}

worker.onmessage = async (e) => {
  const req = e.data;
  if (req.type === 'free') {
    grayBuffers.delete(req.pageIndex);
    return;
  }

  try {
    const levels = await buildPyramid(req.bitmap, req.meta);
    const transfer = levels.flatMap((l) => l.tiles);
    worker.postMessage({ id: req.id, ok: true, page: { meta: req.meta, levels } }, transfer);
  } catch (err) {
    worker.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
