import { describe, expect, it } from 'vitest';
import { sniffBytes, startsWith, type SourceKind } from './sniff';

function bytes(...vals: number[]): Uint8Array {
  return Uint8Array.from(vals);
}

describe('startsWith', () => {
  it('detects a prefix', () => {
    expect(startsWith(bytes(1, 2, 3), [1, 2])).toBe(true);
    expect(startsWith(bytes(1, 2), [1, 2, 3])).toBe(false);
    expect(startsWith(bytes(1), [1, 2])).toBe(false);
  });
});

describe('sniffBytes', () => {
  const cases: Array<[number[], SourceKind]> = [
    [[0x25, 0x50, 0x44, 0x46, 0x2d], 'pdf'],
    [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image'],
    [[0xff, 0xd8, 0xff, 0xe0], 'image'],
    // RIFF....WEBP
    [[0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50], 'image'],
    [[0x00, 0x00, 0x00, 0x00], 'unsupported'],
  ];

  it.each(cases)('classifies %#', (input, expected) => {
    expect(sniffBytes(bytes(...input))).toBe(expected);
  });
});
