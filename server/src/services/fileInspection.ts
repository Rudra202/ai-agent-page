import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { HttpError } from '../middleware/errorHandler.js';

export interface InspectedFile {
  mime: 'application/pdf' | 'image/png' | 'image/jpeg';
  /** Extension used for the stored key. Always one of pdf, png, jpg. */
  ext: 'pdf' | 'png' | 'jpg';
  sha256: string;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const PDF = Buffer.from('%PDF-', 'latin1');

const startsWith = (data: Buffer, signature: Buffer) => data.length >= signature.length && data.subarray(0, signature.length).equals(signature);

/** The type the bytes really are, from their signature, or null if it is not one we accept. */
export function detectType(data: Buffer): InspectedFile['mime'] | null {
  if (startsWith(data, PDF)) return 'application/pdf';
  if (startsWith(data, PNG)) return 'image/png';
  if (startsWith(data, JPEG)) return 'image/jpeg';
  return null;
}

const EXTENSION_TO_MIME: Record<string, InspectedFile['mime']> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};
const MIME_TO_EXT: Record<InspectedFile['mime'], InspectedFile['ext']> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

/**
 * Accepts a file only if its size, its extension and its real content agree.
 * A program renamed to .pdf is rejected because its bytes are not a PDF.
 */
export function inspectFile(data: Buffer, originalName: string): InspectedFile {
  if (data.length === 0) throw new HttpError(400, 'The file is empty.');

  const extension = originalName.split('.').pop()?.toLowerCase() ?? '';
  const expected = EXTENSION_TO_MIME[extension];
  if (!expected) throw new HttpError(415, 'Please upload a PDF, PNG or JPG file.');

  const actual = detectType(data);
  if (!actual) throw new HttpError(422, 'The file content is not a PDF, PNG or JPG.');
  if (actual !== expected) throw new HttpError(422, 'The file content does not match its extension.');

  return { mime: actual, ext: MIME_TO_EXT[actual], sha256: createHash('sha256').update(data).digest('hex') };
}

/** The type a file name claims, from its extension only. Throws 415 for anything we do not accept. */
export function expectedFromName(originalName: string): { mime: InspectedFile['mime']; ext: InspectedFile['ext'] } {
  const extension = originalName.split('.').pop()?.toLowerCase() ?? '';
  const mime = EXTENSION_TO_MIME[extension];
  if (!mime) throw new HttpError(415, 'Please upload a PDF, PNG or JPG file.');
  return { mime, ext: MIME_TO_EXT[mime] };
}

const SNIFF_HEAD = 16;
const SNIFF_TAIL = 2048;
/** Active content in a PDF. Best effort: it catches the plain spelling, which is what ordinary files and simple attacks use. */
const PDF_ACTIVE_TOKENS = ['/JavaScript', '/Launch'];
const PDF_CARRY = Math.max(...PDF_ACTIVE_TOKENS.map((t) => t.length)) - 1;

/**
 * Checks a file while it streams, so nothing has to be held in memory and nothing is stored for a bad file:
 *  - the first bytes must be the real signature of the type the extension claims (checked before any byte passes on),
 *  - an empty file is refused,
 *  - a PDF or PNG must end the way that type ends (a cut-off upload does not),
 *  - a PDF must not contain scripts or launch actions.
 * The bytes pass through unchanged.
 */
export function createSniffer(expected: { mime: InspectedFile['mime'] }): Transform {
  let head: Buffer[] = [];
  let headLength = 0;
  let verified = false;
  let total = 0;
  let tail: Buffer = Buffer.alloc(0);
  let carry = '';

  const verify = (first: Buffer) => {
    const actual = detectType(first);
    if (!actual) throw new HttpError(422, 'The file content is not a PDF, PNG or JPG.');
    if (actual !== expected.mime) throw new HttpError(422, 'The file content does not match its extension.');
    verified = true;
  };

  const observe = (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk]).subarray(-SNIFF_TAIL);
    if (expected.mime !== 'application/pdf') return;
    const text = carry + chunk.toString('latin1');
    if (PDF_ACTIVE_TOKENS.some((token) => text.includes(token))) {
      throw new HttpError(422, 'PDFs that contain scripts or launch actions are not accepted.');
    }
    carry = text.slice(-PDF_CARRY);
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        total += chunk.length;
        let out = chunk;
        if (!verified) {
          head.push(chunk);
          headLength += chunk.length;
          if (headLength < SNIFF_HEAD) return callback();
          out = Buffer.concat(head);
          head = [];
          verify(out);
        }
        observe(out);
        callback(null, out);
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        if (total === 0) throw new HttpError(400, 'The file is empty.');
        if (!verified) {
          const all = Buffer.concat(head);
          verify(all);
          observe(all);
          this.push(all);
        }
        if (expected.mime === 'application/pdf' && !tail.subarray(-SNIFF_TAIL).includes('%%EOF')) {
          throw new HttpError(422, 'The PDF looks incomplete or damaged.');
        }
        if (expected.mime === 'image/png' && !tail.subarray(-64).includes('IEND')) {
          throw new HttpError(422, 'The image looks incomplete or damaged.');
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

/** A display-only name: no folders, no control characters, bounded length. Never used to build a path. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'document';
  if (cleaned.length <= 100) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= 6 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, 100 - extension.length) + extension;
}
