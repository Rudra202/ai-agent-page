import { createHash } from 'node:crypto';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { documentServiceOf } from './app.js';
import { contentDisposition } from './routes/documents.js';
import { createMemoryStorage } from './storage/memory.js';
import request from 'supertest';
import { createTestApp, financeBody, jpeg, PASSWORD, pdf, png, signUp, upload } from './test/helpers.js';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function uploaded(agent: Awaited<ReturnType<typeof signUp>>, name = 'passport.pdf', content: Buffer = pdf(name), typeId = 'passport') {
  const res = await upload(agent, { buffer: content, filename: name }, { typeId }).expect(201);
  return res.body.document as { id: string; originalName: string };
}

describe('streaming upload checks', () => {
  it('rejects a PDF that was cut off (no end marker) and stores nothing', async () => {
    const { app, storage } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const cut = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n' + 'x'.repeat(3000));
    const res = await upload(agent, { buffer: cut, filename: 'cut.pdf' }, { typeId: 'passport' }).expect(422);
    expect(res.body.error.message).toBe('The PDF looks incomplete or damaged.');
    expect(storage.keys()).toEqual([]);
  });

  it('rejects a PNG that was cut off', async () => {
    const { app, storage } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const res = await upload(agent, { buffer: png().subarray(0, 40), filename: 'cut.png' }, { typeId: 'passport' }).expect(422);
    expect(res.body.error.message).toBe('The image looks incomplete or damaged.');
    expect(storage.keys()).toEqual([]);
  });

  it('rejects PDFs with scripts or launch actions, wherever they appear in the file', async () => {
    const { app, storage } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    for (const body of ['<< /S /JavaScript /JS (app.alert(1)) >>', '<< /S /Launch /F (cmd.exe) >>']) {
      await upload(agent, { buffer: pdf(body), filename: 'active.pdf' }, { typeId: 'passport' }).expect(422);
    }
    // Placed so that it straddles the boundary between two reads of the stream.
    const padded = Buffer.from(`%PDF-1.4\n${'a'.repeat(70_000)}/Java`);
    const second = Buffer.from(`Script ${'b'.repeat(10)}\n%%EOF`);
    await upload(agent, { buffer: Buffer.concat([padded, second]), filename: 'split.pdf' }, { typeId: 'passport' }).expect(422);
    expect(storage.keys()).toEqual([]);
  });

  it('keeps a valid PDF byte for byte, even a large one that arrives in many pieces', async () => {
    const { app, storage } = await createTestApp({ config: { maxUploadBytes: 5 * 1024 * 1024 } });
    const agent = await signUp(app, 'a@example.com');
    const content = pdf('z'.repeat(1_500_000));
    const doc = await uploaded(agent, 'big.pdf', content);
    expect(storage.keys()).toHaveLength(1);
    expect(sha(storage.get(storage.keys()[0]!)!)).toBe(sha(content));
    expect(doc.originalName).toBe('big.pdf');
  });

  it('leaves nothing behind when the connection drops in the middle of an upload', async () => {
    const storage = createMemoryStorage();
    let started = 0;
    const original = storage.putStream.bind(storage);
    storage.putStream = (key, source, meta) => {
      started += 1;
      return original(key, source, meta);
    };
    const { app } = await createTestApp({ storage });
    const registered = await request(app).post('/api/auth/register').send({ name: 'Test User', email: 'a@example.com', password: PASSWORD, company: 'ABC Trading LLC' }).expect(201);
    const cookies = (registered.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const server = http.createServer(app).listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const boundary = '----tajirtest';
      const head = `--${boundary}\r\nContent-Disposition: form-data; name="typeId"\r\n\r\npassport\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="half.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
      const socket = net.connect(port, '127.0.0.1');
      socket.write(
        `POST /api/documents/upload HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookies}\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: 100000\r\nConnection: close\r\n\r\n${head}%PDF-1.4\n${'x'.repeat(20_000)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      socket.destroy();
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      server.close();
    }
    // The upload really began (so this is not passing because nothing ever reached storage), and nothing was kept.
    expect(started).toBe(1);
    expect(storage.keys()).toEqual([]);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: 'a@example.com', password: PASSWORD }).expect(200);
    expect((await agent.get('/api/documents').expect(200)).body.documents).toEqual([]);
  });

  it('removes the stored file when the form fields turn out to be invalid', async () => {
    const { app, storage } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    await upload(agent, { buffer: pdf(), filename: 'a.pdf' }, { typeId: 'selfie' }).expect(422);
    await upload(agent, { buffer: pdf(), filename: 'a.pdf' }, { typeId: 'passport', role: 'admin' }).expect(400);
    expect(storage.keys()).toEqual([]);
  });

  it('accepts the business plan and other types', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    await uploaded(agent, 'plan.pdf', pdf('plan'), 'business_plan');
    await uploaded(agent, 'misc.pdf', pdf('misc'), 'other');
  });

  it('starts every document as uploaded, hands it to processing, and survives a failure in that hand-over', async () => {
    const seen: string[] = [];
    const { app, repos } = await createTestApp({
      onDocumentUploaded: async (doc) => {
        seen.push(doc.processingStatus);
        if (seen.length === 2) throw new Error('queue is down');
      },
    });
    const agent = await signUp(app, 'a@example.com');
    const first = await upload(agent, { buffer: pdf('1'), filename: 'a.pdf' }, { typeId: 'passport' }).expect(201);
    const second = await upload(agent, { buffer: pdf('2'), filename: 'b.pdf' }, { typeId: 'passport' }).expect(201);
    expect(seen).toEqual(['uploaded', 'uploaded']);
    expect(first.body.document).toMatchObject({ processingStatus: 'uploaded', aiStatus: 'not_requested', detectedType: null, errorMessage: null, retryCount: 0, processedAt: null });
    // The second upload is kept even though the hand-over failed.
    expect(await repos.documents.findByIdForSystem(second.body.document.id)).not.toBeNull();
  });

  it('ties a document to the business profile of its application', async () => {
    const { app, repos } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const created = (await agent.post('/api/applications').send(financeBody()).expect(201)).body.application;
    const res = await upload(agent, { buffer: pdf('s'), filename: 's.pdf' }, { typeId: 'bank_statement_6m', applicationId: created.id, requirementId: 'req-bank_statement_6m' }).expect(201);
    const record = await repos.documents.findByIdForSystem(res.body.document.id);
    const application = (await repos.applications.listByUser(record!.userId))[0]!;
    expect(record?.businessProfileId).toBe(application.businessProfileId);
  });
});

