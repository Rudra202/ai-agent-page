import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectType, inspectFile, sanitizeFileName } from './services/fileInspection.js';
import { createLocalStorage } from './storage/local.js';
import { companyBody, createTestApp, financeBody, jpeg, pdf, png, signUp, upload, windowsProgram } from './test/helpers.js';

describe('uploading a document', () => {
  it('stores a PDF, records it, and returns metadata without the storage key', async () => {
    const { app, storage } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const content = pdf('passport');
    const res = await upload(agent, { buffer: content, filename: 'My Passport.pdf' }, { typeId: 'passport' }).expect(201);

    expect(res.body.document).toMatchObject({
      typeId: 'passport',
      label: 'Passport copy',
      originalName: 'My Passport.pdf',
      mimeType: 'application/pdf',
      sizeBytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      applicationId: null,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/storageKey|storageProvider/);
    expect(storage.keys()).toHaveLength(1);
    expect(storage.get(storage.keys()[0]!)?.equals(content)).toBe(true);
  });

  it('accepts PNG and JPEG files and records the real type', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const a = await upload(agent, { buffer: png(), filename: 'id.PNG' }, { typeId: 'emirates_id' }).expect(201);
    const b = await upload(agent, { buffer: jpeg(), filename: 'id.jpeg' }, { typeId: 'proof_of_address' }).expect(201);
    expect(a.body.document.mimeType).toBe('image/png');
    expect(b.body.document.mimeType).toBe('image/jpeg');
  });

  it('never uses the user supplied file name to decide where the file goes', async () => {
    const { app, storage } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const res = await upload(agent, { buffer: pdf(), filename: '../../etc/passwd.pdf' }, { typeId: 'passport' }).expect(201);
    expect(res.body.document.originalName).toBe('passwd.pdf');
    const [key] = storage.keys();
    expect(key).toMatch(/^[A-Za-z0-9-]+\/[A-Za-z0-9-]+\.pdf$/);
    expect(key).not.toContain('passwd');
    expect(key).not.toContain('..');
  });

  describe('rejects files that fail inspection', () => {
    it('a program renamed to .pdf, because its content is not a PDF', async () => {
      const { app, storage } = await createTestApp();
      const agent = await signUp(app, 'a@example.com');
      const res = await upload(agent, { buffer: windowsProgram(), filename: 'statement.pdf' }, { typeId: 'passport' }).expect(422);
      expect(res.body.error.message).toBe('The file content is not a PDF, PNG or JPG.');
      expect(storage.keys()).toHaveLength(0);
    });

    it('a PNG renamed to .pdf, because the content does not match the extension', async () => {
      const { app } = await createTestApp();
      const agent = await signUp(app, 'a@example.com');
      const res = await upload(agent, { buffer: png(), filename: 'statement.pdf' }, { typeId: 'passport' }).expect(422);
      expect(res.body.error.message).toBe('The file content does not match its extension.');
    });

    it.each(['run.exe', 'script.js', 'page.html', 'archive.zip', 'noextension', 'statement.pdf.exe'])('the extension of %s', async (filename) => {
      const { app, storage } = await createTestApp();
      const agent = await signUp(app, 'a@example.com');
      await upload(agent, { buffer: pdf(), filename }, { typeId: 'passport' }).expect(415);
      expect(storage.keys()).toHaveLength(0);
    });

    it('an empty file', async () => {
      const { app } = await createTestApp();
      const agent = await signUp(app, 'a@example.com');
      await upload(agent, { buffer: Buffer.alloc(0), filename: 'empty.pdf' }, { typeId: 'passport' }).expect(400);
    });

    it('a file over the size limit, before anything is stored', async () => {
      const { app, storage } = await createTestApp({ config: { maxUploadBytes: 2048 } });
      const agent = await signUp(app, 'a@example.com');
      const res = await upload(agent, { buffer: pdf('x'.repeat(5000)), filename: 'big.pdf' }, { typeId: 'passport' }).expect(413);
      expect(res.body.error.message).toBe('The file is too large.');
      expect(storage.keys()).toHaveLength(0);
    });
  });

  it('rejects a missing file, a missing or unknown type, a wrong field name and extra fields', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    await upload(agent, null, { typeId: 'passport' }).expect(400);
    await upload(agent, { buffer: pdf(), filename: 'a.pdf' }, {}).expect(400);
    await upload(agent, { buffer: pdf(), filename: 'a.pdf' }, { typeId: 'selfie' }).expect(422);
    await upload(agent, { buffer: pdf(), filename: 'a.pdf' }, { typeId: 'passport', role: 'admin' }).expect(400);
    await agent.post('/api/documents/upload').field('typeId', 'passport').attach('document', pdf(), 'a.pdf').expect(400);
    await upload(agent, { buffer: pdf(), filename: 'a.pdf' }, { typeId: 'passport', applicationId: 'REG-2026-000001' }).expect(400);
    await upload(agent, { buffer: pdf(), filename: 'a.pdf' }, { typeId: 'passport', requirementId: 'req-passport' }).expect(400);
    await upload(agent, { buffer: pdf(), filename: 'a.pdf' }, { typeId: 'passport', applicationId: '../x', requirementId: 'r' }).expect(400);
  });

  it('limits how many documents one user can keep', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const { MAX_DOCUMENTS_PER_USER } = await import('./services/documents.js');
    for (let i = 0; i < MAX_DOCUMENTS_PER_USER; i += 1) {
      await upload(agent, { buffer: pdf(String(i)), filename: 'a.pdf' }, { typeId: 'passport' }).expect(201);
    }
    await upload(agent, { buffer: pdf('one more'), filename: 'a.pdf' }, { typeId: 'passport' }).expect(409);
  });

  it('limits the number of uploads in a period', async () => {
    const { app } = await createTestApp({ limits: { upload: 2 } });
    const agent = await signUp(app, 'a@example.com');
    await upload(agent, { buffer: pdf('1'), filename: 'a.pdf' }, { typeId: 'passport' }).expect(201);
    await upload(agent, { buffer: pdf('2'), filename: 'a.pdf' }, { typeId: 'passport' }).expect(201);
    await upload(agent, { buffer: pdf('3'), filename: 'a.pdf' }, { typeId: 'passport' }).expect(429);
  });
});

