// PDF import via PDF.js, lazy-loaded and fully local (worker + fonts + cmaps +
// wasm are vendored assets, never fetched from a CDN).
//
// Rendering happens on the main thread to a shared-resolution OffscreenCanvas;
// the resulting ImageBitmap is handed to the raster worker, which builds the
// gray8 buffer and tile pyramid.

import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import type { PageMeta } from './raster';

/** Render dimensions are clamped so a single canvas stays within browser limits. */
const MAX_DIM = 8192;
const MAX_AREA = 64 * 1024 * 1024;

/** PDF points per inch (PDF user space is 1/72"). */
const POINTS_PER_INCH = 72;

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

/** Base URL of the vendored PDF.js runtime assets, respecting VITE_BASE. */
export function pdfAssetBase(): string {
  return `${import.meta.env.BASE_URL}pdfjs/`;
}

function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

export async function openPdfDocument(data: Uint8Array): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfjs();
  const base = pdfAssetBase();
  const task = pdfjs.getDocument({
    data,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
    // All of the above are same-origin; fetch them from the main thread (not
    // the worker) so CSP `connect-src 'self'` stays satisfied.
    useWorkerFetch: false,
    // Use the self-contained built-in font renderer so no system font fetch
    // or FontFace loading happens at runtime.
    disableFontFace: true,
  });
  return task.promise;
}

interface RenderedPage {
  bitmap: ImageBitmap;
  meta: PageMeta;
}

/** Render one PDF page to an ImageBitmap at (up to) the requested DPI. */
export async function renderPageBitmap(
  doc: PDFDocumentProxy,
  pageNumber: number,
  dpi = 600,
): Promise<RenderedPage> {
  const page: PDFPageProxy = await doc.getPage(pageNumber);
  const unscaled = page.getViewport({ scale: 1 });

  let scale = dpi / POINTS_PER_INCH;
  scale = Math.min(scale, MAX_DIM / unscaled.width, MAX_DIM / unscaled.height);
  const areaScale = Math.sqrt(MAX_AREA / (unscaled.width * unscaled.height));
  scale = Math.min(scale, areaScale);

  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));

  // pdf.js's main-thread render API expects a DOM canvas. It is not attached
  // to the document; `createImageBitmap` then hands the pixels to the raster
  // worker (which does the gray8 + pyramid work off the main thread).
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  await page.render({
    canvas,
    canvasContext: ctx,
    viewport,
    background: '#ffffff',
  }).promise;

  return {
    bitmap: await createImageBitmap(canvas),
    meta: {
      pageIndex: pageNumber - 1,
      width,
      height,
      dpi: Math.round(scale * POINTS_PER_INCH),
    },
  };
}

/** True when the error is a password-protected PDF. */
export function isPasswordError(err: unknown): boolean {
  return err instanceof Error && err.name === 'PasswordException';
}

/** True when the error is a corrupt/invalid PDF. */
export function isInvalidPdfError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'InvalidPDFException' || err.name === 'FormatError');
}
