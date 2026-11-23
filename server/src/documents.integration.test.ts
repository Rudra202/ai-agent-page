import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, documentServiceOf } from './app.js';
import { connectMongo } from './config/db.js';
import { env, resolveMongoUri } from './config/env.js';
import { createMongoRepositories } from './repositories/mongo/index.js';
import type { MongoRepositories } from './repositories/mongo/index.js';
import { createExtractionProcessor } from './extraction/pipeline.js';
import { createDocumentJobs } from './jobs/documentJobs.js';
import { seedServices } from './services/catalog.js';
import { findOrphanFiles, migrateLocalDocuments, rollbackMigration } from './migration/localToGridfs.js';
import { createGridFsStorage, GRIDFS_BUCKET } from './storage/gridfs.js';
import { createLocalStorage } from './storage/local.js';
import { blankPng, buildPdf, TRADE_LICENCE_LINES } from './test/files.js';
import { PASSWORD, pdf, png, testConfig, upload } from './test/helpers.js';

/**
 * The document API on MongoDB Atlas with files in GridFS, in a throwaway database that is dropped at the end.
 * Run with: npm run test:integration --workspace server
 */
const uri = resolveMongoUri(env);
const dbName = `tajir_test_${randomBytes(6).toString('hex')}`;
const assertTestDatabase = (name: string) => {
  if (!name.startsWith('tajir_test_')) throw new Error(`Refusing to touch database "${name}"`);
};
const email = (label: string) => `${label}-${randomBytes(4).toString('hex')}@example.com`;
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const LIMITS = { api: 100_000, login: 100_000, register: 100_000, upload: 100_000, download: 100_000 };

