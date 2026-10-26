import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { hashBytes, unzipProject, zipProject, type ProjectData } from './project';

describe('project zip', () => {
  it('round-trips metadata and raster bytes', () => {
    const data: ProjectData = {
      version: 1,
      savedAt: 1234567890,
      fileName: 'drawing.pdf',
      kind: 'pdf',
      pageIndex: 0,
    };
    const raster = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const zip = zipProject(data, raster);
    const { data: out, raster: outRaster } = unzipProject(zip);
    expect(out).toEqual(data);
    expect(Array.from(outRaster)).toEqual(Array.from(raster));
  });

  it('t7 round-trips full workspace state (transform, calibration, sketch, constraints, mask)', () => {
    const raster = new Uint8Array([10, 20, 30, 40, 50]);
    const data: ProjectData = {
      version: 1,
      savedAt: 1700000000,
      fileName: 'plan.png',
      kind: 'image',
      pageIndex: 0,
      rasterHash: hashBytes(raster),
      pages: {
        0: {
          rasterTransform: [0.999, -0.01, 0.01, 0.999, 12.5, -4.2],
          calibrationSegments: [
            {
              ax: 100,
              ay: 200,
              bx: 900,
              by: 200,
              lengthText: '80 mm',
              orientation: { type: 'horizontal' },
              included: true,
            },
          ],
          calibrationScale: { sx: 0.1, sy: 0.1, theta: 0.01 },
          sketch: {
            points: [
              { id: 1, x: 0, y: 0 },
              { id: 2, x: 80, y: 0 },
            ],
            lines: [{ id: 1, a: 1, b: 2, construction: false }],
            circles: [{ id: 10, center: 1, radius: 15, construction: false }],
            arcs: [],
            constraints: [{ Horizontal: 1 }, { Distance: [1, 2, 80] }],
            reference_constraints: [],
          },
          maskStrokes: [
            {
              mode: 'include',
              kind: 'brush',
              radius: 8,
              points: [
                { x: 100, y: 200 },
                { x: 300, y: 200 },
              ],
            },
          ],
          maskEnabled: true,
        },
      },
    };
    const zip = zipProject(data, raster);
    const { data: restored, raster: restoredRaster } = unzipProject(zip);
    expect(restored).toEqual(data);
    expect(hashBytes(restoredRaster)).toBe(data.rasterHash);
  });

  it('rejects a zip missing the raster', () => {
    // A zip with only project.json.
    const zip = zipSync({ 'project.json': strToU8('{"version":1}') });
    expect(() => unzipProject(zip)).toThrow();
  });
});