describe('attaching a document to an application requirement', () => {
  async function waitingApplication() {
    const ctx = await createTestApp();
    const agent = await signUp(ctx.app, 'a@example.com');
    const created = (await agent.post('/api/applications').send(financeBody()).expect(201)).body.application;
    return { ...ctx, agent, created };
  }

  it('records the requirement, links the document and lists it for the application', async () => {
    const { agent, created } = await waitingApplication();
    const res = await upload(agent, { buffer: pdf('s'), filename: 'statement.pdf' }, { typeId: 'bank_statement_6m', applicationId: created.id, requirementId: 'req-bank_statement_6m' }).expect(201);
    expect(res.body.document).toMatchObject({ applicationId: created.id, requirementId: 'req-bank_statement_6m' });
    expect(res.body.application.requirements.find((r: { id: string }) => r.id === 'req-bank_statement_6m').done).toBe(true);

    const listed = (await agent.get(`/api/applications/${created.id}/documents`).expect(200)).body.documents;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ originalName: 'statement.pdf', applicationId: created.id });
    expect((await agent.get('/api/documents').expect(200)).body.documents[0].applicationId).toBe(created.id);
  });

  it('refuses the wrong document type, an information requirement, and an unknown requirement, storing nothing', async () => {
    const { agent, created, storage } = await waitingApplication();
    const send = (fields: Record<string, string>) => upload(agent, { buffer: pdf(), filename: 'a.pdf' }, { applicationId: created.id, ...fields });
    expect((await send({ typeId: 'passport', requirementId: 'req-bank_statement_6m' }).expect(422)).body.error.message).toContain('type of document');
    await send({ typeId: 'bank_statement_6m', requirementId: 'req-info-0' }).expect(422);
    await send({ typeId: 'bank_statement_6m', requirementId: 'req-nope' }).expect(404);
    await upload(agent, { buffer: pdf(), filename: 'a.pdf' }, { typeId: 'bank_statement_6m', applicationId: 'FIN-2026-999999', requirementId: 'req-bank_statement_6m' }).expect(404);
    expect(storage.keys()).toHaveLength(0);
  });

  it('refuses a document that was already provided and removes nothing that was kept', async () => {
    const { agent, created, storage } = await waitingApplication();
    const fields = { typeId: 'bank_statement_6m', applicationId: created.id, requirementId: 'req-bank_statement_6m' };
    await upload(agent, { buffer: pdf('1'), filename: 'a.pdf' }, fields).expect(201);
    await upload(agent, { buffer: pdf('2'), filename: 'b.pdf' }, fields).expect(409);
    expect(storage.keys()).toHaveLength(1);
    expect((await agent.get(`/api/applications/${created.id}/documents`)).body.documents).toHaveLength(1);
  });

  it('makes a later application treat the stored document as on record', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const created = (await agent.post('/api/applications').send(companyBody()).expect(201)).body.application;
    expect(created.requirements).toHaveLength(3);
    await upload(agent, { buffer: pdf('p'), filename: 'p.pdf' }, { typeId: 'passport' }).expect(201);
    const second = (await agent.post('/api/applications').send(companyBody({ companyName: 'Second Co' })).expect(201)).body.application;
    expect(second.requirements.map((r: { docTypeId: string }) => r.docTypeId)).toEqual(['emirates_id', 'proof_of_address']);
  });
});

