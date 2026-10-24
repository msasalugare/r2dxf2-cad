// Project persistence: a single `.rasterfit.zip` containing `project.json`
// (versioned metadata) and `raster` (the imported blob), built with fflate.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export const PROJECT_VERSION = 1 as const;

export interface ProjectData {
  version: typeof PROJECT_VERSION;
  savedAt: number;
  fileName: string;
  kind: 'image' | 'pdf' | 'sample';
  pageIndex: number;
}

/** Build a project zip from metadata + the raw raster bytes. */
export function zipProject(data: ProjectData, rasterBytes: Uint8Array): Uint8Array {
  return zipSync({
    'project.json': strToU8(JSON.stringify(data)),
    raster: rasterBytes,
  });
}

/** Parse a project zip back into metadata + raster bytes. */
export function unzipProject(zip: Uint8Array): { data: ProjectData; raster: Uint8Array } {
  const entries = unzipSync(zip);
  const json = entries['project.json'];
  const raster = entries['raster'];
  if (!json || !raster) throw new Error('project zip is missing project.json or raster');
  const data = JSON.parse(strFromU8(json)) as ProjectData;
  return { data, raster };
}

export function bytesToBlob(bytes: Uint8Array, type: string): Blob {
  return new Blob([bytes as BlobPart], { type });
}

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
