import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { DocumentRecord } from '../domain/entities.js';
import { PermanentJobError } from '../jobs/types.js';
import { createMemoryRepositories } from '../repositories/memory.js';
import { createMemoryStorage } from '../storage/memory.js';
import { blankPng, buildPdf, renderText, scannedPdf, TRADE_LICENCE_LINES } from '../test/files.js';
import { classifyDocument } from './classify.js';
import { createOcrEngine } from './ocr.js';
import { createExtractionProcessor } from './pipeline.js';
import { chunkPages, MAX_TEXT_CHARS, meaningfulLength, normaliseText } from './text.js';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const signal = () => new AbortController().signal;

describe('cleaning text', () => {
  it('removes control characters and tidies spacing without changing words', () => {
    expect(normaliseText('Hello\u0000  \u0007World \r\n\r\n\r\n\r\nNext\t\tline  ')).toBe('Hello World\n\nNext line');
    expect(normaliseText('  a \n  b  ')).toBe('a\nb');
    expect(normaliseText('Café')).toBe('Café');
    expect(normaliseText('مرحبا بالعالم')).toBe('مرحبا بالعالم');
    expect(normaliseText('\u0000\u0001')).toBe('');
  });

  it('counts letters and digits only', () => {
    expect(meaningfulLength('--- ... ___')).toBe(0);
    expect(meaningfulLength('Ab 12 !')).toBe(4);
    expect(meaningfulLength('مرحبا')).toBe(5);
  });
});

describe('splitting text into searchable pieces', () => {
  it('keeps each piece small, remembers its page, and repeats a little across the boundary', () => {
    const paragraph = (n: number) => `Paragraph ${n}. ` + 'word '.repeat(60);
    const chunks = chunkPages([
      { page: 1, text: [1, 2, 3, 4, 5].map(paragraph).join('\n\n') },
      { page: 2, text: paragraph(6) },
    ]);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(1_000 + 200);
    expect(chunks.filter((c) => c.page === 1).length).toBeGreaterThan(1);
    expect(chunks.at(-1)?.page).toBe(2);
    // Every paragraph is somewhere in the pieces.
    for (let n = 1; n <= 6; n += 1) expect(chunks.some((c) => c.text.includes(`Paragraph ${n}.`))).toBe(true);
  });

  it('cuts a very long paragraph without losing text, and never returns an empty piece', () => {
    const text = 'Sentence number one is here. '.repeat(200);
    const chunks = chunkPages([{ page: 1, text }]);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
    expect(chunkPages([{ page: 1, text: '' }])).toEqual([]);
  });

  it('caps how many pieces one document can make', () => {
    const pages = Array.from({ length: 600 }, (_, i) => ({ page: i + 1, text: `Page ${i + 1} ` + 'text '.repeat(50) }));
    expect(chunkPages(pages).length).toBeLessThanOrEqual(400);
  });
});

describe('recognising what a document is, with no AI', () => {
  it.each([
    ['trade_licence', TRADE_LICENCE_LINES.join('\n')],
    ['passport', 'PASSPORT\nSurname: KHAN\nGiven names: ALI\nNationality: PAKISTANI\nDate of birth 01 JAN 1990\nPlace of birth LAHORE\nDate of expiry 01 JAN 2030\nP<PAKKHAN<<ALI<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<'],
    ['emirates_id', 'United Arab Emirates\nResident Identity Card\nID Number 784-1990-1234567-1\nName: Ali Khan\nNationality: Pakistan'],
    ['bank_statement', 'Account Statement\nAccount Number 0123456789\nIBAN AE070331234567890123456\nOpening balance AED 10,000\nDebit 200 Credit 5000\nClosing balance AED 14,800\nTransactions'],
    ['tenancy_contract', 'Tenancy Contract Ejari\nLandlord: A\nTenant: B\nAnnual rent AED 60,000\nSecurity deposit 3,000\nContract period 1 year'],
    ['business_plan', 'Business Plan\nExecutive Summary\nMarket Analysis\nMarketing Strategy\nFinancial Projections\nTarget market'],
  ])('recognises a %s', (type, text) => {
    const result = classifyDocument(text);
    expect(result.type).toBe(type);
    expect(result.confidence).not.toBe('low');
  });

  it('says "other" with low confidence when nothing fits, and never claims more than the words show', () => {
    expect(classifyDocument('Dear Sir, thank you for the lovely dinner last week.')).toEqual({ type: 'other', confidence: 'low' });
    expect(classifyDocument('')).toEqual({ type: 'other', confidence: 'low' });
    expect(classifyDocument('A passing mention of a passport in a letter.').confidence).toBe('low');
  });
});

