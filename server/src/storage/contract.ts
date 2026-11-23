import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { StorageLimitError } from './types.js';
import type { StorageProvider } from './types.js';

/** What every storage provider must do. It runs against memory, local disk and GridFS, so they cannot drift apart. */
export function storageContract(name: string, make: () => Promise<{ storage: StorageProvider; key: () => string; cleanup?: () => Promise<void> }>): void {
  const bytes = (size: number, fill = 7) => Buffer.alloc(size, fill);
  const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  const read = async (storage: StorageProvider, ref: string): Promise<Buffer | null> => {
    const found = await storage.getStream(ref);
    if (!found) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of found.stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  };

  async function withStorage(test: (ctx: { storage: StorageProvider; key: () => string }) => Promise<void>): Promise<void> {
    const ctx = await make();
    try {
      await test(ctx);
    } finally {
      await ctx.cleanup?.();
    }
  }

  describe(`storage contract: ${name}`, () => {
    it('streams a file in, measures it, and reads exactly the same bytes back', () =>
      withStorage(async ({ storage, key }) => {
        const data = Buffer.concat([Buffer.from('%PDF-1.4\n'), bytes(600_000, 1), Buffer.from('\n%%EOF')]);
        const stored = await storage.putStream(key(), Readable.from([data.subarray(0, 300_000), data.subarray(300_000)]), { contentType: 'application/pdf', maxBytes: 1_000_000 });
        expect(stored.size).toBe(data.length);
        expect(stored.sha256).toBe(sha(data));
        const found = await storage.getStream(stored.ref);
        expect(found?.size).toBe(data.length);
        expect(sha((await read(storage, stored.ref))!)).toBe(stored.sha256);
      }));

    it('stores bytes that are already in memory, and returns a reference that reads them back', () =>
      withStorage(async ({ storage, key }) => {
        const ref = await storage.put(key(), Buffer.from('hello'), { contentType: 'application/pdf' });
        expect((await read(storage, ref))?.toString()).toBe('hello');
      }));

    it('stores an empty-looking small file without trouble', () =>
      withStorage(async ({ storage, key }) => {
        const stored = await storage.putStream(key(), Readable.from([Buffer.from('x')]), { contentType: 'image/png', maxBytes: 10 });
        expect(stored.size).toBe(1);
        expect((await read(storage, stored.ref))?.toString()).toBe('x');
      }));

    it('refuses an upload that passes the limit, and keeps nothing', () =>
      withStorage(async ({ storage, key }) => {
        const k = key();
        await expect(storage.putStream(k, Readable.from([bytes(400), bytes(400)]), { contentType: 'application/pdf', maxBytes: 500 })).rejects.toBeInstanceOf(StorageLimitError);
        // The same key can be used again, so nothing half-written stayed behind.
        const stored = await storage.putStream(k, Readable.from([Buffer.from('ok')]), { contentType: 'application/pdf', maxBytes: 500 });
        expect((await read(storage, stored.ref))?.toString()).toBe('ok');
      }));

    it('keeps nothing when the source stream fails half way', () =>
      withStorage(async ({ storage, key }) => {
        const k = key();
        async function* broken() {
          yield Buffer.from('first part');
          throw new Error('connection lost');
        }
        await expect(storage.putStream(k, Readable.from(broken()), { contentType: 'application/pdf', maxBytes: 1000 })).rejects.toThrow('connection lost');
        const stored = await storage.putStream(k, Readable.from([Buffer.from('second try')]), { contentType: 'application/pdf', maxBytes: 1000 });
        expect((await read(storage, stored.ref))?.toString()).toBe('second try');
      }));

    it('returns null for a file that is missing, malformed or already deleted', () =>
      withStorage(async ({ storage, key }) => {
        expect(await storage.getStream('does-not-exist')).toBeNull();
        expect(await storage.getStream('../../etc/passwd')).toBeNull();
        expect(await storage.getStream('')).toBeNull();
        expect(await storage.getStream('0123456789abcdef01234567')).toBeNull();
        const ref = await storage.put(key(), Buffer.from('bye'), { contentType: 'application/pdf' });
        await storage.delete(ref);
        expect(await storage.getStream(ref)).toBeNull();
      }));

    it('deletes, and deleting again or deleting something unknown is not an error', () =>
      withStorage(async ({ storage, key }) => {
        const ref = await storage.put(key(), Buffer.from('bye'), { contentType: 'application/pdf' });
        await expect(storage.delete(ref)).resolves.toBeUndefined();
        await expect(storage.delete(ref)).resolves.toBeUndefined();
        await expect(storage.delete('0123456789abcdef01234567')).resolves.toBeUndefined();
      }));

    it('keeps files separate: reading one never returns another', () =>
      withStorage(async ({ storage, key }) => {
        const a = await storage.put(key(), Buffer.from('file A'), { contentType: 'application/pdf' });
        const b = await storage.put(key(), Buffer.from('file B'), { contentType: 'application/pdf' });
        expect((await read(storage, a))?.toString()).toBe('file A');
        expect((await read(storage, b))?.toString()).toBe('file B');
        await storage.delete(a);
        expect((await read(storage, b))?.toString()).toBe('file B');
      }));
  });
}