if (!uri) {
  describe.skip('Documents on MongoDB Atlas and GridFS (no credentials in server/.env)', () => {
    it('skipped', () => undefined);
  });
} else {
  let connection: Connection;
  let mongo: MongoRepositories;

  beforeAll(async () => {
    assertTestDatabase(dbName);
    connection = await connectMongo(uri, dbName);
    mongo = createMongoRepositories(connection);
    await mongo.ensureIndexes();
    await seedServices(mongo.repositories);
  });

  afterAll(async () => {
    if (!connection) return;
    assertTestDatabase(connection.name);
    await connection.dropDatabase();
    await connection.close();
  });

  const makeApp = (config = testConfig()) => {
    const storage = createGridFsStorage(connection);
    const app = createApp({ repos: mongo.repositories, storage, config, dbMode: 'mongodb', limits: LIMITS });
    return { app, storage };
  };
  const signUp = async (app: ReturnType<typeof makeApp>['app'], address: string) => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register').send({ name: 'Test User', email: address, password: PASSWORD, company: 'ABC Trading LLC' }).expect(201);
    return agent;
  };
  const files = () => connection.db!.collection(`${GRIDFS_BUCKET}.files`);
  const chunks = () => connection.db!.collection(`${GRIDFS_BUCKET}.chunks`);
  const binary = (res: IncomingMessage, callback: (error: Error | null, body: Buffer) => void) => {
    const parts: Buffer[] = [];
    res.on('data', (c: Buffer) => parts.push(c));
    res.on('end', () => callback(null, Buffer.concat(parts)));
  };

  describe('documents on MongoDB Atlas with GridFS', () => {
    it('stores the file in GridFS, records metadata in MongoDB, and serves the same bytes back', async () => {
      const { app } = makeApp();
      const agent = await signUp(app, email('gridfs'));
      const content = pdf('x'.repeat(700_000));
      const res = await upload(agent, { buffer: content, filename: 'Trade Licence.pdf' }, { typeId: 'trade_licence' }).expect(201);
      const doc = res.body.document;
      expect(doc).toMatchObject({ processingStatus: 'uploaded', sha256: sha(content), sizeBytes: content.length });

      // The bytes are in the GridFS bucket, and the record points at them by id; it holds no bytes itself.
      const record = (await mongo.models.Document.findById(doc.id).lean()) as { storageKey: string; storageProvider: string } | null;
      expect(record?.storageProvider).toBe('gridfs');
      expect(record?.storageKey).toMatch(/^[a-f0-9]{24}$/);
      const stored = await files().findOne({ _id: new Types.ObjectId(record!.storageKey) });
      expect(stored?.length).toBe(content.length);
      expect(stored?.metadata).toEqual({ contentType: 'application/pdf' });

      const view = await agent.get(`/api/documents/${doc.id}/view`).buffer(true).parse(binary).expect(200);
      expect(view.headers['content-type']).toBe('application/pdf');
      expect((view.body as Buffer).equals(content)).toBe(true);
      const download = await agent.get(`/api/documents/${doc.id}/download`).buffer(true).parse(binary).expect(200);
      expect(download.headers['content-disposition']).toMatch(/^attachment; filename="Trade Licence.pdf"/);
      expect(sha(download.body as Buffer)).toBe(sha(content));
    });

    it('keeps one user’s documents from another, including the file bytes', async () => {
      const { app } = makeApp();
      const alice = await signUp(app, email('alice'));
      const bob = await signUp(app, email('bob'));
      const doc = (await upload(alice, { buffer: pdf('alice only'), filename: 'a.pdf' }, { typeId: 'passport' }).expect(201)).body.document;
      for (const path of ['', '/status', '/view', '/download']) await bob.get(`/api/documents/${doc.id}${path}`).expect(404);
      await bob.delete(`/api/documents/${doc.id}`).expect(404);
      expect((await bob.get('/api/documents').expect(200)).body.documents).toEqual([]);
      await alice.get(`/api/documents/${doc.id}/view`).expect(200);
    });

    it('deletes the GridFS file and its chunks, the extraction, the job and the record', async () => {
      const { app } = makeApp();
      const agent = await signUp(app, email('delete'));
      const doc = (await upload(agent, { buffer: pdf('y'.repeat(300_000)), filename: 'd.pdf' }, { typeId: 'passport' }).expect(201)).body.document;
      const record = (await mongo.models.Document.findById(doc.id).lean()) as { userId: { toString(): string }; sha256: string };
      const userId = record.userId.toString();
      await mongo.repositories.extractions.save({ documentId: doc.id, userId, sourceSha256: record.sha256, text: 't', textLength: 1, truncated: false, method: 'pdf_text', detectedType: 'passport', confidence: 'high', structured: null, ai: { status: 'not_requested' } });
      await mongo.repositories.extractions.saveChunks(doc.id, userId, [{ text: 'chunk' }]);
      await mongo.repositories.jobs.enqueue(doc.id, userId, { maxAttempts: 3, now: new Date() });
      const filesBefore = await files().countDocuments();
      const chunksBefore = await chunks().countDocuments();
      expect(chunksBefore).toBeGreaterThan(0);

      await agent.delete(`/api/documents/${doc.id}`).expect(204);

      expect(await files().countDocuments()).toBe(filesBefore - 1);
      expect(await chunks().countDocuments()).toBeLessThan(chunksBefore);
      expect(await mongo.models.Document.countDocuments({ _id: doc.id })).toBe(0);
      expect(await mongo.models.ExtractedDocument.countDocuments({ documentId: doc.id })).toBe(0);
      expect(await mongo.models.DocumentChunk.countDocuments({ documentId: doc.id })).toBe(0);
      expect(await mongo.models.DocumentProcessingJob.countDocuments({ documentId: doc.id })).toBe(0);
      await agent.get(`/api/documents/${doc.id}/view`).expect(404);
    });

    it('leaves no GridFS file behind for refused or cut-off uploads', async () => {
      const { app } = makeApp();
      const agent = await signUp(app, email('refused'));
      const before = await files().countDocuments();
      const chunksBefore = await chunks().countDocuments();
      await upload(agent, { buffer: Buffer.from('%PDF-1.4\n' + 'q'.repeat(400_000)), filename: 'cut.pdf' }, { typeId: 'passport' }).expect(422);
      await upload(agent, { buffer: pdf('a'.repeat(400_000)), filename: 'a.pdf' }, { typeId: 'not-a-type' }).expect(422);
      await upload(agent, { buffer: pdf('/JavaScript'), filename: 'js.pdf' }, { typeId: 'passport' }).expect(422);
      expect(await files().countDocuments()).toBe(before);
      expect(await chunks().countDocuments()).toBe(chunksBefore);
    });

    it('refuses a file over the size limit and keeps nothing', async () => {
      const { app } = makeApp(testConfig({ maxUploadBytes: 300_000 }));
      const agent = await signUp(app, email('big'));
      const before = await files().countDocuments();
      const chunksBefore = await chunks().countDocuments();
      await upload(agent, { buffer: pdf('z'.repeat(900_000)), filename: 'big.pdf' }, { typeId: 'passport' }).expect(413);
      expect(await files().countDocuments()).toBe(before);
      expect(await chunks().countDocuments()).toBe(chunksBefore);
    });

    it('lists, pages and filters from MongoDB, and shows images with their detected type', async () => {
      const { app } = makeApp();
      const agent = await signUp(app, email('list'));
      for (let i = 0; i < 4; i += 1) await upload(agent, { buffer: pdf(String(i)), filename: `doc-${i}.pdf` }, { typeId: i === 3 ? 'trade_licence' : 'passport' }).expect(201);
      const image = (await upload(agent, { buffer: png(), filename: 'scan.png' }, { typeId: 'emirates_id' }).expect(201)).body.document;
      expect((await agent.get('/api/documents?pageSize=2&page=2').expect(200)).body).toMatchObject({ total: 5, page: 2 });
      expect((await agent.get('/api/documents?typeId=trade_licence').expect(200)).body.documents).toHaveLength(1);
      expect((await agent.get('/api/documents?search=DOC-2').expect(200)).body.documents).toHaveLength(1);
      expect((await agent.get('/api/documents?search=.*').expect(200)).body.documents).toHaveLength(0);
      expect((await agent.get(`/api/documents/${image.id}/view`)).headers['content-type']).toBe('image/png');
    });

    it('reads documents end to end: GridFS file, job in MongoDB, text, pieces and classification', async () => {
      const storage = createGridFsStorage(connection);
      const jobs = createDocumentJobs({
        repos: mongo.repositories,
        processor: createExtractionProcessor({ repos: mongo.repositories, storageFor: (name) => (name === 'gridfs' ? storage : undefined), ocr: null, maxBytes: 1024 * 1024 }),
        log: () => undefined,
        backoffMs: 50,
      });
      const app = createApp({ repos: mongo.repositories, storage, documentJobs: jobs, config: testConfig(), dbMode: 'mongodb', limits: LIMITS });
      const agent = await signUp(app, email('pipeline'));

      const good = (await upload(agent, { buffer: buildPdf([{ lines: TRADE_LICENCE_LINES }]), filename: 'licence.pdf' }, { typeId: 'trade_licence' }).expect(201)).body.document;
      expect(good.processingStatus).toBe('queued');
      expect(await mongo.models.DocumentProcessingJob.countDocuments({ documentId: good.id, status: 'queued' })).toBe(1);

      const bad = (await upload(agent, { buffer: blankPng(), filename: 'blank.png' }, { typeId: 'passport' }).expect(201)).body.document;
      await jobs.drain();

      const detail = (await agent.get(`/api/documents/${good.id}`).expect(200)).body.document;
      expect(detail).toMatchObject({ processingStatus: 'completed', detectedType: 'trade_licence' });
      expect(detail.extraction).toMatchObject({ method: 'pdf_text', pageCount: 1 });
      const stored = (await mongo.models.ExtractedDocument.findOne({ documentId: good.id }).lean()) as { text: string } | null;
      expect(stored?.text).toContain('Licence No: 1234567');
      expect(await mongo.models.DocumentChunk.countDocuments({ documentId: good.id })).toBeGreaterThan(0);
      expect(await mongo.models.DocumentProcessingJob.countDocuments({ documentId: good.id, status: 'completed' })).toBe(1);

      // Not readable without OCR: failed, with the reason, and nothing was stored as if it had been read.
      expect((await agent.get(`/api/documents/${bad.id}`).expect(200)).body.document).toMatchObject({ processingStatus: 'failed' });
      expect(await mongo.models.ExtractedDocument.countDocuments({ documentId: bad.id })).toBe(0);

      // Reading again reuses the same job record.
      await agent.post(`/api/documents/${good.id}/reprocess`).expect(202);
      await jobs.drain();
      expect(await mongo.models.DocumentProcessingJob.countDocuments({ documentId: good.id })).toBe(1);
      expect((await agent.get(`/api/documents/${good.id}/status`)).body.status.processingStatus).toBe('completed');
    });

    it('moves documents from local disk into GridFS for real, serves them from there, and can move them back', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'tajir-migrate-it-'));
      try {
        const local = createLocalStorage(dir);
        const gridfs = createGridFsStorage(connection);
        const app = createApp({ repos: mongo.repositories, storage: gridfs, legacyStorage: [local], config: testConfig(), dbMode: 'mongodb', limits: LIMITS });
        const agent = await signUp(app, email('migrate'));
        const me = (await agent.get('/api/auth/me').expect(200)).body.user as { id: string };

        // A document the way the old app made it: on local disk, with a record that says so.
        const content = pdf('migrate me '.repeat(40_000));
        const key = `${me.id}/11111111-2222-4333-8444-555555555555.pdf`;
        await local.put(key, content, { contentType: 'application/pdf' });
        const record = await mongo.repositories.documents.create({ userId: me.id, typeId: 'passport', originalName: 'old.pdf', mimeType: 'application/pdf', sizeBytes: content.length, sha256: sha(content), storageKey: key, storageProvider: 'local' });
        await mongo.repositories.documents.update(record.id, { processingStatus: 'completed' });

        // Before: it is served from local disk, through the legacy reader.
        const before = await agent.get(`/api/documents/${record.id}/download`).buffer(true).parse(binary).expect(200);
        expect(sha(before.body as Buffer)).toBe(sha(content));
        const filesBefore = await files().countDocuments();

        const deps = { repos: mongo.repositories, local, gridfs, log: () => undefined };
        // A dry run changes nothing.
        expect((await migrateLocalDocuments(deps)).items.map((i) => i.outcome)).toEqual(['would_migrate']);
        expect(await files().countDocuments()).toBe(filesBefore);

        const report = await migrateLocalDocuments(deps, { apply: true });
        expect(report).toMatchObject({ examined: 1, moved: 1, problems: [] });
        const moved = (await mongo.repositories.documents.findByIdForSystem(record.id))!;
        expect(moved).toMatchObject({ storageProvider: 'gridfs', previousStorage: { provider: 'local', key }, sha256: sha(content), originalName: 'old.pdf', userId: me.id });
        expect(moved.storageKey).toMatch(/^[a-f0-9]{24}$/);
        expect(await files().countDocuments()).toBe(filesBefore + 1);

        // After: the same bytes are served, now from GridFS, and the local file is still on disk.
        const after = await agent.get(`/api/documents/${record.id}/download`).buffer(true).parse(binary).expect(200);
        expect(sha(after.body as Buffer)).toBe(sha(content));
        expect((await readdir(path.join(dir, me.id))).length).toBe(1);
        expect(await findOrphanFiles({ repos: mongo.repositories, rootDir: dir })).toEqual([]);

        // Running it again does nothing.
        expect(await migrateLocalDocuments(deps, { apply: true })).toMatchObject({ examined: 0, moved: 0 });

        // Undo: back on local disk, the GridFS copy is gone, and the document still downloads.
        expect((await rollbackMigration(deps, { apply: true })).items.map((i) => i.outcome)).toEqual(['rolled_back']);
        expect(await files().countDocuments()).toBe(filesBefore);
        expect(await mongo.repositories.documents.findByIdForSystem(record.id)).toMatchObject({ storageProvider: 'local', storageKey: key });
        const again = await agent.get(`/api/documents/${record.id}/download`).buffer(true).parse(binary).expect(200);
        expect(sha(again.body as Buffer)).toBe(sha(content));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('finishes a removal that was interrupted, with the sweep', async () => {
      const { app, storage } = makeApp();
      const agent = await signUp(app, email('sweep'));
      const doc = (await upload(agent, { buffer: pdf('s'.repeat(10_000)), filename: 's.pdf' }, { typeId: 'passport' }).expect(201)).body.document;
      const userId = ((await mongo.models.Document.findById(doc.id).lean()) as { userId: { toString(): string } }).userId.toString();
      // The user's delete was recorded, but the process died before the cleanup ran.
      await mongo.repositories.documents.markDeleted(userId, doc.id);
      await agent.get(`/api/documents/${doc.id}`).expect(404);
      expect(await mongo.models.Document.countDocuments({ _id: doc.id })).toBe(1);
      const filesBefore = await files().countDocuments();

      expect(await documentServiceOf(app).sweepDeleted()).toBeGreaterThanOrEqual(1);
      expect(await mongo.models.Document.countDocuments({ _id: doc.id })).toBe(0);
      expect(await files().countDocuments()).toBe(filesBefore - 1);
      expect(storage.name).toBe('gridfs');
    });
  });
}