// ---------------------------------------------------------------------------------------- the whole pipeline

const ocr = createOcrEngine({ size: 1 });
afterAll(async () => {
  await ocr.close();
});

async function setup(file: Buffer, options: { mime?: DocumentRecord['mimeType']; ocr?: typeof ocr | null; understand?: Parameters<typeof createExtractionProcessor>[0]['understand']; maxPages?: number } = {}) {
  const repos = createMemoryRepositories();
  const user = await repos.users.create({ name: 'A', email: 'a@example.com', passwordHash: 'x' });
  const storage = createMemoryStorage('gridfs');
  const key = `${user.id}/file`;
  await storage.put(key, file, { contentType: 'application/octet-stream' });
  const mimeType = options.mime ?? (file.subarray(0, 4).toString('latin1') === '%PDF' ? 'application/pdf' : file[0] === 0xff ? 'image/jpeg' : 'image/png');
  const doc = await repos.documents.create({ userId: user.id, typeId: 'trade_licence', originalName: 'file', mimeType, sizeBytes: file.length, sha256: sha(file), storageKey: key, storageProvider: 'gridfs' });
  const process = createExtractionProcessor({
    repos,
    storageFor: (name) => (name === 'gridfs' ? storage : undefined),
    ocr: options.ocr === undefined ? ocr : options.ocr,
    maxBytes: 5 * 1024 * 1024,
    understand: options.understand,
    maxPages: options.maxPages,
  });
  return { repos, storage, doc, user, process, run: (attempt = 1) => process(doc, { signal: signal(), attempt, maxAttempts: 3 }) };
}

describe('reading a PDF that has text', () => {
  it('extracts the text, classifies it, saves searchable pieces, and needs no OCR and no AI', async () => {
    const { repos, doc, run } = await setup(buildPdf([{ lines: TRADE_LICENCE_LINES }]), { ocr: null });
    const result = await run();
    expect(result).toMatchObject({ status: 'completed', aiStatus: 'not_requested', detectedType: 'trade_licence' });
    const saved = await repos.extractions.findByDocument(doc.userId, doc.id);
    expect(saved).toMatchObject({ method: 'pdf_text', pageCount: 1, detectedType: 'trade_licence', structured: null, ai: { status: 'not_requested' }, sourceSha256: doc.sha256 });
    expect(saved?.text).toContain('Licence No: 1234567');
    expect(saved?.text).toContain('Vinith Media FZ LLC');
    const chunks = await repos.extractions.listChunks(doc.userId, { documentIds: [doc.id], limit: 50 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]).toMatchObject({ page: 1 });
    expect(chunks.map((c) => c.text).join(' ')).toContain('Expiry Date: 31/01/2027');
  });

  it('keeps pages apart and numbers them', async () => {
    const { repos, doc, run } = await setup(buildPdf([{ lines: ['First page: alpha alpha alpha'] }, { lines: ['Second page: beta beta beta beta'] }]), { ocr: null });
    await run();
    const chunks = await repos.extractions.listChunks(doc.userId, { documentIds: [doc.id], limit: 50 });
    expect(chunks.map((c) => c.page)).toEqual([1, 2]);
    expect((await repos.extractions.findByDocument(doc.userId, doc.id))?.pageCount).toBe(2);
  });

  it('reads only up to the page limit and says so', async () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({ lines: [`Page number ${i + 1} has plenty of words in it`] }));
    const { doc, run, repos } = await setup(buildPdf(pages), { ocr: null, maxPages: 3 });
    const result = await run();
    expect(result.status).toBe('partially_completed');
    expect(result.message).toContain('first 3 of 5 pages');
    expect((await repos.extractions.listChunks(doc.userId, { limit: 50 })).map((c) => c.page)).toEqual([1, 2, 3]);
  });
});

