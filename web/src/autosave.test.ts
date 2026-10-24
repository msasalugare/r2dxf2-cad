import { describe, expect, it } from 'vitest';
import { Autosave, type AutosaveMeta } from './autosave';
import { MemoryKv } from './idb';

function meta(pageIndex = 0): AutosaveMeta {
  return {
    version: 1,
    kind: 'pdf',
    fileName: 'drawing.pdf',
    pageIndex,
    pageCount: 3,
    savedAt: 1234567890,
  };
}

describe('Autosave', () => {
  it('saves, peeks, and loads a session', async () => {
    const store = new Autosave(new MemoryKv());
    const blob = new Blob(['hello'], { type: 'application/pdf' });

    expect(await store.peek()).toBeNull();
    await store.save(blob, meta());
    expect(await store.peek()).toEqual(meta());
    const record = await store.load();
    expect(record?.meta).toEqual(meta());
    expect(await record!.blob.text()).toBe('hello');
  });

  it('clears the session', async () => {
    const store = new Autosave(new MemoryKv());
    await store.save(new Blob(['x']), meta());
    await store.clear();
    expect(await store.peek()).toBeNull();
    expect(await store.load()).toBeNull();
  });

  it('load returns null when only metadata is missing', async () => {
    const kv = new MemoryKv();
    const store = new Autosave(kv);
    await kv.put('raster', 'session', new Blob(['x']));
    expect(await store.load()).toBeNull();
  });
});
