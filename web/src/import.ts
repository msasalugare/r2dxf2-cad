// Import pipeline: the server decodes/render the raster (PDF/image) and returns
// a PNG; the browser fetches that PNG and hands it to the raster worker, which
// builds the gray8 buffer and ImageBitmap tile pyramid for display.

import type { NativeRasterSession } from './backend';
import type { PageMeta, RasterPage } from './raster';

export type ImportErrorCode = 'too-large' | 'encrypted' | 'corrupt' | 'unsupported' | 'failed';

/** A successfully imported document kind (sample = the bundled demo). */
export type DocumentKind = 'pdf' | 'image' | 'sample';

export interface ImportDocument {
  kind: DocumentKind;
  fileName: string;
  pageCount: number;
}

interface Pending {
  resolve: (page: RasterPage) => void;
  reject: (err: Error) => void;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  page?: RasterPage;
  gray?: Uint8Array;
  width?: number;
  height?: number;
  error?: string;
}

interface GrayBuffer {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Thin request/response client over the raster worker. */
class RasterWorker {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private grayPending = new Map<number, { resolve: (g: GrayBuffer) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL('./raster.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.gray !== undefined) {
        const p = this.grayPending.get(msg.id);
        if (!p) return;
        this.grayPending.delete(msg.id);
        if (msg.ok) p.resolve({ data: msg.gray, width: msg.width!, height: msg.height! });
        else p.reject(new Error(msg.error ?? 'gray buffer unavailable'));
        return;
      }
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

  getGray(pageIndex: number): Promise<GrayBuffer> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<GrayBuffer>((resolve, reject) => {
      this.grayPending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'get-gray', id, pageIndex });
    });
  }

  dispose(): void {
    this.worker.terminate();
  }
}

/** Builds display pages from server-rendered rasters and exposes gray buffers. */
export class Importer {
  private worker = new RasterWorker();

  private async build(bitmap: ImageBitmap, meta: PageMeta): Promise<RasterPage> {
    return this.worker.build(bitmap, meta);
  }

  /**
   * Build a raster page from a server-rendered image (the backend is the single
   * source of truth for raster pixels). The returned page lives in the same
   * pixel frame as the backend's cached ridges, so fits stay consistent.
   */
  async buildFromServer(session: NativeRasterSession): Promise<RasterPage> {
    const res = await fetch(session.image_url);
    if (!res.ok) throw new Error('Failed to load rendered raster');
    const bitmap = await createImageBitmap(await res.blob());
    return this.build(bitmap, {
      pageIndex: Math.max(0, session.page - 1),
      width: session.width,
      height: session.height,
      dpi: session.dpi,
    });
  }

  /** Free a page's worker-side gray8 buffer. */
  freeGray(pageIndex: number): void {
    this.worker.free(pageIndex);
  }

  /** Retrieve a page's gray8 analysis buffer (for raster snapping). */
  getGray(pageIndex: number): Promise<{ data: Uint8Array; width: number; height: number }> {
    return this.worker.getGray(pageIndex);
  }

  dispose(): void {
    this.worker.dispose();
  }
}
