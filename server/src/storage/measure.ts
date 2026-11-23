import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { StorageLimitError } from './types.js';

/**
 * A pass-through that measures what flows through it: byte count and SHA-256. It fails the stream the moment
 * the count passes `maxBytes`, so an oversized upload is cut off instead of being stored and checked afterwards.
 */
export function measure(maxBytes: number): { transform: Transform; result(): { size: number; sha256: string } } {
  const hash = createHash('sha256');
  let size = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) return callback(new StorageLimitError(maxBytes));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return { transform, result: () => ({ size, sha256: hash.copy().digest('hex') }) };
}
