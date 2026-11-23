import { createHash } from 'node:crypto';
import { getDocumentProxy, extractText, inspectPages, renderPageAsImage } from 'unpdf';
import type { ExtractionMethod } from '../domain/documents.js';
import type { Confidence } from '../domain/documents.js';
import type { DocumentRecord } from '../domain/entities.js';
import { PermanentJobError, RetryableJobError } from '../jobs/types.js';
import type { DocumentProcessor, ProcessResult } from '../jobs/types.js';
import type { Repositories } from '../repositories/types.js';
import { detectType } from '../services/fileInspection.js';
import type { StorageProvider } from '../storage/types.js';
import { classifyDocument } from './classify.js';
import { prepareImage } from './ocr.js';
import type { OcrEngine } from './ocr.js';
import { chunkPages, MAX_TEXT_CHARS, meaningfulLength, normaliseText } from './text.js';
import type { PageText } from './text.js';

/** Less than this many letters and digits in the whole file is not "text was read". */
const MIN_MEANINGFUL_CHARS = 15;
/** A PDF page with fewer letters than this, mostly covered by an image, is treated as a scan. */
const SCANNED_PAGE_TEXT = 20;
/** A cap on one PDF image, in pixels (about 16 MP), so a tiny file cannot make the parser allocate gigabytes. */
const MAX_PDF_IMAGE_PIXELS = 16_777_216;

export interface ExtractionDeps {
  repos: Repositories;
  /** Finds the storage a document's file is in (GridFS, or local disk for older documents). */
  storageFor: (providerName: string) => StorageProvider | undefined;
  /** Null when OCR is turned off: text PDFs still work, scans and images cannot be read. */
  ocr: OcrEngine | null;
  /** Never read more than this many bytes of a stored file. */
  maxBytes: number;
  maxPages?: number;
  maxOcrPages?: number;
  /** An optional later step that asks AI to understand the text. It is never needed for extraction. */
  understand?: (input: { doc: DocumentRecord; text: string; detectedType: string; signal: AbortSignal }) => Promise<Pick<ProcessResult, 'aiStatus'> & { message?: string; detectedType?: string }>;
  log?: (message: string) => void;
}

interface Extracted {
  pages: PageText[];
  method: ExtractionMethod;
  pageCount: number;
  /** 0 to 100 average OCR confidence over the OCR'd pages, when any were. */
  ocrConfidence?: number;
  /** What could not be read, in words for the user. Makes the result "partially completed". */
  caveats: string[];
}

