import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  hashBytes,
  sketchToWorld,
  unzipProject,
  zipProject,
  type ProjectData,
  type SavedSketchData,
} from './project';

describe('sketchToWorld', () => {
  it('converts raster px to world mm with y-up flip and mirrors arcs', () => {
    const sketch: SavedSketchData = {
      points: [
        { id: 1, x: 0, y: 100 }, // origin corner -> world (0, 0)
        { id: 2, x: 400, y: 100 }, // 400 px along x -> 100 mm
        { id: 3, x: 0, y: 20 }, // 80 px up (raster y-down) -> +20 mm
      ],
      lines: [{ id: 1, a: 1, b: 2, construction: false }],
      circles: [{ id: 10, center: 1, radius: 40, construction: false }],
      arcs: [
        { id: 20, center: 1, radius: 40, start: 0, end: Math.PI / 2, construction: false },
      ],
      constraints: [],
    };

    const world = sketchToWorld(sketch, { sx: 0.25, sy: 0.25 }, { x: 0, y: 100 });

    // Points: scale 0.25 mm/px + y-up flip around origin y=100.
    expect(world.points[0]).toEqual({ id: 1, x: 0, y: 0 });
    expect(world.points[1].x).toBeCloseTo(100);
    expect(world.points[1].y).toBeCloseTo(0);
    expect(world.points[2].x).toBeCloseTo(0);
    expect(world.points[2].y).toBeCloseTo(20);

    // Line length in mm: (100,0) - (0,0) = 100 mm (was 400 px).
    expect(Math.hypot(world.points[1].x - world.points[0].x, world.points[1].y - world.points[0].y)).toBeCloseTo(100);

    // Radius scaled from px to mm.
    expect(world.circles[0].radius).toBeCloseTo(10);
    expect(world.arcs[0].radius).toBeCloseTo(10);

    // Arc angle mirroring: raster CCW 0..pi/2 (y-down) becomes world CCW
    // 3pi/2..2pi (y-up) with the same sweep.
    expect(world.arcs[0].start).toBeCloseTo((3 * Math.PI) / 2);
    expect(world.arcs[0].end).toBeCloseTo(Math.PI * 2);
    expect(world.arcs[0].end - world.arcs[0].start).toBeCloseTo(Math.PI / 2);
  });
});

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
