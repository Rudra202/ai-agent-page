import type { Request } from 'express';
import type multer from 'multer';
import { HttpError } from '../middleware/errorHandler.js';
import type { Repositories } from '../repositories/types.js';
import { StorageLimitError } from '../storage/types.js';
import type { StorageProvider } from '../storage/types.js';
import { createSniffer, expectedFromName } from './fileInspection.js';

/** A file that has been checked and is now in storage. It is not yet a document: no record points at it. */
export interface StoredUpload {
  ref: string;
  size: number;
  sha256: string;
  mime: 'application/pdf' | 'image/png' | 'image/jpeg';
  ext: 'pdf' | 'png' | 'jpg';
}

/** What multer gives the route for the uploaded file. */
export type UploadedFile = Express.Multer.File & { stored: StoredUpload };

export interface UploadEngineDeps {
  repos: Repositories;
  storage: StorageProvider;
  maxBytes: number;
  maxDocuments: number;
  newId: () => string;
}

/**
 * A multer storage engine that never holds a file in memory. The upload stream goes through the content checks
 * and straight into storage (GridFS), and the file is only kept if every check passed and it arrived whole.
 *
 * The storage key is made here from the user's id and a random id. The user's file name plays no part in it.
 */
export function createUploadEngine({ repos, storage, maxBytes, maxDocuments, newId }: UploadEngineDeps): multer.StorageEngine {
  return {
    _handleFile(req: Request, file, callback) {
      void (async () => {
        const user = req.user;
        if (!user) throw new HttpError(401, 'Please sign in.');
        const expected = expectedFromName(file.originalname);
        if ((await repos.documents.countByUser(user.id)) >= maxDocuments) {
          throw new HttpError(409, `You can keep up to ${maxDocuments} documents. Remove one first.`);
        }

        const key = `${user.id}/${newId()}.${expected.ext}`;
        // Plain pipe, NOT stream.pipeline: pipeline destroys the source when the checks fail, and multer treats a
        // destroyed file stream as "this write is over" and answers the request while storage is still cleaning up.
        // Here multer's stream is only ever read, and the request is answered after storage has finished.
        const source = createSniffer(expected);
        file.stream.on('error', (error) => source.destroy(error));
        file.stream.pipe(source);
        try {
          const saved = await storage.putStream(key, source, { contentType: expected.mime, maxBytes });
          const stored: StoredUpload = { ref: saved.ref, size: saved.size, sha256: saved.sha256, mime: expected.mime, ext: expected.ext };
          callback(null, { size: saved.size, stored } as Partial<Express.Multer.File>);
        } catch (error) {
          // The sniffer's HttpError may come wrapped or direct; a size overrun is reported as "too large".
          if (error instanceof StorageLimitError) throw new HttpError(413, 'The file is too large.');
          throw error;
        }
      })().catch((error: unknown) => {
        // Make sure the rest of an unwanted upload is read and thrown away, so the request can finish.
        file.stream.resume();
        callback(error);
      });
    },

    _removeFile(_req: Request, file, callback) {
      const stored = (file as Partial<UploadedFile>).stored;
      if (!stored) return callback(null);
      storage.delete(stored.ref).then(
        () => callback(null),
        (error: unknown) => callback(error as Error),
      );
    },
  };
}