// Regression: the response for a refused upload used to be sent while the storage was still cleaning up after it,
// because the upload engine let a failed pipeline destroy multer's file stream, and multer took that as "the write is over".
describe('a refused upload is fully cleaned up before the answer is sent', () => {
  async function slowCleanupStorage() {
    const storage = createMemoryStorage();
    const state = { cleaned: 0, started: 0 };
    const original = storage.putStream.bind(storage);
    storage.putStream = async (key, source, meta) => {
      state.started += 1;
      try {
        return await original(key, source, meta);
      } catch (error) {
        // Like GridFS removing a half-written file: it takes a moment, and it must finish before the answer goes out.
        await new Promise((resolve) => setTimeout(resolve, 120));
        state.cleaned += 1;
        throw error;
      }
    };
    return { storage, state };
  }

  it('for a file over the size limit', async () => {
    const { storage, state } = await slowCleanupStorage();
    const { app } = await createTestApp({ storage, config: { maxUploadBytes: 2048 } });
    const agent = await signUp(app, 'a@example.com');
    await upload(agent, { buffer: pdf('x'.repeat(200_000)), filename: 'big.pdf' }, { typeId: 'passport' }).expect(413);
    expect(state.started).toBe(1);
    expect(state.cleaned).toBe(1);
  });

  it('for a file that fails the content checks half way', async () => {
    const { storage, state } = await slowCleanupStorage();
    const { app } = await createTestApp({ storage, config: { maxUploadBytes: 5 * 1024 * 1024 } });
    const agent = await signUp(app, 'a@example.com');
    await upload(agent, { buffer: pdf('x'.repeat(300_000) + ' /JavaScript '), filename: 'js.pdf' }, { typeId: 'passport' }).expect(422);
    expect(state.started).toBe(1);
    expect(state.cleaned).toBe(1);
  });
});

