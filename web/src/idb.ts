// Minimal promise wrapper over IndexedDB (no external dependency).
//
// Two object stores: `meta` (versioned JSON metadata) and `raster` (the
// imported blob), kept separate per the project schema.

export const DB_NAME = 'rasterfit';
export const DB_VERSION = 1;

export const META_STORE = 'meta';
export const RASTER_STORE = 'raster';

/** A small key-value interface, so autosave logic can be unit-tested without IndexedDB. */
export interface Kv {
  get<T>(store: string, key: string): Promise<T | undefined>;
  put(store: string, key: string, value: unknown): Promise<void>;
  del(store: string, key: string): Promise<void>;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      if (!db.objectStoreNames.contains(RASTER_STORE)) db.createObjectStore(RASTER_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

export class IdbStore implements Kv {
  constructor(private db: IDBDatabase) {}

  async get<T>(store: string, key: string): Promise<T | undefined> {
    return promisify(this.db.transaction(store, 'readonly').objectStore(store).get(key)) as Promise<
      T | undefined
    >;
  }

  async put(store: string, key: string, value: unknown): Promise<void> {
    await promisify(this.db.transaction(store, 'readwrite').objectStore(store).put(value, key));
  }

  async del(store: string, key: string): Promise<void> {
    await promisify(this.db.transaction(store, 'readwrite').objectStore(store).delete(key));
  }
}

/** In-memory fallback for environments without IndexedDB (or tests). */
export class MemoryKv implements Kv {
  private data = new Map<string, unknown>();

  private compositeKey(store: string, key: string): string {
    return `${store}\u0000${key}`;
  }

  async get<T>(store: string, key: string): Promise<T | undefined> {
    return this.data.get(this.compositeKey(store, key)) as T | undefined;
  }

  async put(store: string, key: string, value: unknown): Promise<void> {
    this.data.set(this.compositeKey(store, key), value);
  }

  async del(store: string, key: string): Promise<void> {
    this.data.delete(this.compositeKey(store, key));
  }
}
