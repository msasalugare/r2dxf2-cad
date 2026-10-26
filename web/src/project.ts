// Project persistence: a single `.rasterfit.zip` containing `project.json`
// (versioned metadata) and `raster` (the imported blob), built with fflate.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { SegmentOrientation } from './calibration';

export const PROJECT_VERSION = 1 as const;

export interface SavedCalibrationSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  lengthText: string;
  orientation: SegmentOrientation;
  included: boolean;
}

export interface SavedSketchPoint {
  id: number;
  x: number;
  y: number;
}

export interface SavedSketchLine {
  id: number;
  a: number;
  b: number;
  construction?: boolean;
}

export interface SavedSketchCircle {
  id: number;
  center: number;
  radius: number;
  construction?: boolean;
}

export interface SavedSketchArc {
  id: number;
  center: number;
  radius: number;
  start: number;
  end: number;
  startPt?: number;
  endPt?: number;
  construction?: boolean;
}

export interface SavedSketchData {
  points: SavedSketchPoint[];
  lines: SavedSketchLine[];
  circles: SavedSketchCircle[];
  arcs: SavedSketchArc[];
  constraints: Record<string, unknown>[];
  reference_constraints?: number[];
}

export interface SavedMaskStroke {
  mode: 'include' | 'exclude';
  kind?: 'brush' | 'polygon' | 'rect';
  radius?: number;
  points: { x: number; y: number }[];
}

export interface PageWorkspaceState {
  rasterTransform: [number, number, number, number, number, number];
  calibrationSegments: SavedCalibrationSegment[];
  calibrationScale?: { sx: number; sy: number; theta: number };
  sketch: SavedSketchData;
  maskStrokes: SavedMaskStroke[];
  maskEnabled?: boolean;
  lastFitReportJson?: string;
}

export interface ProjectData {
  version: typeof PROJECT_VERSION;
  savedAt: number;
  fileName: string;
  kind: 'image' | 'pdf' | 'sample';
  pageIndex: number;
  rasterHash?: string;
  pages?: Record<number, PageWorkspaceState>;
}

/** Deterministic FNV-1a 64-bit hex hash of a byte buffer (for raster/mask verification). */
export function hashBytes(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h1 ^= bytes[i];
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= bytes[bytes.length - 1 - i];
    h2 = Math.imul(h2, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
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