describe('listing documents', () => {
  it('pages, filters and searches, and reports the total', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    for (let i = 0; i < 5; i += 1) await uploaded(agent, `file-${i}.pdf`, pdf(String(i)), i === 4 ? 'trade_licence' : 'passport');

    const page = (await agent.get('/api/documents?page=2&pageSize=2').expect(200)).body;
    expect(page).toMatchObject({ total: 5, page: 2, pageSize: 2 });
    expect(page.documents.map((d: { originalName: string }) => d.originalName)).toEqual(['file-2.pdf', 'file-1.pdf']);

    expect((await agent.get('/api/documents?typeId=trade_licence').expect(200)).body.documents).toHaveLength(1);
    expect((await agent.get('/api/documents?search=FILE-3').expect(200)).body.documents).toHaveLength(1);
    expect((await agent.get('/api/documents?status=completed').expect(200)).body.total).toBe(0);
    expect((await agent.get('/api/documents?status=uploaded').expect(200)).body.total).toBe(5);
    // With no query it returns everything, as before.
    expect((await agent.get('/api/documents').expect(200)).body.documents).toHaveLength(5);
  });

  it('refuses unknown or out-of-range query values', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    for (const q of ['pageSize=1000', 'pageSize=0', 'page=0', 'page=abc', 'status=hacked', 'userId=1', 'search=', 'applicationId=../x']) {
      await agent.get(`/api/documents?${q}`).expect(400);
    }
  });

  it('filters by application reference, and shows nothing for a reference that is not the user’s', async () => {
    const { app } = await createTestApp();
    const alice = await signUp(app, 'alice@example.com');
    const bob = await signUp(app, 'bob@example.com');
    const created = (await alice.post('/api/applications').send(financeBody()).expect(201)).body.application;
    await upload(alice, { buffer: pdf('s'), filename: 's.pdf' }, { typeId: 'bank_statement_6m', applicationId: created.id, requirementId: 'req-bank_statement_6m' }).expect(201);
    await uploaded(alice);
    expect((await alice.get(`/api/documents?applicationId=${created.id}`).expect(200)).body.documents).toHaveLength(1);
    expect((await bob.get(`/api/documents?applicationId=${created.id}`).expect(200)).body.documents).toEqual([]);
  });
});

describe('reading one document', () => {
  it('returns details and status for the owner', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const doc = await uploaded(agent);
    const detail = (await agent.get(`/api/documents/${doc.id}`).expect(200)).body.document;
    expect(detail).toMatchObject({ id: doc.id, originalName: 'passport.pdf', processingStatus: 'uploaded', extraction: null });
    expect(JSON.stringify(detail)).not.toMatch(/storageKey|storageProvider/);
    const status = (await agent.get(`/api/documents/${doc.id}/status`).expect(200)).body.status;
    expect(status).toMatchObject({ id: doc.id, processingStatus: 'uploaded', aiStatus: 'not_requested', active: true });
  });

  it('shows what was read from the document once it has been', async () => {
    const { app, repos } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const doc = await uploaded(agent);
    const record = (await repos.documents.findByIdForSystem(doc.id))!;
    await repos.extractions.save({
      documentId: doc.id,
      userId: record.userId,
      sourceSha256: record.sha256,
      text: 'SECRET FULL TEXT',
      textLength: 16,
      truncated: false,
      pageCount: 1,
      method: 'pdf_text',
      detectedType: 'passport',
      confidence: 'high',
      structured: { fullName: 'A B' },
      ai: { status: 'completed', provider: 'gemini', model: 'm' },
    });
    await repos.documents.update(doc.id, { processingStatus: 'completed', detectedType: 'passport' });
    const detail = (await agent.get(`/api/documents/${doc.id}`).expect(200)).body.document;
    expect(detail.extraction).toMatchObject({ method: 'pdf_text', confidence: 'high', structured: { fullName: 'A B' }, ai: { status: 'completed', provider: 'gemini' } });
    expect(JSON.stringify(detail)).not.toContain('SECRET FULL TEXT');
    expect((await agent.get(`/api/documents/${doc.id}/status`)).body.status.active).toBe(false);
  });

  it('is never cached', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const doc = await uploaded(agent);
    for (const url of ['/api/documents', `/api/documents/${doc.id}`, `/api/documents/${doc.id}/status`, `/api/documents/${doc.id}/view`, `/api/documents/${doc.id}/download`]) {
      const res = await agent.get(url).expect(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
    }
  });
});

