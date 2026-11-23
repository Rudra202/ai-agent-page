import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createDocumentJobs } from './jobs/documentJobs.js';
import { PermanentJobError } from './jobs/types.js';
import type { DocumentProcessor } from './jobs/types.js';
import { createMemoryRepositories } from './repositories/memory.js';
import { createOcrEngine } from './extraction/ocr.js';
import { createExtractionProcessor } from './extraction/pipeline.js';
import { createMemoryStorage } from './storage/memory.js';
import { blankPng, buildPdf, scannedPdf, TRADE_LICENCE_LINES } from './test/files.js';
import { createTestApp, pdf, signUp, upload } from './test/helpers.js';

async function appWithJobs(processor: DocumentProcessor) {
  const repos = createMemoryRepositories();
  const jobs = createDocumentJobs({ repos, processor, log: () => undefined, backoffMs: 100 });
  const ctx = await createTestApp({ repos, documentJobs: jobs });
  return { ...ctx, jobs };
}

const ok: DocumentProcessor = async () => ({ status: 'completed', aiStatus: 'skipped', detectedType: 'passport' });

describe('uploads are queued for processing', () => {
  it('shows "queued" straight away, and the result once the worker has run', async () => {
    const { app, jobs } = await appWithJobs(ok);
    const agent = await signUp(app, 'a@example.com');
    const res = await upload(agent, { buffer: pdf('p'), filename: 'p.pdf' }, { typeId: 'passport' }).expect(201);
    expect(res.body.document.processingStatus).toBe('queued');
    const id = res.body.document.id;
    expect((await agent.get(`/api/documents/${id}/status`)).body.status).toMatchObject({ processingStatus: 'queued', active: true });

    await jobs.drain();
    expect((await agent.get(`/api/documents/${id}/status`)).body.status).toMatchObject({ processingStatus: 'completed', detectedType: 'passport', active: false });
    expect((await agent.get('/api/documents?status=completed')).body.total).toBe(1);
  });

  it('records a failure with a message the user can read', async () => {
    const { app, jobs } = await appWithJobs(async () => {
      throw new PermanentJobError('The file is empty or has no readable text.');
    });
    const agent = await signUp(app, 'a@example.com');
    const id = (await upload(agent, { buffer: pdf('p'), filename: 'p.pdf' }, { typeId: 'passport' }).expect(201)).body.document.id;
    await jobs.drain();
    expect((await agent.get(`/api/documents/${id}`)).body.document).toMatchObject({ processingStatus: 'failed', errorMessage: 'The file is empty or has no readable text.' });
  });

  it('keeps the upload when queueing fails, and the sweep queues it later', async () => {
    const repos = createMemoryRepositories();
    const jobs = createDocumentJobs({ repos, processor: ok, log: () => undefined, stuckAfterMs: 0 });
    const realEnqueue = jobs.enqueue;
    let fail = true;
    const flaky = { ...jobs, enqueue: async (...args: Parameters<typeof realEnqueue>) => (fail ? Promise.reject(new Error('database hiccup')) : realEnqueue(...args)) };
    const { app } = await createTestApp({ repos, documentJobs: flaky });
    const agent = await signUp(app, 'a@example.com');
    const res = await upload(agent, { buffer: pdf('p'), filename: 'p.pdf' }, { typeId: 'passport' }).expect(201);
    expect(res.body.document.processingStatus).toBe('uploaded');
    fail = false;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await jobs.recover()).toBe(1);
    await jobs.drain();
    expect((await agent.get(`/api/documents/${res.body.document.id}/status`)).body.status.processingStatus).toBe('completed');
  });
});

