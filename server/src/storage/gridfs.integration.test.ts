import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import mongoose from 'mongoose';
import type { Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectMongo } from '../config/db.js';
import { env, resolveMongoUri } from '../config/env.js';
import { storageContract } from './contract.js';
import { createGridFsStorage, GRIDFS_BUCKET } from './gridfs.js';

/**
 * GridFS on MongoDB Atlas, in a throwaway database that is dropped at the end.
 * Run with: npm run test:integration --workspace server
 */
const uri = resolveMongoUri(env);
const dbName = `tajir_test_${randomBytes(6).toString('hex')}`;
const assertTestDatabase = (name: string) => {
  if (!name.startsWith('tajir_test_')) throw new Error(`Refusing to touch database "${name}"`);
};

if (!uri) {
  describe.skip('GridFS on MongoDB Atlas (no credentials in server/.env)', () => {
    it('skipped', () => undefined);
  });
} else {
  let connection: Connection;

  beforeAll(async () => {
    assertTestDatabase(dbName);
    connection = await connectMongo(uri, dbName);
  });

  afterAll(async () => {
    if (!connection) return;
    assertTestDatabase(connection.name);
    await connection.dropDatabase();
    await connection.close();
  });

  // The contract needs a connection that exists when the test runs, so it is resolved lazily.
  storageContract('GridFS (Atlas)', async () => ({ storage: createGridFsStorage(connection), key: () => `owner/${randomUUID()}.pdf` }));

  describe('GridFS specifics', () => {
    it('uses the dedicated bucket and keeps the bytes out of ordinary collections', async () => {
      const storage = createGridFsStorage(connection);
      expect(storage.bucketName).toBe(GRIDFS_BUCKET);
      expect(GRIDFS_BUCKET).toBe('tajir_documents');
      const marker = randomBytes(24).toString('hex');
      const stored = await storage.putStream('owner/specific.pdf', Readable.from([Buffer.from(`%PDF-1.4 ${marker}`)]), { contentType: 'application/pdf', maxBytes: 1000 });

      const names = (await connection.db!.listCollections().toArray()).map((c) => c.name);
      expect(names).toEqual(expect.arrayContaining([`${GRIDFS_BUCKET}.files`, `${GRIDFS_BUCKET}.chunks`]));
      for (const collection of names.filter((n) => !n.startsWith(GRIDFS_BUCKET))) {
        expect(await connection.db!.collection(collection).countDocuments({ $or: [{ data: { $exists: true } }, { content: { $exists: true } }] })).toBe(0);
      }
      // The file record names the content type and size, and the reference is the file id.
      const file = await connection.db!.collection(`${GRIDFS_BUCKET}.files`).findOne({ filename: 'owner/specific.pdf' });
      expect(file?._id.toString()).toBe(stored.ref);
      expect(file?.metadata).toEqual({ contentType: 'application/pdf' });
      expect(file?.length).toBe(stored.size);
      await storage.delete(stored.ref);
    });

    it('leaves no chunks behind after a failed or oversized upload or a delete', async () => {
      const storage = createGridFsStorage(connection);
      const chunks = connection.db!.collection(`${GRIDFS_BUCKET}.chunks`);
      const before = await chunks.countDocuments();

      await expect(storage.putStream('owner/big.pdf', Readable.from([Buffer.alloc(600_000), Buffer.alloc(600_000)]), { contentType: 'application/pdf', maxBytes: 700_000 })).rejects.toThrow();
      async function* broken() {
        yield Buffer.alloc(300_000);
        throw new Error('connection lost');
      }
      await expect(storage.putStream('owner/broken.pdf', Readable.from(broken()), { contentType: 'application/pdf', maxBytes: 1_000_000 })).rejects.toThrow('connection lost');
      expect(await chunks.countDocuments()).toBe(before);

      const stored = await storage.putStream('owner/gone.pdf', Readable.from([Buffer.alloc(500_000)]), { contentType: 'application/pdf', maxBytes: 1_000_000 });
      expect(await chunks.countDocuments()).toBeGreaterThan(before);
      await storage.delete(stored.ref);
      expect(await chunks.countDocuments()).toBe(before);
      expect(await connection.db!.collection(`${GRIDFS_BUCKET}.files`).countDocuments({ filename: { $in: ['owner/big.pdf', 'owner/broken.pdf', 'owner/gone.pdf'] } })).toBe(0);
    });

    // A source that fails at its very end (as the file checks do for a cut-off PDF) right after a burst of chunk writes.
    // (The stray chunk seen earlier in the API test was not this: it was the response being sent before clean-up finished,
    // covered by "a refused upload is fully cleaned up before the answer is sent" in documents.api.test.ts.)
    it('leaves no chunks behind when the source fails right after a burst of writes', async () => {
      const storage = createGridFsStorage(connection);
      const chunks = connection.db!.collection(`${GRIDFS_BUCKET}.chunks`);
      const before = await chunks.countDocuments();
      for (let round = 0; round < 6; round += 1) {
        async function* failingAtTheEnd() {
          for (let i = 0; i < 8; i += 1) yield Buffer.alloc(260_000, i);
          throw new Error('rejected at the end');
        }
        await expect(storage.putStream(`owner/burst-${round}.pdf`, Readable.from(failingAtTheEnd()), { contentType: 'application/pdf', maxBytes: 10_000_000 })).rejects.toThrow('rejected at the end');
      }
      expect(await chunks.countDocuments()).toBe(before);
    });

    // Regression: on a slow connection, chunk writes still in flight when an upload failed landed AFTER the clean-up and stayed
    // behind for ever (one orphan chunk per failed upload). The clean-up now waits for them. Chunk writes are slowed down here,
    // so this fails every time without the fix instead of only on a slow network.
    it('leaves no chunks behind when chunk writes are slow and the upload then fails', async () => {
      const proto = mongoose.mongo.Collection.prototype as unknown as { insertOne: (...args: unknown[]) => Promise<unknown> };
      const real = proto.insertOne;
      proto.insertOne = function (this: { collectionName: string }, ...args: unknown[]) {
        if (this.collectionName === `${GRIDFS_BUCKET}.chunks`) return new Promise((resolve, reject) => setTimeout(() => real.apply(this, args).then(resolve, reject), 150));
        return real.apply(this, args);
      };
      try {
        const storage = createGridFsStorage(connection);
        const chunks = connection.db!.collection(`${GRIDFS_BUCKET}.chunks`);
        const before = await chunks.countDocuments();
        async function* failingAtTheEnd() {
          for (let i = 0; i < 8; i += 1) yield Buffer.alloc(260_000, i);
          throw new Error('rejected at the end');
        }
        await expect(storage.putStream('owner/slow.pdf', Readable.from(failingAtTheEnd()), { contentType: 'application/pdf', maxBytes: 10_000_000 })).rejects.toThrow('rejected at the end');
        // Not just right away: a late write would show up a moment later.
        for (let i = 0; i < 5; i += 1) {
          expect(await chunks.countDocuments()).toBe(before);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      } finally {
        proto.insertOne = real;
      }
    }, 60_000);

    it('streams a large file in pieces instead of holding it whole', async () => {
      const storage = createGridFsStorage(connection);
      const data = randomBytes(3_000_000);
      const stored = await storage.putStream('owner/large.pdf', Readable.from([data]), { contentType: 'application/pdf', maxBytes: 5_000_000 });
      const found = await storage.getStream(stored.ref);
      let pieces = 0;
      let total = 0;
      for await (const piece of found!.stream) {
        pieces += 1;
        total += (piece as Buffer).length;
      }
      expect(total).toBe(data.length);
      // GridFS chunks are 255 KB, so a 3 MB file arrives in many pieces.
      expect(pieces).toBeGreaterThan(5);
      await storage.delete(stored.ref);
    });
  });
}
