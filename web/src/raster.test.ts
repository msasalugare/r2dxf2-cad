import { describe, expect, it } from 'vitest';
import { computeLevels, tileHeight, tileIndex, tileWidth } from './raster';

describe('computeLevels', () => {
  it('starts at full resolution and halves until a single tile', () => {
    const levels = computeLevels(1000, 700, 256);
    expect(levels[0]).toMatchObject({ level: 0, width: 1000, height: 700, tileCols: 4, tileRows: 3 });
    expect(levels.at(-1)!.tileCols).toBe(1);
    expect(levels.at(-1)!.tileRows).toBe(1);
    for (const l of levels) {
      expect(l.scale).toBeCloseTo(l.width / 1000, 12);
    }
  });

  it('never loses the last row/column (rounds up)', () => {
    const levels = computeLevels(1001, 513, 256);
    expect(levels[1].width).toBe(501);
    expect(levels[1].height).toBe(257);
  });

  it('handles a small image in one level', () => {
    const levels = computeLevels(128, 64, 256);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toMatchObject({ tileCols: 1, tileRows: 1 });
  });

  it('produces a level scale of 1 at the top', () => {
    expect(computeLevels(640, 480)[0].scale).toBe(1);
  });
});

describe('tile helpers', () => {
  const level = computeLevels(1000, 700, 256)[0];

  it('indexes row-major', () => {
    expect(tileIndex(level, 0, 0)).toBe(0);
    expect(tileIndex(level, 1, 0)).toBe(1);
    expect(tileIndex(level, 0, 1)).toBe(4);
  });

  it('measures edge tiles correctly', () => {
    expect(tileWidth(level, 3)).toBe(232); // 1000 - 3*256
    expect(tileWidth(level, 0)).toBe(256);
    expect(tileHeight(level, 2)).toBe(188); // 700 - 2*256
    expect(tileHeight(level, 0)).toBe(256);
  });
});
