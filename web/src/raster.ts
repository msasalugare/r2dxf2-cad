// Raster document model and tile-pyramid math.
//
// The raster is a gray8 buffer plus an ImageBitmap tile pyramid. Only the
// pyramid tiles are transferred to the main thread for display; the gray8
// analysis buffer stays in the worker for later milestones (M2/M3).

export const TILE_SIZE = 256;

/** Per-page metadata (no pixel data). */
export interface PageMeta {
  /** 0-based page index in the source document. */
  pageIndex: number;
  /** Raster width in pixels. */
  width: number;
  /** Raster height in pixels. */
  height: number;
  /** Source DPI, or 0 when unknown (raster images without metadata). */
  dpi: number;
}

/** Metadata for one pyramid level (no tile data). */
export interface LevelMeta {
  /** 0 = full resolution; each level is ~half the previous. */
  level: number;
  width: number;
  height: number;
  tileCols: number;
  tileRows: number;
  /** levelWidth / pageWidth, used to map full-res px to level px. */
  scale: number;
}

/** A built pyramid level with its ImageBitmap tiles (row-major). */
export interface PyramidLevel extends LevelMeta {
  tiles: ImageBitmap[];
}

/** A decoded page: metadata plus the tile pyramid used for display. */
export interface RasterPage {
  meta: PageMeta;
  levels: PyramidLevel[];
}

/**
 * Compute pyramid level metadata for a page.
 *
 * Level 0 is full resolution; each subsequent level halves the dimensions
 * (rounded up, so the last row/column is never lost). The pyramid stops once a
 * single tile covers the whole page.
 */
export function computeLevels(
  width: number,
  height: number,
  tileSize = TILE_SIZE,
): LevelMeta[] {
  const levels: LevelMeta[] = [];
  let level = 0;
  let w = Math.max(1, width);
  let h = Math.max(1, height);

  for (;;) {
    const tileCols = Math.ceil(w / tileSize);
    const tileRows = Math.ceil(h / tileSize);
    levels.push({ level, width: w, height: h, tileCols, tileRows, scale: w / width });
    if (w <= tileSize && h <= tileSize) break;
    w = Math.max(1, Math.ceil(w / 2));
    h = Math.max(1, Math.ceil(h / 2));
    level += 1;
  }
  return levels;
}

/** Flat tile index for a level, in row-major order. */
export function tileIndex(level: LevelMeta, col: number, row: number): number {
  return row * level.tileCols + col;
}

/** Pixel width of the tile at `col` (the last tile may be narrower). */
export function tileWidth(level: LevelMeta, col: number): number {
  return Math.min(TILE_SIZE, level.width - col * TILE_SIZE);
}

/** Pixel height of the tile at `row` (the last tile may be shorter). */
export function tileHeight(level: LevelMeta, row: number): number {
  return Math.min(TILE_SIZE, level.height - row * TILE_SIZE);
}
