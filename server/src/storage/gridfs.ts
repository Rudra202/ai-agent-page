import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import mongoose from 'mongoose';
import type { Connection } from 'mongoose';
import { measure } from './measure.js';
import type { StorageProvider } from './types.js';

export const GRIDFS_BUCKET = 'tajir_documents';

const { GridFSBucket, ObjectId } = mongoose.mongo;

function toObjectId(ref: string): InstanceType<typeof ObjectId> | null {
  return /^[a-f0-9]{24}$/i.test(ref) ? new ObjectId(ref) : null;
}

/**
 * Stores files in MongoDB GridFS, in a dedicated bucket, on the application's existing connection. Files are
 * written and read as streams, so no upload or download is ever held in memory as a whole. The bucket is reached
 * only through this provider and the application's authenticated routes: nothing about it is public.
 */
/**
 * Removes a failed upload completely. The driver may still have chunk writes in flight when the upload fails (more
 * so on a slow connection), and a write that lands after the first clean-up would stay behind for ever. So it stops
 * the upload, waits until nothing is in flight any more, and only then removes the chunks.
 */
async function discard(bucket: InstanceType<typeof GridFSBucket>, upload: ReturnType<InstanceType<typeof GridFSBucket>['openUploadStream']>): Promise<void> {
  await upload.abort().catch(() => undefined);
  const state = (upload as unknown as { state?: { outstandingRequests?: number } }).state;
  const giveUpAt = Date.now() + 30_000;
  while ((state?.outstandingRequests ?? 0) > 0 && Date.now() < giveUpAt) await new Promise((resolve) => setTimeout(resolve, 20));
  await bucket.delete(upload.id).catch(() => undefined);
}

export function createGridFsStorage(connection: Connection, bucketName = GRIDFS_BUCKET): StorageProvider & { readonly bucketName: string } {
  const bucket = () => {
    if (!connection.db) throw new Error('The database connection is not open');
    return new GridFSBucket(connection.db, { bucketName });
  };

  const provider: StorageProvider & { readonly bucketName: string } = {
    name: 'gridfs',
    bucketName,

    async putStream(key, source, meta) {
      const b = bucket();
      const upload = b.openUploadStream(key, { metadata: { contentType: meta.contentType } });
      const measured = measure(meta.maxBytes);
      try {
        await pipeline(source, measured.transform, upload);
      } catch (error) {
        // A half-written file must not stay behind: remove the chunks that were already written.
        await discard(b, upload);
        throw error;
      }
      return { ref: upload.id.toString(), ...measured.result() };
    },

    async put(key, data, meta) {
      const stored = await provider.putStream(key, Readable.from([data]), { contentType: meta.contentType, maxBytes: data.length });
      return stored.ref;
    },

    async getStream(ref) {
      const id = toObjectId(ref);
      if (!id) return null;
      const b = bucket();
      const [file] = await b.find({ _id: id }).limit(1).toArray();
      if (!file) return null;
      return { stream: b.openDownloadStream(id), size: file.length };
    },

    async delete(ref) {
      const id = toObjectId(ref);
      if (!id) return;
      try {
        await bucket().delete(id);
      } catch (error) {
        // Deleting something that is already gone is fine.
        if (error instanceof Error && /file not found/i.test(error.message)) return;
        throw error;
      }
    },
  };
  return provider;
}