describe('POST /api/documents/:id/reprocess', () => {
  it('reads a finished document again', async () => {
    let runs = 0;
    const { app, jobs } = await appWithJobs(async () => {
      runs += 1;
      return { status: 'completed', aiStatus: 'skipped' };
    });
    const agent = await signUp(app, 'a@example.com');
    const id = (await upload(agent, { buffer: pdf('p'), filename: 'p.pdf' }, { typeId: 'passport' }).expect(201)).body.document.id;
    await jobs.drain();

    const res = await agent.post(`/api/documents/${id}/reprocess`).expect(202);
    expect(res.body.status).toMatchObject({ id, processingStatus: 'queued', aiStatus: 'not_requested', active: true });
    await jobs.drain();
    expect(runs).toBe(2);
    expect((await agent.get(`/api/documents/${id}/status`)).body.status.processingStatus).toBe('completed');
  });

  it('retries a failed document and clears the old error', async () => {
    let fail = true;
    const { app, jobs } = await appWithJobs(async () => {
      if (fail) throw new PermanentJobError('The file is empty or has no readable text.');
      return { status: 'completed', aiStatus: 'skipped' };
    });
    const agent = await signUp(app, 'a@example.com');
    const id = (await upload(agent, { buffer: pdf('p'), filename: 'p.pdf' }, { typeId: 'passport' }).expect(201)).body.document.id;
    await jobs.drain();
    expect((await agent.get(`/api/documents/${id}/status`)).body.status.processingStatus).toBe('failed');

    fail = false;
    await agent.post(`/api/documents/${id}/reprocess`).expect(202);
    expect((await agent.get(`/api/documents/${id}`)).body.document.errorMessage).toBeNull();
    await jobs.drain();
    expect((await agent.get(`/api/documents/${id}/status`)).body.status.processingStatus).toBe('completed');
  });

  it('does not queue twice when pressed twice, or when it is already waiting', async () => {
    let runs = 0;
    const { app, jobs, repos } = await appWithJobs(async () => {
      runs += 1;
      return { status: 'completed', aiStatus: 'skipped' };
    });
    const agent = await signUp(app, 'a@example.com');
    const id = (await upload(agent, { buffer: pdf('p'), filename: 'p.pdf' }, { typeId: 'passport' }).expect(201)).body.document.id;
    // Still waiting in the queue: nothing new is made.
    await agent.post(`/api/documents/${id}/reprocess`).expect(202);
    await agent.post(`/api/documents/${id}/reprocess`).expect(202);
    await jobs.drain();
    expect(runs).toBe(1);
    await Promise.all([agent.post(`/api/documents/${id}/reprocess`), agent.post(`/api/documents/${id}/reprocess`)]);
    await jobs.drain();
    expect(runs).toBe(2);
    const record = await repos.documents.findByIdForSystem(id);
    expect((await repos.jobs.findByDocument(record!.id))?.status).toBe('completed');
  });

  it('is refused for other users’ documents, bad ids and anonymous callers', async () => {
    const { app } = await appWithJobs(ok);
    const alice = await signUp(app, 'alice@example.com');
    const bob = await signUp(app, 'bob@example.com');
    const id = (await upload(alice, { buffer: pdf('p'), filename: 'p.pdf' }, { typeId: 'passport' }).expect(201)).body.document.id;
    await bob.post(`/api/documents/${id}/reprocess`).expect(404);
    await alice.post('/api/documents/..%2Fx/reprocess').expect(404);
    await alice.post('/api/documents/0123456789abcdef01234567/reprocess').expect(404);
    await request(app).post(`/api/documents/${id}/reprocess`).expect(401);
  });

  it('says plainly when processing is not available', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const id = (await upload(agent, { buffer: pdf('p'), filename: 'p.pdf' }, { typeId: 'passport' }).expect(201)).body.document.id;
    const res = await agent.post(`/api/documents/${id}/reprocess`).expect(503);
    expect(res.body.error.message).toContain('not available');
  });

  it('is limited like uploads', async () => {
    const { app } = await createTestApp({ limits: { upload: 2 }, documentJobs: createDocumentJobs({ repos: createMemoryRepositories(), processor: ok, log: () => undefined }) });
    const agent = await signUp(app, 'a@example.com');
    const id = (await upload(agent, { buffer: pdf('p'), filename: 'p.pdf' }, { typeId: 'passport' }).expect(201)).body.document.id;
    await agent.post(`/api/documents/${id}/reprocess`).expect(202);
    await agent.post(`/api/documents/${id}/reprocess`).expect(429);
  });
});

describe('health', () => {
  it('reports how documents are being processed, without any address or secret', async () => {
    const { app } = await appWithJobs(ok);
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.queue).toEqual({ mode: 'database' });
  });
});

// ---------------------------------------------------------------------------- the whole thing, with real files

