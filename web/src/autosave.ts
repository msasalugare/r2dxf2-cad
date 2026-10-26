// Single-session autosave: the imported raster blob lives in IndexedDB under
// `raster`, versioned metadata under `meta`. On load the app offers an explicit
// Continue/Discard choice.

import type { DocumentKind } from './import';
import {
  META_STORE,
  RASTER_STORE,
  type Kv,
} from './idb';
import type { PageWorkspaceState } from './project';

const SESSION_KEY = 'session';

export const AUTOSAVE_VERSION = 1 as const;

export interface AutosaveMeta {
  version: typeof AUTOSAVE_VERSION;
  kind: DocumentKind;
  fileName: string;
  /** 0-based active page index. */
  pageIndex: number;
  pageCount: number;
  savedAt: number;
  pages?: Record<number, PageWorkspaceState>;
}

export interface AutosaveRecord {
  blob: Blob;
  meta: AutosaveMeta;
}

export class Autosave {
  constructor(private kv: Kv) {}

  async save(blob: Blob, meta: AutosaveMeta): Promise<void> {
    await this.kv.put(META_STORE, SESSION_KEY, meta);
    await this.kv.put(RASTER_STORE, SESSION_KEY, blob);
  }

  /** Metadata only — cheap existence check for the Continue/Discard prompt. */
  async peek(): Promise<AutosaveMeta | null> {
    return (await this.kv.get<AutosaveMeta>(META_STORE, SESSION_KEY)) ?? null;
  }

  async load(): Promise<AutosaveRecord | null> {
    const meta = await this.kv.get<AutosaveMeta>(META_STORE, SESSION_KEY);
    const blob = await this.kv.get<Blob>(RASTER_STORE, SESSION_KEY);
    if (!meta || !blob) return null;
    return { blob, meta };
  }

  async clear(): Promise<void> {
    await this.kv.del(META_STORE, SESSION_KEY);
    await this.kv.del(RASTER_STORE, SESSION_KEY);
  }
}
