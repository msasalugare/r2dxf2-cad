import { beforeEach, describe, expect, it } from 'vitest';
import { SketchController } from './sketch-ui';
import type { RasterViewer } from './viewer';

function viewerMock(): RasterViewer {
  return {
    getPage: () => null,
    getOrigin: () => ({ x: 0, y: 100 }),
    rasterToScreen: (x: number, y: number) => ({ x, y }),
    snapToGrid: (x: number, y: number) => ({ x, y }),
  } as unknown as RasterViewer;
}

function controller(): SketchController {
  const sketch = new SketchController(
    viewerMock(),
    { querySelector: () => null } as unknown as HTMLElement,
    'sr',
    () => undefined,
    () => [],
  );
  (sketch as unknown as { autoConstraints: boolean }).autoConstraints = false;
  return sketch;
}

describe('sketch snapping', () => {
  beforeEach(() => {
    Object.assign(globalThis, { document: { documentElement: { dataset: {} } } });
  });

  it('disables raster snapping through the option', () => {
    const sketch = controller();
    sketch.setGrayBuffer({
      data: new Uint8Array([255, 255, 255, 255, 0, 255, 255, 255, 255]),
      width: 3,
      height: 3,
    });
    const call = (x: number, y: number) => (sketch as unknown as {
      snapInputCoord(x: number, y: number, altKey?: boolean): { x: number; y: number };
    }).snapInputCoord(x, y);

    expect(call(1, 1).x).toBeCloseTo(1.5);
    expect(call(1, 1).y).toBeCloseTo(1.5);
    (sketch as unknown as { rasterSnapEnabled: boolean }).rasterSnapEnabled = false;
    expect(call(1, 1)).toEqual({ x: 1, y: 1 });
  });

  it('prioritizes guide snapping and allows disabling it independently', () => {
    const sketch = controller();
    (sketch as unknown as { snapToGuide: () => { x: number; y: number; snapped: boolean } }).snapToGuide = () => ({
      x: 50,
      y: 60,
      snapped: true,
    });
    const call = (x: number, y: number) => (sketch as unknown as {
      snapInputCoord(x: number, y: number, altKey?: boolean): { x: number; y: number };
    }).snapInputCoord(x, y);

    expect(call(1, 1)).toEqual({ x: 50, y: 60 });
    (sketch as unknown as { guideSnapEnabled: boolean }).guideSnapEnabled = false;
    expect(call(1, 1)).toEqual({ x: 1, y: 1 });
    expect(call(1, 1)).not.toEqual({ x: 50, y: 60 });
  });
});