describe('uploading a real document and watching it get read', () => {
  const ocr = createOcrEngine({ size: 1 });
  afterAll(async () => {
    await ocr.close();
  });

  async function realApp() {
    const repos = createMemoryRepositories();
    const storage = createMemoryStorage();
    const jobs = createDocumentJobs({
      repos,
      processor: createExtractionProcessor({ repos, storageFor: (name) => (name === storage.name ? storage : undefined), ocr, maxBytes: 1024 * 1024 }),
      log: () => undefined,
      backoffMs: 50,
    });
    const ctx = await createTestApp({ repos, storage, documentJobs: jobs });
    return { ...ctx, jobs };
  }

  it('reads a text PDF: queued, then completed, with what was found shown on the document', async () => {
    const { app, jobs } = await realApp();
    const agent = await signUp(app, 'a@example.com');
    const res = await upload(agent, { buffer: buildPdf([{ lines: TRADE_LICENCE_LINES }]), filename: 'licence.pdf' }, { typeId: 'trade_licence' }).expect(201);
    const id = res.body.document.id;
    expect(res.body.document.processingStatus).toBe('queued');

    await jobs.drain();
    const detail = (await agent.get(`/api/documents/${id}`).expect(200)).body.document;
    expect(detail).toMatchObject({ processingStatus: 'completed', aiStatus: 'not_requested', detectedType: 'trade_licence', errorMessage: null });
    expect(detail.extraction).toMatchObject({ method: 'pdf_text', detectedType: 'trade_licence', pageCount: 1, truncated: false, structured: null });
    // The text itself is not part of the detail response.
    expect(JSON.stringify(detail)).not.toContain('1234567');
  });

  it('reads a scanned PDF with OCR', async () => {
    const { app, jobs } = await realApp();
    const agent = await signUp(app, 'a@example.com');
    const id = (await upload(agent, { buffer: scannedPdf(TRADE_LICENCE_LINES), filename: 'scan.pdf' }, { typeId: 'trade_licence' }).expect(201)).body.document.id;
    await jobs.drain();
    const detail = (await agent.get(`/api/documents/${id}`).expect(200)).body.document;
    expect(detail).toMatchObject({ processingStatus: 'completed', detectedType: 'trade_licence' });
    expect(detail.extraction.method).toBe('pdf_ocr');
  }, 90_000);

  it('marks an unreadable image as failed with a reason, and reads it after a corrected upload', async () => {
    const { app, jobs } = await realApp();
    const agent = await signUp(app, 'a@example.com');
    const id = (await upload(agent, { buffer: blankPng(), filename: 'blank.png' }, { typeId: 'passport' }).expect(201)).body.document.id;
    await jobs.drain();
    const failed = (await agent.get(`/api/documents/${id}`).expect(200)).body.document;
    expect(failed.processingStatus).toBe('failed');
    expect(failed.errorMessage).toContain('No readable text');
    expect(failed.extraction).toBeNull();
    expect((await agent.get(`/api/documents/${id}/status`)).body.status.active).toBe(false);
  }, 60_000);

  it('reads it again on request, and shows the file itself unchanged', async () => {
    const { app, jobs } = await realApp();
    const agent = await signUp(app, 'a@example.com');
    const file = buildPdf([{ lines: TRADE_LICENCE_LINES }]);
    const id = (await upload(agent, { buffer: file, filename: 'licence.pdf' }, { typeId: 'trade_licence' }).expect(201)).body.document.id;
    await jobs.drain();
    await agent.post(`/api/documents/${id}/reprocess`).expect(202);
    expect((await agent.get(`/api/documents/${id}/status`)).body.status.processingStatus).toBe('queued');
    await jobs.drain();
    expect((await agent.get(`/api/documents/${id}/status`)).body.status.processingStatus).toBe('completed');
    const download = await agent.get(`/api/documents/${id}/download`).buffer(true).parse((res, cb) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => cb(null, Buffer.concat(parts)));
    });
    expect((download.body as Buffer).equals(file)).toBe(true);
  });

  it('removes what was read when the document is deleted', async () => {
    const { app, jobs, repos } = await realApp();
    const agent = await signUp(app, 'a@example.com');
    const id = (await upload(agent, { buffer: buildPdf([{ lines: TRADE_LICENCE_LINES }]), filename: 'licence.pdf' }, { typeId: 'trade_licence' }).expect(201)).body.document.id;
    await jobs.drain();
    const userId = (await repos.documents.findByIdForSystem(id))!.userId;
    expect((await repos.extractions.listChunks(userId, { limit: 10 })).length).toBeGreaterThan(0);
    await agent.delete(`/api/documents/${id}`).expect(204);
    expect(await repos.extractions.listChunks(userId, { limit: 10 })).toEqual([]);
    expect(await repos.extractions.findByDocumentForSystem(id)).toBeNull();
    expect(await repos.jobs.findByDocument(id)).toBeNull();
  });
});
