import { describe, expect, it } from 'vitest';
import { formatDegrees, formatMm, parseLength } from './units';

describe('parseLength', () => {
  it('defaults to millimetres', () => {
    expect(parseLength('125')).toBe(125);
    expect(parseLength('12.5')).toBe(12.5);
  });

  it('converts explicit units', () => {
    expect(parseLength('12.5 cm')).toBe(125);
    expect(parseLength('4.921 in')).toBeCloseTo(124.9934, 4);
    expect(parseLength('1 m')).toBe(1000);
    expect(parseLength('2 inch')).toBe(50.8);
    expect(parseLength('25mm')).toBe(25);
  });

  it('rejects invalid input', () => {
    expect(parseLength('')).toBeNull();
    expect(parseLength('abc')).toBeNull();
    expect(parseLength('-5')).toBeNull();
    expect(parseLength('0')).toBeNull();
    expect(parseLength('12 px')).toBeNull();
  });
});

describe('formatMm / formatDegrees', () => {
  it('formats lengths and angles', () => {
    expect(formatMm(125)).toBe('125.0 mm');
    expect(formatMm(12.5)).toBe('12.50 mm');
    expect(formatMm(3.14159)).toBe('3.142 mm');
    expect(formatDegrees(Math.PI / 2)).toBe('90.000°');
  });
});
