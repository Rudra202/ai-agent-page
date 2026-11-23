import { createRequire } from 'node:module';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createWorker } from 'tesseract.js';
import type { Worker } from 'tesseract.js';
import { PermanentJobError } from '../jobs/types.js';
import { createSemaphore } from '../jobs/semaphore.js';

export interface OcrResult {
  text: string;
  /** 0 to 100, as reported by the OCR engine. */
  confidence: number;
}

export interface OcrEngine {
  /** Reads the text in an image (PNG or JPEG bytes). */
  recognize(image: Buffer, options?: { signal?: AbortSignal }): Promise<OcrResult>;
  /** Stops the workers. */
  close(): Promise<void>;
}

/** Images larger than this (in pixels) are refused rather than decoded, so a tiny file cannot be made to need gigabytes. */
const MAX_PIXELS = 50_000_000;
/** The longest side OCR works on. Larger photos are scaled down: it is faster and no less accurate. */
const MAX_SIDE = 3_000;
const RECOGNISE_TIMEOUT_MS = 90_000;

/** The folder with the English language data that ships with the app, so OCR never downloads anything. */
function englishDataPath(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0');
}

/** Decodes an image, refuses damaged or huge ones, and scales a large one down. Returns PNG bytes. */
export async function prepareImage(bytes: Buffer): Promise<Buffer> {
  let image;
  try {
    image = await loadImage(bytes);
  } catch {
    throw new PermanentJobError('The image could not be read. It may be damaged.');
  }
  if (image.width < 1 || image.height < 1 || image.width * image.height > MAX_PIXELS) {
    throw new PermanentJobError('The image is too large to read. Please upload a smaller scan or photo.');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  // OCR works on dark text on a light background, so a transparent PNG is put on white.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvas.toBuffer('image/png');
}

/**
 * Tesseract OCR, entirely local. A small pool of workers is created when first needed and reused, because starting
 * one takes a second or two. `size` is how many images can be read at the same time.
 */
export function createOcrEngine({ size = 1, languages = 'eng' }: { size?: number; languages?: string } = {}): OcrEngine {
  const slots = createSemaphore(size);
  const idle: Worker[] = [];
  const all = new Set<Worker>();
  let closed = false;

  async function newWorker(): Promise<Worker> {
    const worker = await createWorker(languages, 1, { langPath: englishDataPath(), gzip: true, cacheMethod: 'none', errorHandler: () => undefined });
    all.add(worker);
    return worker;
  }

  async function discard(worker: Worker): Promise<void> {
    all.delete(worker);
    await worker.terminate().catch(() => undefined);
  }

  return {
    async recognize(image, options = {}) {
      if (closed) throw new Error('OCR is shut down');
      await slots.acquire();
      let worker: Worker | undefined;
      try {
        worker = idle.pop() ?? (await newWorker());
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('OCR timed out')), RECOGNISE_TIMEOUT_MS);
        });
        const aborted = new Promise<never>((_, reject) => options.signal?.addEventListener('abort', () => reject(new Error('OCR aborted')), { once: true }));
        try {
          const { data } = await Promise.race([worker.recognize(image), timeout, aborted]);
          idle.push(worker);
          worker = undefined;
          return { text: data.text ?? '', confidence: Number.isFinite(data.confidence) ? data.confidence : 0 };
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch (error) {
        // A worker that timed out or failed may be in a bad state: do not reuse it.
        if (worker) await discard(worker);
        throw error;
      } finally {
        slots.release();
      }
    },

    async close() {
      closed = true;
      idle.length = 0;
      await Promise.all([...all].map((worker) => discard(worker)));
    },
  };
}