async function readAll(provider: StorageProvider, key: string, maxBytes: number): Promise<Buffer> {
  const found = await provider.getStream(key);
  if (!found) throw new PermanentJobError('The stored file could not be found. Please upload it again.');
  if (found.size > maxBytes) throw new PermanentJobError('The stored file is larger than this server reads.');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of found.stream) {
    const piece = Buffer.from(chunk as Buffer);
    total += piece.length;
    if (total > maxBytes) {
      found.stream.destroy();
      throw new PermanentJobError('The stored file is larger than this server reads.');
    }
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

/** The pages, cut so that together they hold no more than `max` characters. */
function capPages(pages: PageText[], max: number): PageText[] {
  const kept: PageText[] = [];
  let used = 0;
  for (const page of pages) {
    if (used >= max) break;
    const room = max - used;
    kept.push(page.text.length > room ? { page: page.page, text: page.text.slice(0, room) } : page);
    used += Math.min(page.text.length, room) + 2;
  }
  return kept;
}

const toConfidence = (ocrConfidence: number | undefined): Confidence => (ocrConfidence === undefined ? 'high' : ocrConfidence >= 80 ? 'high' : ocrConfidence >= 60 ? 'medium' : 'low');
const weakest = (a: Confidence, b: Confidence): Confidence => (a === 'low' || b === 'low' ? 'low' : a === 'medium' || b === 'medium' ? 'medium' : 'high');

/** Turns pdf.js failures into the plain statement they mean. Anything else is left to be retried. */
function pdfFailure(error: unknown): never {
  const name = error instanceof Error ? error.name : '';
  if (name === 'PasswordException') throw new PermanentJobError('This PDF is password protected, so it cannot be read. Please upload an unprotected copy.');
  if (name === 'InvalidPDFException' || name === 'FormatError' || name === 'MissingPDFException') throw new PermanentJobError('This PDF is damaged and cannot be read. Please upload it again or export a new copy.');
  throw error;
}

/**
 * Builds the processor that reads a document: from its stored file, to text, to a classification, to searchable
 * pieces. It works with no AI at all. Every failure is either permanent (the file cannot be read: it is marked
 * failed and says why) or retryable (something temporary), and a file whose text could not be read is never marked done.
 */
export function createExtractionProcessor(deps: ExtractionDeps): DocumentProcessor {
  const { repos, ocr } = deps;
  const maxPages = deps.maxPages ?? 100;
  const maxOcrPages = deps.maxOcrPages ?? 10;
  const log = deps.log ?? (() => undefined);

  async function readPdf(data: Buffer, signal: AbortSignal): Promise<Extracted> {
    let pdf;
    try {
      pdf = await getDocumentProxy(new Uint8Array(data), { maxImageSize: MAX_PDF_IMAGE_PIXELS });
    } catch (error) {
      pdfFailure(error);
    }
    const caveats: string[] = [];
    const pageCount = pdf.numPages;
    const limit = Math.min(pageCount, maxPages);
    if (pageCount > limit) caveats.push(`Only the first ${limit} of ${pageCount} pages were read.`);

    let texts: string[];
    let inspected: Awaited<ReturnType<typeof inspectPages>>['pages'];
    try {
      texts = (await extractText(pdf, { mergePages: false })).text as string[];
      inspected = (await inspectPages(pdf)).pages;
    } catch (error) {
      pdfFailure(error);
    }

    const pages: PageText[] = [];
    const scanned: number[] = [];
    for (let index = 0; index < limit; index += 1) {
      const text = normaliseText(texts[index] ?? '');
      const facts = inspected[index];
      const hasText = facts ? facts.textLength - facts.invisibleTextLength >= SCANNED_PAGE_TEXT : meaningfulLength(text) >= SCANNED_PAGE_TEXT;
      if (hasText || meaningfulLength(text) >= SCANNED_PAGE_TEXT) pages.push({ page: index + 1, text });
      else if (!facts || facts.imageCount > 0 || facts.imageCoverage > 0) scanned.push(index + 1);
      // A blank page with no image has nothing to read and is skipped.
    }

    if (scanned.length === 0) return { pages, method: 'pdf_text', pageCount, caveats };

    // Pages that are pictures of text: read them with OCR, if it is on.
    if (!ocr) {
      if (pages.length === 0) throw new PermanentJobError('This PDF is a scan and text recognition (OCR) is turned off on this server, so it cannot be read.');
      caveats.push(`${scanned.length} scanned page(s) were skipped because text recognition (OCR) is turned off.`);
      return { pages, method: 'pdf_text', pageCount, caveats };
    }

    const toRead = scanned.slice(0, maxOcrPages);
    if (scanned.length > toRead.length) caveats.push(`Only the first ${toRead.length} of ${scanned.length} scanned pages were read.`);
    const confidences: number[] = [];
    for (const pageNumber of toRead) {
      if (signal.aborted) throw new RetryableJobError('Processing took too long.');
      let image: Uint8Array | string;
      try {
        image = await renderPageAsImage(pdf, pageNumber, { canvasImport: () => import('@napi-rs/canvas'), scale: 2, format: 'png' });
      } catch {
        caveats.push(`Page ${pageNumber} could not be turned into an image to read.`);
        continue;
      }
      const result = await ocr.recognize(await prepareImage(Buffer.from(image as Uint8Array)), { signal });
      const text = normaliseText(result.text);
      if (meaningfulLength(text) > 0) {
        pages.push({ page: pageNumber, text });
        confidences.push(result.confidence);
      } else {
        caveats.push(`No text could be read on page ${pageNumber}.`);
      }
    }
    pages.sort((a, b) => a.page - b.page);
    const average = confidences.length ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length : undefined;
    return { pages, method: 'pdf_ocr', pageCount, ocrConfidence: average, caveats };
  }

  async function readImage(data: Buffer, signal: AbortSignal): Promise<Extracted> {
    if (!ocr) throw new PermanentJobError('Text recognition (OCR) is turned off on this server, so an image cannot be read.');
    const result = await ocr.recognize(await prepareImage(data), { signal });
    const text = normaliseText(result.text);
    return { pages: [{ page: 1, text }], method: 'ocr', pageCount: 1, ocrConfidence: result.confidence, caveats: [] };
  }

  return async (doc, context) => {
    const provider = deps.storageFor(doc.storageProvider);
    if (!provider) throw new PermanentJobError('The stored file could not be found. Please upload it again.');

    const existing = await repos.extractions.findByDocumentForSystem(doc.id);
    // A retry of the same job (for example after the AI step failed) keeps the text already read; a fresh run reads again.
    const reuse = existing && context.attempt > 1 && existing.sourceSha256 === doc.sha256 && meaningfulLength(existing.text) >= MIN_MEANINGFUL_CHARS ? existing : null;

    let text: string;
    let method: ExtractionMethod;
    let confidence: Confidence;
    let pageCount: number | undefined;
    let caveats: string[] = [];
    let pages: PageText[];

    if (reuse) {
      text = reuse.text;
      method = reuse.method;
      confidence = reuse.confidence;
      pageCount = reuse.pageCount;
      pages = [{ page: 1, text }];
    } else {
      const data = await readAll(provider, doc.storageKey, deps.maxBytes);
      // The bytes must be exactly what was uploaded, and still the type that was checked at upload.
      if (createHash('sha256').update(data).digest('hex') !== doc.sha256) {
        throw new PermanentJobError('The stored file does not match what was uploaded, so it was not read. Please upload it again.');
      }
      if (detectType(data) !== doc.mimeType) throw new PermanentJobError('The stored file is not the type it was uploaded as.');

      const extracted = doc.mimeType === 'application/pdf' ? await readPdf(data, context.signal) : await readImage(data, context.signal);
      pages = extracted.pages.filter((p) => p.text.length > 0);
      const joined = pages.map((p) => p.text).join('\n\n');
      if (meaningfulLength(joined) < MIN_MEANINGFUL_CHARS) {
        throw new PermanentJobError(extracted.method === 'pdf_text' ? 'No readable text was found in this PDF.' : 'No readable text was found. The scan or photo may be too blurry, dark or small.');
      }
      text = joined.length > MAX_TEXT_CHARS ? joined.slice(0, MAX_TEXT_CHARS) : joined;
      if (joined.length > MAX_TEXT_CHARS) pages = capPages(pages, MAX_TEXT_CHARS);
      method = extracted.method;
      pageCount = extracted.pageCount;
      caveats = extracted.caveats;
      if (joined.length > MAX_TEXT_CHARS) caveats.push('The text is very long, so only the first part was kept.');
      confidence = toConfidence(extracted.ocrConfidence);
      if (extracted.ocrConfidence !== undefined && extracted.ocrConfidence < 60) caveats.push('The text was hard to read, so some words may be wrong.');
    }

    const guess = classifyDocument(text);
    const overall = weakest(confidence, guess.confidence);

    if (!reuse) {
      await repos.extractions.save({
        documentId: doc.id,
        userId: doc.userId,
        sourceSha256: doc.sha256,
        text,
        textLength: text.length,
        truncated: caveats.some((c) => c.includes('very long')),
        ...(pageCount !== undefined ? { pageCount } : {}),
        method,
        detectedType: guess.type,
        confidence: overall,
        structured: null,
        ai: { status: 'not_requested' },
      });
      // Chunks come from the pages as read. If the text was cut, the chunks stop where the text does.
      await repos.extractions.saveChunks(doc.id, doc.userId, chunkPages(pages));
    }

    let aiStatus: ProcessResult['aiStatus'] = 'not_requested';
    let finalType = guess.type;
    if (deps.understand) {
      try {
        const ai = await deps.understand({ doc, text, detectedType: guess.type, signal: context.signal });
        aiStatus = ai.aiStatus;
        if (ai.detectedType) finalType = ai.detectedType;
        if (ai.message) caveats.push(ai.message);
      } catch (error) {
        // The text is read and saved; only the optional understanding failed.
        log(`[documents] the AI step failed for ${doc.id} (${error instanceof Error ? error.name : 'Error'})`);
        aiStatus = 'failed';
        caveats.push('The text was read, but the AI analysis could not be completed.');
      }
    }

    const partial = caveats.length > 0 || aiStatus === 'failed' || aiStatus === 'unavailable';
    return {
      status: partial ? 'partially_completed' : 'completed',
      aiStatus,
      detectedType: finalType,
      ...(caveats.length ? { message: caveats.join(' ') } : {}),
    };
  };
}