describe('documents are private', () => {
  it("lists only the user's own documents", async () => {
    const { app } = await createTestApp();
    const alice = await signUp(app, 'alice@example.com');
    const bob = await signUp(app, 'bob@example.com');
    await upload(alice, { buffer: pdf('a'), filename: 'a.pdf' }, { typeId: 'passport' }).expect(201);
    expect((await alice.get('/api/documents').expect(200)).body.documents).toHaveLength(1);
    expect((await bob.get('/api/documents').expect(200)).body.documents).toEqual([]);
  });
});

describe('file inspection', () => {
  it('detects types from the bytes', () => {
    expect(detectType(pdf())).toBe('application/pdf');
    expect(detectType(png())).toBe('image/png');
    expect(detectType(jpeg())).toBe('image/jpeg');
    expect(detectType(windowsProgram())).toBeNull();
    expect(detectType(Buffer.from('%PD'))).toBeNull();
    expect(detectType(Buffer.alloc(0))).toBeNull();
  });

  it('passes a matching file and reports its hash', () => {
    const data = pdf('hello');
    expect(inspectFile(data, 'Report.PDF')).toEqual({ mime: 'application/pdf', ext: 'pdf', sha256: createHash('sha256').update(data).digest('hex') });
    expect(inspectFile(jpeg(), 'photo.jpg').ext).toBe('jpg');
    expect(inspectFile(jpeg(), 'photo.jpeg').ext).toBe('jpg');
  });

  it('cleans names for display only', () => {
    expect(sanitizeFileName('C:\\Users\\me\\scan.pdf')).toBe('scan.pdf');
    expect(sanitizeFileName('../../x/..')).toBe('document');
    expect(sanitizeFileName('a\u0000b\u001f.pdf')).toBe('ab.pdf');
    expect(sanitizeFileName('  spaced   out  .pdf ')).toBe('spaced out .pdf');
    expect(sanitizeFileName('')).toBe('document');
    const long = sanitizeFileName(`${'x'.repeat(300)}.pdf`);
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith('.pdf')).toBe(true);
  });
});

describe('local storage', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('writes files with restricted permissions and removes them', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tajir-storage-'));
    const storage = createLocalStorage(dir);
    const key = 'user123/0a1b2c3d-1111-2222-3333-444455556666.pdf';
    await storage.put(key, Buffer.from('hello'), { contentType: 'application/pdf' });
    expect((await readFile(storage.resolvePath(key))).toString()).toBe('hello');
    expect(storage.resolvePath(key).startsWith(path.resolve(dir))).toBe(true);
    if (process.platform !== 'win32') expect((await stat(storage.resolvePath(key))).mode & 0o777).toBe(0o600);
    await storage.delete(key);
    await expect(stat(storage.resolvePath(key))).rejects.toThrow();
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });

  it('never overwrites an existing file', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tajir-storage-'));
    const storage = createLocalStorage(dir);
    const key = 'user123/0a1b2c3d-1111-2222-3333-444455556666.pdf';
    await storage.put(key, Buffer.from('first'), { contentType: 'application/pdf' });
    await expect(storage.put(key, Buffer.from('second'), { contentType: 'application/pdf' })).rejects.toThrow();
    expect((await readFile(storage.resolvePath(key))).toString()).toBe('first');
  });

  it.each([
    '../escape.pdf',
    'user/../../escape.pdf',
    '/etc/passwd',
    'user\\..\\escape.pdf',
    'user/file.exe',
    'user/file.pdf/extra',
    'user/.pdf',
    '',
    'a'.repeat(80) + '/b.pdf',
    'user/file.pdf\u0000.png',
  ])('refuses the key %j', async (key) => {
    dir = await mkdtemp(path.join(tmpdir(), 'tajir-storage-'));
    const storage = createLocalStorage(dir);
    await expect(storage.put(key, Buffer.from('x'), { contentType: 'application/pdf' })).rejects.toThrow('Invalid storage key');
    expect(() => storage.resolvePath(key)).toThrow('Invalid storage key');
  });
});
