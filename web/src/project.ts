// Project persistence: a single `.rasterfit.zip` containing `project.json`
// (versioned metadata) and `raster` (the imported blob), built with fflate.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { SegmentOrientation } from './calibration';
import {
  rasterToPartPoint,
  type CoordinateAffine,
  type CoordinatePoint,
  type CoordinateScale,
} from './coordinate-system';

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

export interface SavedSketchText {
  id: number;
  x: number;
  y: number;
  text: string;
  height: number;
  rotation: number;
}

export interface SavedSketchData {
  points: SavedSketchPoint[];
  lines: SavedSketchLine[];
  circles: SavedSketchCircle[];
  arcs: SavedSketchArc[];
  constraints: Record<string, unknown>[];
  texts?: SavedSketchText[];
  reference_constraints?: number[];
  /** Linear part `[a, b, c, d]` of the raster→screen affine; H/V constraints are
   *  measured in this frame (coordinate-system axes) when present. */
  frame?: [number, number, number, number];
}

/**
 * Transform a raster-space sketch (pixels, y-down) to CAD world space
 * (millimetres, y-up) for DXF/SVG export. Applies the calibration scale, the
 * y-up flip, the origin offset, and mirrors arc angles.
 *
 * Circles/arcs use `sx` for the radius (correct for isotropic scale; an
 * anisotropic scale would turn them into ellipses, which DXF cannot express).
 */
export function sketchToWorld(
  sketch: SavedSketchData,
  scale: { sx: number; sy: number },
  origin: { x: number; y: number },
): SavedSketchData {
  const sx = scale.sx > 0 ? scale.sx : 1;
  const sy = scale.sy > 0 ? scale.sy : 1;
  const tau = Math.PI * 2;
  const norm = (a: number): number => ((a % tau) + tau) % tau;
  const toWorld = (rx: number, ry: number): { x: number; y: number } => ({
    x: (rx - origin.x) * sx,
    y: (origin.y - ry) * sy,
  });
  const points = sketch.points.map((p) => {
    const w = toWorld(p.x, p.y);
    return { ...p, x: w.x, y: w.y };
  });
  const circles = sketch.circles.map((c) => ({ ...c, radius: c.radius * sx }));
  const arcs = sketch.arcs.map((a) => {
    const sweep = norm(a.end - a.start);
    // The y-up flip negates the angle; DXF/SVG arcs sweep CCW in y-up space.
    const start = norm(-a.end);
    return { ...a, radius: a.radius * sx, start, end: start + sweep };
  });
  return { ...sketch, points, circles, arcs };
}

export function sketchToPart(
  sketch: SavedSketchData,
  scale: CoordinateScale,
  origin: CoordinatePoint,
  transform: CoordinateAffine,
): SavedSketchData {
  const safeScale = { sx: scale.sx > 0 ? scale.sx : 1, sy: scale.sy > 0 ? scale.sy : 1 };
  const tau = Math.PI * 2;
  const norm = (angle: number): number => ((angle % tau) + tau) % tau;
  const toPart = (point: CoordinatePoint): CoordinatePoint =>
    rasterToPartPoint(point, origin, safeScale, transform);
  const toPartVector = (center: CoordinatePoint, vector: CoordinatePoint): CoordinatePoint => {
    const a = toPart(center);
    const b = toPart({ x: center.x + vector.x, y: center.y + vector.y });
    return { x: b.x - a.x, y: b.y - a.y };
  };
  const determinant = (transform[0] * transform[3] - transform[2] * transform[1]) * -safeScale.sx * safeScale.sy;

  const points = sketch.points.map((point) => ({ ...point, ...toPart(point) }));
  const circles = sketch.circles.map((circle) => ({ ...circle, radius: circle.radius * safeScale.sx }));
  const arcs = sketch.arcs.map((arc) => {
    const center = sketch.points.find((point) => point.id === arc.center) ?? { x: 0, y: 0 };
    const startVector = toPartVector(center, { x: Math.cos(arc.start), y: Math.sin(arc.start) });
    const endVector = toPartVector(center, { x: Math.cos(arc.end), y: Math.sin(arc.end) });
    const transformedStart = Math.atan2(startVector.y, startVector.x);
    const transformedEnd = Math.atan2(endVector.y, endVector.x);
    const start = norm(determinant < 0 ? transformedEnd : transformedStart);
    const sweep = norm(arc.end - arc.start);
    return { ...arc, radius: arc.radius * safeScale.sx, start, end: start + sweep };
  });
  const texts = sketch.texts?.map((text) => {
    const direction = toPartVector(text, { x: Math.cos(text.rotation), y: Math.sin(text.rotation) });
    return { ...text, ...toPart(text), rotation: Math.atan2(direction.y, direction.x) };
  });
  return { ...sketch, points, circles, arcs, texts };
}

export interface SavedMaskStroke {
  mode: 'include' | 'exclude';
  kind?: 'brush' | 'polygon' | 'rect';
  radius?: number;
  points: { x: number; y: number }[];
}

export interface SavedMeasurement {
  id: number;
  kind: 'distance' | 'angle';
  points: { x: number; y: number }[];
}

export interface SavedHatch {
  id: number;
  points: { x: number; y: number }[];
  spacing: number;
  angle: number;
}

export interface SavedGuide {
  id: number;
  kind: 'horizontal' | 'vertical';
  value: number;
}

export interface PageWorkspaceState {
  rasterTransform: [number, number, number, number, number, number];
  partOrigin?: { x: number; y: number };
  calibrationSegments: SavedCalibrationSegment[];
  calibrationScale?: { sx: number; sy: number; theta: number };
  sketch: SavedSketchData;
  maskStrokes: SavedMaskStroke[];
  maskEnabled?: boolean;
  measurements?: SavedMeasurement[];
  hatches?: SavedHatch[];
  guides?: SavedGuide[];
  texts?: SavedSketchText[];
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
