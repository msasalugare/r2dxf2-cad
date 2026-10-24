// Import source detection from raw bytes.
//
// `File.type` is empty or wrong often enough (drag-and-drop, OS-provided
// blobs) that we sniff the magic bytes instead. RasterFit supports the raster
// formats the viewer can display (PNG/JPEG/WebP) plus PDF (via PDF.js).

export type SourceKind = 'pdf' | 'image' | 'unsupported';

/** Default import size limit, in bytes (spec: 100 MB, configurable). */
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

const PDF_SIG = [0x25, 0x50, 0x44, 0x46]; // "%PDF"
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47]; // "\x89PNG"
const JPEG_SIG = [0xff, 0xd8, 0xff];
const RIFF_SIG = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_SIG = [0x57, 0x45, 0x42, 0x50]; // "WEBP" at offset 8 in a RIFF chunk

/** True when `bytes` starts with every byte of `sig`. */
export function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) {
    if (bytes[i] !== sig[i]) return false;
  }
  return true;
}

/** Classify a byte slice by its magic number. */
export function sniffBytes(bytes: Uint8Array): SourceKind {
  if (startsWith(bytes, PDF_SIG)) return 'pdf';
  if (startsWith(bytes, PNG_SIG)) return 'image';
  if (startsWith(bytes, JPEG_SIG)) return 'image';
  if (bytes.length >= 12 && startsWith(bytes, RIFF_SIG)) {
    const webp = bytes.subarray(8, 12);
    if (startsWith(webp, WEBP_SIG)) return 'image';
  }
  return 'unsupported';
}

/** Read the first 16 bytes of a blob and classify them. */
export async function sniffBlob(blob: Blob): Promise<SourceKind> {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  return sniffBytes(head);
}
