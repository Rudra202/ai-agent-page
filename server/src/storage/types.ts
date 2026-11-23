import type { Readable } from 'node:stream';

/** A file that has been written. `ref` is what must be given back to read or delete it. */
export interface StoredFile {
  /** Opaque reference to the stored file. For disk and memory it is the key; for GridFS it is the file id. */
  ref: string;
  size: number;
  sha256: string;
}

export interface StoredStream {
  stream: Readable;
  size: number;
}

/** The upload was bigger than allowed. Nothing is kept. */
export class StorageLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super('The file is too large');
    this.name = 'StorageLimitError';
  }
}

/**
 * Where uploaded files live. The application only ever talks to this interface,
 * so GridFS, local disk or cloud storage can be swapped without touching the services.
 * Files are never reachable except through the application's own authenticated routes.
 */
export interface StorageProvider {
  readonly name: string;
  /**
   * Streams a file in without holding it in memory. The size and SHA-256 are measured on the way,
   * the upload is refused as soon as it passes `maxBytes`, and nothing is left behind if it fails.
   */
  putStream(key: string, source: Readable, meta: { contentType: string; maxBytes: number }): Promise<StoredFile>;
  /** Stores bytes that are already in memory. Never overwrites an existing key. Returns the reference. */
  put(key: string, data: Buffer, meta: { contentType: string }): Promise<string>;
  /** Streams a stored file out, or null if it does not exist (any more). */
  getStream(ref: string): Promise<StoredStream | null>;
  /** Removes the file. Succeeds if it does not exist. */
  delete(ref: string): Promise<void>;
}