describe('reading scans with OCR', () => {
  it('reads an image of text', async () => {
    const { repos, doc, run } = await setup(renderText(TRADE_LICENCE_LINES));
    const result = await run();
    expect(result.status).toBe('completed');
    const saved = await repos.extractions.findByDocument(doc.userId, doc.id);
    expect(saved?.method).toBe('ocr');
    expect(saved?.text.toUpperCase()).toContain('TRADE LICENCE');
    expect(saved?.text).toMatch(/1234567/);
    expect(saved?.detectedType).toBe('trade_licence');
  }, 60_000);

  it('reads a PDF that is only a picture of text (a scanned PDF)', async () => {
    const { repos, doc, run } = await setup(scannedPdf(TRADE_LICENCE_LINES));
    const result = await run();
    expect(result.status).toBe('completed');
    const saved = await repos.extractions.findByDocument(doc.userId, doc.id);
    expect(saved?.method).toBe('pdf_ocr');
    expect(saved?.text.toUpperCase()).toContain('TRADE LICENCE');
    expect(saved?.text).toMatch(/Vinith/i);
  }, 90_000);

  it('reads a PDF with both text pages and scanned pages, page by page', async () => {
    const jpeg = renderText(['Scanned page: invoice number 998877 total due'], { format: 'jpeg' });
    const pdf = buildPdf([{ lines: ['Typed page: contract reference ABC-2026-77'] }, { image: { data: jpeg, width: 1654, height: 2339 } }]);
    const { repos, doc, run } = await setup(pdf);
    await run();
    const chunks = await repos.extractions.listChunks(doc.userId, { documentIds: [doc.id], limit: 50 });
    expect(chunks.find((c) => c.page === 1)?.text).toContain('ABC-2026-77');
    expect(chunks.find((c) => c.page === 2)?.text).toMatch(/998877/);
    expect((await repos.extractions.findByDocument(doc.userId, doc.id))?.method).toBe('pdf_ocr');
  }, 90_000);

  it('says plainly that a scan cannot be read when OCR is off, and does not mark it done', async () => {
    const scanned = await setup(scannedPdf(TRADE_LICENCE_LINES), { ocr: null });
    await expect(scanned.run()).rejects.toThrow(PermanentJobError);
    await expect(scanned.run()).rejects.toThrow('OCR');
    const image = await setup(renderText(TRADE_LICENCE_LINES), { ocr: null });
    await expect(image.run()).rejects.toThrow('turned off');
    expect(await image.repos.extractions.findByDocumentForSystem(image.doc.id)).toBeNull();
  });

  it('keeps the readable pages and flags the skipped scans when OCR is off for a mixed PDF', async () => {
    const jpeg = renderText(['Scanned only'], { format: 'jpeg' });
    const { run } = await setup(buildPdf([{ lines: ['A typed page with real text that can be read directly'] }, { image: { data: jpeg, width: 1654, height: 2339 } }]), { ocr: null });
    const result = await run();
    expect(result.status).toBe('partially_completed');
    expect(result.message).toContain('turned off');
  });
});

