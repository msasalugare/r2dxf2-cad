import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { unzipProject, zipProject, type ProjectData } from './project';

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

  it('rejects a zip missing the raster', () => {
    // A zip with only project.json.
    const zip = zipSync({ 'project.json': strToU8('{"version":1}') });
    expect(() => unzipProject(zip)).toThrow();
  });
});
