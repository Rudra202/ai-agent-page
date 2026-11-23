import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { measure } from './measure.js';
import type { StorageProvider } from './types.js';

export interface MemoryStorage extends StorageProvider {
  get(key: string): Buffer | undefined;
  keys(): string[];
}

/** Keeps files in memory. For tests only. */
export function createMemoryStorage(name = 'memory'): MemoryStorage {
  const files = new Map<string, { data: Buffer; contentType: string }>();

  const store: MemoryStorage = {
    name,

    async put(key, data, meta) {
      if (files.has(key)) throw new Error('Key already exists');
      files.set(key, { data: Buffer.from(data), contentType: meta.contentType });
      return key;
    },

    async putStream(key, source, meta) {
      if (files.has(key)) throw new Error('Key already exists');
      const chunks: Buffer[] = [];
      const measured = measure(meta.maxBytes);
      // Nothing is stored unless the whole stream arrived and stayed within the limit.
      await pipeline(
        source,
        measured.transform,
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            chunks.push(chunk);
            callback();
          },
        }),
      );
      files.set(key, { data: Buffer.concat(chunks), contentType: meta.contentType });
      return { ref: key, ...measured.result() };
    },

    async getStream(ref) {
      const found = files.get(ref);
      return found ? { stream: Readable.from([found.data]), size: found.data.length } : null;
    },

    async delete(ref) {
      files.delete(ref);
    },

    get: (key) => files.get(key)?.data,
    keys: () => [...files.keys()],
  };
  return store;
}