describe('viewing and downloading', () => {
  it('previews inline and downloads as an attachment, with the real bytes and safe headers', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const content = pdf('the real content');
    const doc = await uploaded(agent, 'My Passport.pdf', content);

    const view = await agent.get(`/api/documents/${doc.id}/view`).buffer(true).parse(binary).expect(200);
    expect(view.headers['content-type']).toBe('application/pdf');
    expect(view.headers['content-disposition']).toMatch(/^inline; filename="My Passport.pdf"/);
    expect(view.headers['x-content-type-options']).toBe('nosniff');
    expect(view.headers['content-security-policy']).toContain("default-src 'none'");
    expect(view.headers['content-length']).toBe(String(content.length));
    expect((view.body as Buffer).equals(content)).toBe(true);

    const download = await agent.get(`/api/documents/${doc.id}/download`).buffer(true).parse(binary).expect(200);
    expect(download.headers['content-disposition']).toMatch(/^attachment; filename="My Passport.pdf"/);
    expect((download.body as Buffer).equals(content)).toBe(true);
  });

  it('serves images with the type that was detected from their bytes', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const a = (await upload(agent, { buffer: png(), filename: 'scan.PNG' }, { typeId: 'emirates_id' }).expect(201)).body.document;
    const b = (await upload(agent, { buffer: jpeg(), filename: 'photo.jpeg' }, { typeId: 'proof_of_address' }).expect(201)).body.document;
    expect((await agent.get(`/api/documents/${a.id}/view`)).headers['content-type']).toBe('image/png');
    expect((await agent.get(`/api/documents/${b.id}/view`)).headers['content-type']).toBe('image/jpeg');
  });

  it('cannot be tricked by a file name with quotes, line breaks or non-ASCII characters', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const doc = await uploaded(agent, 'Rapport “été” \r\nSet-Cookie: x=1.pdf', pdf('n'));
    const res = await agent.get(`/api/documents/${doc.id}/download`).expect(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(res.headers['content-disposition']).not.toMatch(/[\r\n]/);
  });

  it('builds a safe Content-Disposition for any name', () => {
    expect(contentDisposition('attachment', 'a"b;c%d.pdf')).toBe('attachment; filename="a_b_c_d.pdf"; filename*=UTF-8\'\'a%22b%3Bc%25d.pdf');
    expect(contentDisposition('inline', 'été.pdf')).toBe("inline; filename=\"_t_.pdf\"; filename*=UTF-8''%C3%A9t%C3%A9.pdf");
    expect(contentDisposition('inline', "it's (1).pdf")).toContain("%27s%20%281%29.pdf");
    expect(contentDisposition('inline', '')).toContain('filename="document"');
  });

  it('answers 404 with nothing revealed when the stored file is missing', async () => {
    const { app, storage } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const doc = await uploaded(agent);
    await storage.delete(storage.keys()[0]!);
    const res = await agent.get(`/api/documents/${doc.id}/view`).expect(404);
    expect(res.body.error.message).toBe('The file for this document is not available.');
    // The record is still there, so the user can see it and delete it.
    await agent.get(`/api/documents/${doc.id}`).expect(200);
    await agent.delete(`/api/documents/${doc.id}`).expect(204);
  });

  it('reads documents that were uploaded to the old local storage', async () => {
    const legacy = createMemoryStorage('local');
    const { app, repos } = await createTestApp({ legacyStorage: [legacy] });
    const agent = await signUp(app, 'a@example.com');
    const me = (await agent.get('/api/auth/me').expect(200)).body.user;
    const content = pdf('old file');
    const key = `${me.id}/11111111-2222-3333-4444-555555555555.pdf`;
    await legacy.put(key, content, { contentType: 'application/pdf' });
    const record = await repos.documents.create({ userId: me.id, typeId: 'passport', originalName: 'old.pdf', mimeType: 'application/pdf', sizeBytes: content.length, sha256: sha(content), storageKey: key, storageProvider: 'local' });
    const res = await agent.get(`/api/documents/${record.id}/download`).buffer(true).parse(binary).expect(200);
    expect((res.body as Buffer).equals(content)).toBe(true);
    await agent.delete(`/api/documents/${record.id}`).expect(204);
    expect(legacy.keys()).toEqual([]);
  });

  it('limits downloads', async () => {
    const { app } = await createTestApp({ limits: { download: 2 } });
    const agent = await signUp(app, 'a@example.com');
    const doc = await uploaded(agent);
    await agent.get(`/api/documents/${doc.id}/view`).expect(200);
    await agent.get(`/api/documents/${doc.id}/download`).expect(200);
    await agent.get(`/api/documents/${doc.id}/view`).expect(429);
  });
});