describe('files that cannot be read are never marked as processed', () => {
  it('rejects a blank image', async () => {
    const { run, repos, doc } = await setup(blankPng());
    await expect(run()).rejects.toThrow('No readable text');
    expect(await repos.extractions.findByDocumentForSystem(doc.id)).toBeNull();
  }, 60_000);

  it('rejects a PDF with no text and no pictures', async () => {
    const { run } = await setup(buildPdf([{ lines: [] }]), { ocr: null });
    await expect(run()).rejects.toThrow('No readable text');
  });

  it('rejects a damaged PDF with a plain explanation', async () => {
    const damaged = Buffer.from('%PDF-1.4\nthis is not really a pdf at all\n%%EOF');
    const { run } = await setup(damaged, { ocr: null });
    await expect(run()).rejects.toThrow(PermanentJobError);
    await expect(run()).rejects.toThrow(/damaged|No readable text/);
  });

  it('rejects an image that cannot be decoded', async () => {
    const fakePng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not an image'), Buffer.from('IEND')]);
    const { run } = await setup(fakePng);
    await expect(run()).rejects.toThrow('could not be read');
  });

  it('rejects a file that is no longer what was uploaded (wrong hash)', async () => {
    const file = buildPdf([{ lines: TRADE_LICENCE_LINES }]);
    const { doc, storage, process } = await setup(file, { ocr: null });
    await storage.delete(doc.storageKey);
    await storage.put(doc.storageKey, buildPdf([{ lines: ['A different file entirely with other words in it'] }]), { contentType: 'application/pdf' });
    await expect(process(doc, { signal: signal(), attempt: 1, maxAttempts: 3 })).rejects.toThrow('does not match');
  });

  it('rejects a document whose file is missing', async () => {
    const { doc, storage, process } = await setup(buildPdf([{ lines: TRADE_LICENCE_LINES }]), { ocr: null });
    await storage.delete(doc.storageKey);
    await expect(process(doc, { signal: signal(), attempt: 1, maxAttempts: 3 })).rejects.toThrow('could not be found');
  });
});

describe('what happens around the AI step', () => {
  it('reports AI results without ever needing them', async () => {
    const calls: string[] = [];
    const { run } = await setup(buildPdf([{ lines: TRADE_LICENCE_LINES }]), {
      ocr: null,
      understand: async ({ detectedType, text }) => {
        calls.push(`${detectedType}:${text.length > 0}`);
        return { aiStatus: 'completed' };
      },
    });
    expect(await run()).toMatchObject({ status: 'completed', aiStatus: 'completed' });
    expect(calls).toEqual(['trade_licence:true']);
  });

  it('keeps the text and reports a partial result when the AI step fails', async () => {
    const { run, repos, doc } = await setup(buildPdf([{ lines: TRADE_LICENCE_LINES }]), {
      ocr: null,
      understand: async () => {
        throw new Error('model overloaded; secret text from the document');
      },
    });
    const result = await run();
    expect(result).toMatchObject({ status: 'partially_completed', aiStatus: 'failed' });
    expect(result.message).toContain('AI analysis could not be completed');
    expect(result.message).not.toContain('secret');
    expect((await repos.extractions.findByDocument(doc.userId, doc.id))?.text).toContain('Licence No');
  });

  it('does not read the file again when only the AI step is being retried', async () => {
    const { run, storage, doc } = await setup(buildPdf([{ lines: TRADE_LICENCE_LINES }]), { ocr: null });
    await run(1);
    // The stored file is no longer reachable, yet a retry works from the text already read.
    await storage.delete(doc.storageKey);
    expect(await run(2)).toMatchObject({ status: 'completed' });
    // A fresh run (first attempt) reads the file again, so it notices that the file is gone.
    await expect(run(1)).rejects.toThrow('could not be found');
  });

  it('never keeps more text than the limit', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `Line ${i} ${'lorem ipsum dolor sit amet '.repeat(8)}`);
    const pages = Array.from({ length: 80 }, () => ({ lines: long.slice(0, 35) }));
    const { run, repos, doc } = await setup(buildPdf(pages), { ocr: null });
    const result = await run();
    expect(result.status).toBe('partially_completed');
    const saved = await repos.extractions.findByDocument(doc.userId, doc.id);
    expect(saved!.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(saved?.truncated).toBe(true);
    expect(saved!.textLength).toBeLessThanOrEqual(MAX_TEXT_CHARS);
  }, 60_000);
});
