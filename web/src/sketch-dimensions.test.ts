import { describe, expect, it } from 'vitest';
import type { SavedSketchData } from './project';
import {
  dimensionValueFromRaster,
  dimensionValueToRaster,
  isValidDimensionValue,
  measureDimension,
} from './sketch-dimensions';

const scale = { sx: 0.1, sy: 0.25 };

function sketch(frame?: [number, number, number, number]): SavedSketchData {
  return {
    points: [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 30, y: 40 },
      { id: 3, x: 30, y: 0 },
    ],
    lines: [
      { id: 10, a: 1, b: 2 },
      { id: 11, a: 1, b: 3 },
    ],
    circles: [{ id: 20, center: 1, radius: 40 }],
    arcs: [{ id: 30, center: 1, radius: 20, start: 0, end: Math.PI / 2 }],
    constraints: [],
    frame,
  };
}

describe('dimension unit conversion', () => {
  it('uses the horizontal and vertical calibration scales independently', () => {
    expect(dimensionValueToRaster('HorizontalDistance', 20, scale)).toBe(200);
    expect(dimensionValueToRaster('VerticalDistance', 20, scale)).toBe(80);
    expect(dimensionValueFromRaster('HorizontalDistance', 200, scale)).toBe(20);
    expect(dimensionValueFromRaster('VerticalDistance', 80, scale)).toBe(20);
  });

  it('round-trips angles in degrees and rejects invalid lengths', () => {
    expect(dimensionValueToRaster('AngleLine', 270, scale)).toBeCloseTo((3 * Math.PI) / 2);
    expect(dimensionValueFromRaster('Angle', -Math.PI / 2, scale)).toBeCloseTo(-90);
    expect(isValidDimensionValue('Distance', 0)).toBe(false);
    expect(isValidDimensionValue('Radius', Number.NaN)).toBe(false);
    expect(isValidDimensionValue('Angle', 0)).toBe(true);
  });
});

describe('dimension measurement', () => {
  it('measures current geometry in display units', () => {
    const s = sketch();
    expect(measureDimension({ Distance: [1, 2, 999] }, s, scale)).toBeCloseTo(5);
    expect(measureDimension({ HorizontalDistance: [1, 2, 999] }, s, scale)).toBeCloseTo(3);
    expect(measureDimension({ VerticalDistance: [1, 2, 999] }, s, scale)).toBeCloseTo(10);
    expect(measureDimension({ Radius: [20, 999] }, s, scale)).toBeCloseTo(4);
    expect(measureDimension({ Diameter: [20, 999] }, s, scale)).toBeCloseTo(8);
    expect(measureDimension({ ArcRadius: [30, 999] }, s, scale)).toBeCloseTo(2);
    expect(measureDimension({ Angle: [10, 11, 999] }, s, scale)).toBeCloseTo(-53.1301024, 6);
  });

  it('measures directional dimensions in the coordinate-system frame', () => {
    const theta = Math.PI / 6;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const rotated = sketch([c, s, -s, c]);
    rotated.points[1] = { id: 2, x: 10 * c, y: -10 * s };

    expect(measureDimension({ AngleLine: [10, 999] }, rotated, scale)).toBeCloseTo(0);
    expect(measureDimension({ HorizontalDistance: [1, 2, 999] }, rotated, scale)).toBeCloseTo(1);
    expect(measureDimension({ VerticalDistance: [1, 2, 999] }, rotated, scale)).toBeCloseTo(0);
  });
});