describe('one user cannot reach another user’s documents', () => {
  it('answers exactly as for a document that does not exist', async () => {
    const { app, storage } = await createTestApp();
    const alice = await signUp(app, 'alice@example.com');
    const bob = await signUp(app, 'bob@example.com');
    const doc = await uploaded(alice);

    const probes = [
      bob.get(`/api/documents/${doc.id}`),
      bob.get(`/api/documents/${doc.id}/status`),
      bob.get(`/api/documents/${doc.id}/view`),
      bob.get(`/api/documents/${doc.id}/download`),
      bob.delete(`/api/documents/${doc.id}`),
    ];
    for (const probe of probes) {
      const res = await probe.expect(404);
      expect(res.body.error.message).toBe('Document not found');
    }
    // Still there for Alice, and the file is untouched.
    await alice.get(`/api/documents/${doc.id}`).expect(200);
    expect(storage.keys()).toHaveLength(1);
  });

  it('refuses ids that cannot be ours without touching the database or storage', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    for (const id of ['..%2F..%2Fetc%2Fpasswd', '%00', 'a'.repeat(200), 'x%20y', '$ne', '{"$gt":""}']) {
      await agent.get(`/api/documents/${id}`).expect(404);
      await agent.get(`/api/documents/${id}/view`).expect(404);
      await agent.delete(`/api/documents/${id}`).expect(404);
    }
  });

  it('requires sign-in for every endpoint', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const doc = await uploaded(agent);
    const anon = (await import('supertest')).default(app);
    await anon.get('/api/documents').expect(401);
    await anon.get(`/api/documents/${doc.id}`).expect(401);
    await anon.get(`/api/documents/${doc.id}/status`).expect(401);
    await anon.get(`/api/documents/${doc.id}/view`).expect(401);
    await anon.get(`/api/documents/${doc.id}/download`).expect(401);
    await anon.delete(`/api/documents/${doc.id}`).expect(401);
    await anon.post('/api/documents/upload').attach('file', pdf(), 'a.pdf').field('typeId', 'passport').expect(401);
  });
});

