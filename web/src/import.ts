// Import pipeline: File/Blob → decoded raster page (gray8 + tile pyramid).
//
// Raster images are decoded with `createImageBitmap` and PDFs are rendered via
// PDF.js; both hand a full-res ImageBitmap to the raster worker, which builds
// the gray8 buffer and ImageBitmap tile pyramid.

import type { PDFDocumentProxy } from 'pdfjs-dist';

import { MAX_IMPORT_BYTES, sniffBlob, type SourceKind } from './sniff';
import type { PageMeta, RasterPage } from './raster';
import { isInvalidPdfError, isPasswordError, openPdfDocument, renderPageBitmap } from './pdf';
import { createSampleRaster } from './sample';

export type ImportErrorCode = 'too-large' | 'encrypted' | 'corrupt' | 'unsupported' | 'failed';

/** A successfully imported document kind (sample = the bundled demo). */
export type DocumentKind = 'pdf' | 'image' | 'sample';

export interface ImportFailure {
  ok: false;
  code: ImportErrorCode;
}

export interface ImportDocument {
  kind: DocumentKind;
  fileName: string;
  pageCount: number;
}

export interface ImportSuccess {
  ok: true;
  doc: ImportDocument;
  page: RasterPage;
}

export type ImportResult = ImportSuccess | ImportFailure;

interface Pending {
  resolve: (page: RasterPage) => void;
  reject: (err: Error) => void;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  page?: RasterPage;
  error?: string;
}

/** Thin request/response client over the raster worker. */
class RasterWorker {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL('./raster.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.ok && msg.page) pending.resolve(msg.page);
      else pending.reject(new Error(msg.error ?? 'Raster build failed'));
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message ?? 'Raster worker error');
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    };
  }

  build(bitmap: ImageBitmap, meta: PageMeta): Promise<RasterPage> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<RasterPage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'build', id, bitmap, meta }, [bitmap]);
    });
  }

  free(pageIndex: number): void {
    this.worker.postMessage({ type: 'free', pageIndex });
  }

  dispose(): void {
    this.worker.terminate();
  }
}

/** Orchestrates import and, for PDFs, on-demand page switching. */
export class Importer {
  private worker = new RasterWorker();
  private pdfDoc: PDFDocumentProxy | null = null;

  private async build(bitmap: ImageBitmap, meta: PageMeta): Promise<RasterPage> {
    return this.worker.build(bitmap, meta);
  }

  async importFile(file: File): Promise<ImportResult> {
    if (file.size > MAX_IMPORT_BYTES) return { ok: false, code: 'too-large' };

    const kind: SourceKind = await sniffBlob(file);
    if (kind === 'unsupported') return { ok: false, code: 'unsupported' };
    if (kind === 'image') return this.importImage(file);
    return this.importPdf(file);
  }

  private async importImage(file: File): Promise<ImportResult> {
    try {
      const bitmap = await createImageBitmap(file);
      const meta: PageMeta = {
        pageIndex: 0,
        width: bitmap.width,
        height: bitmap.height,
        dpi: 0,
      };
      const page = await this.build(bitmap, meta);
      return { ok: true, doc: { kind: 'image', fileName: file.name, pageCount: 1 }, page };
    } catch {
      return { ok: false, code: 'corrupt' };
    }
  }

  private async importPdf(file: File): Promise<ImportResult> {
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const doc = await openPdfDocument(data);
      this.pdfDoc = doc;
      const page = await this.renderPdfPage(1);
      return {
        ok: true,
        doc: { kind: 'pdf', fileName: file.name, pageCount: doc.numPages },
        page,
      };
    } catch (err) {
      this.disposePdf();
      if (isPasswordError(err)) return { ok: false, code: 'encrypted' };
      if (isInvalidPdfError(err)) return { ok: false, code: 'corrupt' };
      return { ok: false, code: 'failed' };
    }
  }

  async importSample(): Promise<ImportResult> {
    try {
      const sample = createSampleRaster();
      const page = await this.build(sample.bitmap, sample.meta);
      return {
        ok: true,
        doc: { kind: 'sample', fileName: sample.name, pageCount: 1 },
        page,
      };
    } catch {
      return { ok: false, code: 'failed' };
    }
  }

  /** Render a PDF page (1-based) and build its raster pyramid. */
  async openPdfPage(pageNumber: number): Promise<RasterPage> {
    if (!this.pdfDoc) throw new Error('No PDF document open');
    return this.renderPdfPage(pageNumber);
  }

  private async renderPdfPage(pageNumber: number): Promise<RasterPage> {
    const doc = this.pdfDoc;
    if (!doc) throw new Error('No PDF document open');
    const rendered = await renderPageBitmap(doc, pageNumber);
    return this.build(rendered.bitmap, rendered.meta);
  }

  /** Free a page's worker-side gray8 buffer. */
  freeGray(pageIndex: number): void {
    this.worker.free(pageIndex);
  }

  private disposePdf(): void {
    if (this.pdfDoc) {
      void this.pdfDoc.loadingTask.destroy();
      this.pdfDoc = null;
    }
  }

  dispose(): void {
    this.disposePdf();
    this.worker.dispose();
  }
}