describe('deleting a document', () => {
  it('removes the file, what was read from it, its job and the record', async () => {
    const { app, repos, storage } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const doc = await uploaded(agent);
    const record = (await repos.documents.findByIdForSystem(doc.id))!;
    await repos.extractions.save({ documentId: doc.id, userId: record.userId, sourceSha256: record.sha256, text: 't', textLength: 1, truncated: false, method: 'pdf_text', detectedType: 'passport', confidence: 'high', structured: null, ai: { status: 'not_requested' } });
    await repos.extractions.saveChunks(doc.id, record.userId, [{ text: 'chunk' }]);
    await repos.jobs.enqueue(doc.id, record.userId, { maxAttempts: 3, now: new Date() });

    await agent.delete(`/api/documents/${doc.id}`).expect(204);

    expect(storage.keys()).toEqual([]);
    expect(await repos.extractions.findByDocumentForSystem(doc.id)).toBeNull();
    expect(await repos.extractions.listChunks(record.userId, { limit: 10 })).toEqual([]);
    expect(await repos.jobs.findByDocument(doc.id)).toBeNull();
    expect(await repos.documents.listDeleted(10)).toEqual([]);
    expect((await agent.get('/api/documents')).body.documents).toEqual([]);
    await agent.get(`/api/documents/${doc.id}`).expect(404);
    await agent.delete(`/api/documents/${doc.id}`).expect(404);
  });

  it('hides the document at once even when the cleanup fails, and finishes it on the next sweep', async () => {
    const storage = createMemoryStorage();
    const { app, repos } = await createTestApp({ storage });
    const agent = await signUp(app, 'a@example.com');
    const doc = await uploaded(agent);
    const realDelete = storage.delete.bind(storage);
    let failing = true;
    storage.delete = async (ref) => {
      if (failing) throw new Error('storage is down');
      await realDelete(ref);
    };

    await agent.delete(`/api/documents/${doc.id}`).expect(204);
    expect((await agent.get('/api/documents')).body.documents).toEqual([]);
    await agent.get(`/api/documents/${doc.id}/view`).expect(404);
    expect(storage.keys()).toHaveLength(1);
    expect(await repos.documents.listDeleted(10)).toHaveLength(1);

    failing = false;
    expect(await documentServiceOf(app).sweepDeleted()).toBe(1);
    expect(storage.keys()).toEqual([]);
    expect(await repos.documents.listDeleted(10)).toEqual([]);
    expect(await documentServiceOf(app).sweepDeleted()).toBe(0);
  });

  it('frees a place under the per-user limit', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const { MAX_DOCUMENTS_PER_USER } = await import('./services/documents.js');
    const first = await uploaded(agent, 'first.pdf', pdf('0'));
    for (let i = 1; i < MAX_DOCUMENTS_PER_USER; i += 1) await uploaded(agent, 'a.pdf', pdf(String(i)));
    await upload(agent, { buffer: pdf('over'), filename: 'a.pdf' }, { typeId: 'passport' }).expect(409);
    await agent.delete(`/api/documents/${first.id}`).expect(204);
    await upload(agent, { buffer: pdf('fits now'), filename: 'a.pdf' }, { typeId: 'passport' }).expect(201);
  });
});

describe('the file is never read into memory by the upload path', () => {
  it('streams: the storage receives a stream, in more than one piece for a large file', async () => {
    const storage = createMemoryStorage();
    const pieces: number[] = [];
    const original = storage.putStream.bind(storage);
    storage.putStream = async (key, source, meta) => {
      const counted = Readable.from(
        (async function* () {
          for await (const piece of source) {
            pieces.push((piece as Buffer).length);
            yield piece;
          }
        })(),
      );
      return original(key, counted, meta);
    };
    const { app } = await createTestApp({ storage, config: { maxUploadBytes: 8 * 1024 * 1024 } });
    const agent = await signUp(app, 'a@example.com');
    await uploaded(agent, 'large.pdf', pdf('y'.repeat(2_000_000)));
    expect(pieces.length).toBeGreaterThan(3);
    expect(Math.max(...pieces)).toBeLessThan(1_000_000);
  });
});

function binary(res: http.IncomingMessage, callback: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}
