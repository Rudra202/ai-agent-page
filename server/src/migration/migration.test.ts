import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryRepositories } from '../repositories/memory.js';
import { createLocalStorage } from '../storage/local.js';
import { createMemoryStorage } from '../storage/memory.js';
import type { StorageProvider } from '../storage/types.js';
import { findOrphanFiles, migrateLocalDocuments, rollbackMigration } from './localToGridfs.js';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tajir-migrate-'));
  dirs.push(dir);
  const repos = createMemoryRepositories();
  const alice = await repos.users.create({ name: 'Alice', email: 'alice@example.com', passwordHash: 'x' });
  const bob = await repos.users.create({ name: 'Bob', email: 'bob@example.com', passwordHash: 'x' });
  const local = createLocalStorage(dir);
  const gridfs = createMemoryStorage('gridfs');
  let counter = 0;

  /** A document the way the old app made it: a file on disk, and a record that points at it. */
  async function oldDocument(user: { id: string }, name: string, content: Buffer, over: { mimeType?: string; record?: Record<string, unknown> } = {}) {
    const key = `${user.id}/${`00000000-0000-4000-8000-${String((counter += 1)).padStart(12, '0')}`}.pdf`;
    await local.put(key, content, { contentType: 'application/pdf' });
    return repos.documents.create({
      userId: user.id,
      typeId: 'passport',
      originalName: name,
      mimeType: over.mimeType ?? 'application/pdf',
      sizeBytes: content.length,
      sha256: sha(content),
      storageKey: key,
      storageProvider: 'local',
      ...over.record,
    });
  }
  const deps = { repos, local, gridfs, newId: () => `new-${(counter += 1)}`, log: () => undefined };
  return { dir, repos, alice, bob, local, gridfs, deps, oldDocument };
}

const bytes = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n${'x'.repeat(5000)}\n%%EOF`);
const read = async (storage: StorageProvider, key: string) => {
  const found = await storage.getStream(key);
  if (!found) return null;
  const chunks: Buffer[] = [];
  for await (const c of found.stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
};

describe('a dry run', () => {
  it('reports what would move and changes nothing', async () => {
    const { repos, alice, gridfs, deps, oldDocument } = await setup();
    const doc = await oldDocument(alice, 'a.pdf', bytes('a'));
    const report = await migrateLocalDocuments(deps);
    expect(report).toMatchObject({ mode: 'dry-run', examined: 1, moved: 1, problems: [] });
    expect(report.items).toEqual([{ documentId: doc.id, outcome: 'would_migrate' }]);
    expect(await repos.documents.findByIdForSystem(doc.id)).toMatchObject({ storageProvider: 'local', storageKey: doc.storageKey });
    expect(gridfs.keys()).toEqual([]);
  });

  it('is the default, and only an explicit apply changes anything', async () => {
    const { repos, alice, gridfs, deps, oldDocument } = await setup();
    await oldDocument(alice, 'a.pdf', bytes('a'));
    await migrateLocalDocuments(deps, {});
    await migrateLocalDocuments(deps, { apply: false });
    expect(gridfs.keys()).toEqual([]);
    expect(await repos.documents.listByStorageProvider('gridfs', 10)).toEqual([]);
  });
});

describe('applying', () => {
  it('copies the file, checks it, points the record at it, and keeps the local file and every other detail', async () => {
    const { repos, alice, local, gridfs, deps, oldDocument } = await setup();
    const content = bytes('passport');
    const doc = await oldDocument(alice, 'My Passport.pdf', content, { record: { requirementId: 'req-passport', businessProfileId: undefined } });
    await repos.documents.update(doc.id, { processingStatus: 'completed', aiStatus: 'skipped', detectedType: 'passport' });
    await repos.extractions.save({ documentId: doc.id, userId: alice.id, sourceSha256: doc.sha256, text: 'passport text', textLength: 13, truncated: false, method: 'pdf_text', detectedType: 'passport', confidence: 'high', structured: null, ai: { status: 'skipped' } });

    const report = await migrateLocalDocuments(deps, { apply: true });
    expect(report).toMatchObject({ mode: 'apply', examined: 1, moved: 1, problems: [] });

    const after = (await repos.documents.findById(alice.id, doc.id))!;
    expect(after.storageProvider).toBe('gridfs');
    expect(after.storageKey).toMatch(/\/new-\d+\.pdf$/);
    expect(after.previousStorage).toEqual({ provider: 'local', key: doc.storageKey });
    // Ownership, name, type, size, hash, application link and reading results are all as they were.
    expect(after).toMatchObject({ userId: alice.id, originalName: 'My Passport.pdf', typeId: 'passport', mimeType: 'application/pdf', sizeBytes: content.length, sha256: sha(content), requirementId: 'req-passport', processingStatus: 'completed', aiStatus: 'skipped', detectedType: 'passport' });
    expect((await repos.extractions.findByDocument(alice.id, doc.id))?.text).toBe('passport text');
    // The new copy holds exactly the same bytes, and the old file is still there.
    expect(sha((await read(gridfs, after.storageKey))!)).toBe(sha(content));
    expect(sha((await read(local, doc.storageKey))!)).toBe(sha(content));
  });

  it('keeps each document with its own owner', async () => {
    const { repos, alice, bob, deps, oldDocument } = await setup();
    const a = await oldDocument(alice, 'a.pdf', bytes('a'));
    const b = await oldDocument(bob, 'b.pdf', bytes('b'));
    await migrateLocalDocuments(deps, { apply: true });
    expect((await repos.documents.findById(alice.id, a.id))?.storageKey).toMatch(new RegExp(`^${alice.id}/|new-`));
    expect(await repos.documents.findById(alice.id, b.id)).toBeNull();
    expect((await repos.documents.findById(bob.id, b.id))?.storageProvider).toBe('gridfs');
  });

  it('can be run again: what has moved is not touched, and nothing is copied twice', async () => {
    const { alice, gridfs, deps, oldDocument } = await setup();
    await oldDocument(alice, 'a.pdf', bytes('a'));
    expect((await migrateLocalDocuments(deps, { apply: true })).moved).toBe(1);
    const copies = gridfs.keys().length;
    const again = await migrateLocalDocuments(deps, { apply: true });
    expect(again).toMatchObject({ examined: 0, moved: 0, problems: [] });
    expect(gridfs.keys()).toHaveLength(copies);
  });

  it('only moves local documents, and respects the limit', async () => {
    const { repos, alice, gridfs, deps, oldDocument } = await setup();
    for (const n of ['1', '2', '3']) await oldDocument(alice, `${n}.pdf`, bytes(n));
    await gridfs.put('already/there.pdf', bytes('g'), { contentType: 'application/pdf' });
    await repos.documents.create({ userId: alice.id, typeId: 'passport', originalName: 'native.pdf', mimeType: 'application/pdf', sizeBytes: 3, sha256: 'b'.repeat(64), storageKey: 'already/there.pdf', storageProvider: 'gridfs' });
    const report = await migrateLocalDocuments(deps, { apply: true, limit: 2 });
    expect(report).toMatchObject({ examined: 2, moved: 2 });
    expect((await repos.documents.listByStorageProvider('local', 10)).length).toBe(1);
    expect((await repos.documents.listByStorageProvider('gridfs', 10)).length).toBe(3);
  });
});

describe('files that cannot be moved safely are left alone', () => {
  it('a local file that no longer matches its record is not copied', async () => {
    const { repos, alice, local, gridfs, deps, oldDocument } = await setup();
    const doc = await oldDocument(alice, 'a.pdf', bytes('a'));
    // Same size, different content: damaged or replaced since it was recorded.
    await rm(local.resolvePath(doc.storageKey));
    await local.put(doc.storageKey, Buffer.from(bytes('a').toString('latin1').replace('% a', '% b'), 'latin1'), { contentType: 'application/pdf' });
    const report = await migrateLocalDocuments(deps, { apply: true });
    expect(report.items).toEqual([{ documentId: doc.id, outcome: 'hash_mismatch' }]);
    expect(report.problems).toHaveLength(1);
    expect(gridfs.keys()).toEqual([]);
    expect((await repos.documents.findByIdForSystem(doc.id))?.storageProvider).toBe('local');
  });

  it('a local file of a different size is not copied', async () => {
    const { alice, local, gridfs, deps, oldDocument } = await setup();
    const doc = await oldDocument(alice, 'a.pdf', bytes('a'));
    await rm(local.resolvePath(doc.storageKey));
    await local.put(doc.storageKey, Buffer.from('short'), { contentType: 'application/pdf' });
    expect((await migrateLocalDocuments(deps, { apply: true })).items[0]!.outcome).toBe('size_mismatch');
    expect(gridfs.keys()).toEqual([]);
  });

  it('a record whose file is missing is reported, and nothing else is affected', async () => {
    const { repos, alice, local, deps, oldDocument } = await setup();
    const lost = await oldDocument(alice, 'lost.pdf', bytes('lost'));
    const fine = await oldDocument(alice, 'fine.pdf', bytes('fine'));
    await rm(local.resolvePath(lost.storageKey));
    const report = await migrateLocalDocuments(deps, { apply: true });
    expect(report.items.find((i) => i.documentId === lost.id)?.outcome).toBe('missing_file');
    expect(report.items.find((i) => i.documentId === fine.id)?.outcome).toBe('migrated');
    expect((await repos.documents.findByIdForSystem(lost.id))?.storageProvider).toBe('local');
  });

  it('a copy that fails half way leaves nothing behind, keeps the record, and does not stop the others', async () => {
    const { repos, alice, gridfs, deps, oldDocument } = await setup();
    const first = await oldDocument(alice, 'first.pdf', bytes('first'));
    const second = await oldDocument(alice, 'second.pdf', bytes('second'));
    const real = gridfs.putStream.bind(gridfs);
    let calls = 0;
    gridfs.putStream = async (key, source, meta) => {
      calls += 1;
      if (calls === 1) {
        // Fails after taking some of the data.
        await new Promise<void>((resolve) => source.once('data', () => resolve()));
        throw new Error('connection lost with secret document words');
      }
      return real(key, source, meta);
    };
    const logs: string[] = [];
    const report = await migrateLocalDocuments({ ...deps, log: (m) => logs.push(m) }, { apply: true });
    expect(report.items.find((i) => i.documentId === first.id)?.outcome).toBe('error');
    expect(report.items.find((i) => i.documentId === second.id)?.outcome).toBe('migrated');
    expect((await repos.documents.findByIdForSystem(first.id))?.storageProvider).toBe('local');
    expect(gridfs.keys()).toHaveLength(1);
    expect(logs.join(' ')).not.toContain('secret');
  });

  it('a copy that does not read back identically is removed and the record is left alone', async () => {
    const { repos, alice, gridfs, deps, oldDocument } = await setup();
    const doc = await oldDocument(alice, 'a.pdf', bytes('a'));
    const realGet = gridfs.getStream.bind(gridfs);
    // The store claims success but hands back different bytes when read.
    gridfs.getStream = async (ref) => {
      const found = await realGet(ref);
      return found ? { stream: Readable.from([Buffer.from('corrupted')]), size: 9 } : null;
    };
    const report = await migrateLocalDocuments(deps, { apply: true });
    expect(report.items).toEqual([{ documentId: doc.id, outcome: 'verify_failed' }]);
    expect(gridfs.keys()).toEqual([]);
    expect((await repos.documents.findByIdForSystem(doc.id))?.storageProvider).toBe('local');
  });

  it('a document deleted while its file is being copied is not brought back, and the copy is removed', async () => {
    const { repos, alice, gridfs, deps, oldDocument } = await setup();
    const doc = await oldDocument(alice, 'a.pdf', bytes('a'));
    const real = gridfs.putStream.bind(gridfs);
    gridfs.putStream = async (key, source, meta) => {
      const saved = await real(key, source, meta);
      await repos.documents.markDeleted(alice.id, doc.id);
      return saved;
    };
    const report = await migrateLocalDocuments(deps, { apply: true });
    expect(report.items).toEqual([{ documentId: doc.id, outcome: 'skipped_changed' }]);
    expect(gridfs.keys()).toEqual([]);
    expect(await repos.documents.findByIdForSystem(doc.id)).toBeNull();
  });

  it('never deletes a local file, whatever happens', async () => {
    const { dir, alice, local, deps, oldDocument } = await setup();
    const ok = await oldDocument(alice, 'ok.pdf', bytes('ok'));
    const bad = await oldDocument(alice, 'bad.pdf', bytes('bad'));
    await rm(local.resolvePath(bad.storageKey));
    await local.put(bad.storageKey, Buffer.from('changed'), { contentType: 'application/pdf' });
    await migrateLocalDocuments(deps, { apply: true });
    await rollbackMigration(deps, { apply: true });
    await migrateLocalDocuments(deps, { apply: true });
    const files = await readdir(path.join(dir, alice.id));
    expect(files.sort()).toEqual([ok.storageKey.split('/')[1], bad.storageKey.split('/')[1]].sort());
  });
});

describe('undoing a migration', () => {
  it('reports in a dry run, then points the record back at the local file and removes the copy', async () => {
    const { repos, alice, local, gridfs, deps, oldDocument } = await setup();
    const content = bytes('a');
    const doc = await oldDocument(alice, 'a.pdf', content);
    await migrateLocalDocuments(deps, { apply: true });
    const migrated = (await repos.documents.findByIdForSystem(doc.id))!;

    const dry = await rollbackMigration(deps);
    expect(dry).toMatchObject({ mode: 'dry-run', examined: 1, moved: 1 });
    expect(dry.items[0]!.outcome).toBe('would_roll_back');
    expect((await repos.documents.findByIdForSystem(doc.id))?.storageProvider).toBe('gridfs');

    const done = await rollbackMigration(deps, { apply: true });
    expect(done.items).toEqual([{ documentId: doc.id, outcome: 'rolled_back' }]);
    const after = (await repos.documents.findByIdForSystem(doc.id))!;
    expect(after).toMatchObject({ storageProvider: 'local', storageKey: doc.storageKey });
    expect(after.previousStorage).toBeUndefined();
    expect(await read(gridfs, migrated.storageKey)).toBeNull();
    expect(sha((await read(local, doc.storageKey))!)).toBe(sha(content));
  });

  it('does not undo when the old local file is gone or changed, so the only copy is never removed', async () => {
    const { repos, alice, local, gridfs, deps, oldDocument } = await setup();
    const gone = await oldDocument(alice, 'gone.pdf', bytes('gone'));
    const changed = await oldDocument(alice, 'changed.pdf', bytes('changed'));
    await migrateLocalDocuments(deps, { apply: true });
    await rm(local.resolvePath(gone.storageKey));
    await rm(local.resolvePath(changed.storageKey));
    await local.put(changed.storageKey, Buffer.from('different'), { contentType: 'application/pdf' });
    const report = await rollbackMigration(deps, { apply: true });
    expect(report.items.map((i) => i.outcome).sort()).toEqual(['missing_file', 'size_mismatch']);
    for (const d of [gone, changed]) {
      const record = (await repos.documents.findByIdForSystem(d.id))!;
      expect(record.storageProvider).toBe('gridfs');
      expect(await read(gridfs, record.storageKey)).not.toBeNull();
    }
  });

  it('leaves documents that were never migrated alone', async () => {
    const { repos, alice, gridfs, deps } = await setup();
    await gridfs.put('x/y.pdf', bytes('n'), { contentType: 'application/pdf' });
    await repos.documents.create({ userId: alice.id, typeId: 'passport', originalName: 'native.pdf', mimeType: 'application/pdf', sizeBytes: 1, sha256: 'b'.repeat(64), storageKey: 'x/y.pdf', storageProvider: 'gridfs' });
    expect(await rollbackMigration(deps, { apply: true })).toMatchObject({ examined: 0, moved: 0 });
    expect(await read(gridfs, 'x/y.pdf')).not.toBeNull();
  });
});

describe('files with no record', () => {
  it('are listed and never touched, and files that records refer to (including migrated ones) are not listed', async () => {
    const { dir, repos, alice, local, deps, oldDocument } = await setup();
    const kept = await oldDocument(alice, 'kept.pdf', bytes('kept'));
    const moved = await oldDocument(alice, 'moved.pdf', bytes('moved'));
    const deleted = await oldDocument(alice, 'deleted.pdf', bytes('deleted'));
    await repos.documents.markDeleted(alice.id, deleted.id);
    // Two files left over from before records were kept.
    await mkdir(path.join(dir, 'someone'), { recursive: true });
    await writeFile(path.join(dir, 'someone', 'aaaaaaaa-0000-4000-8000-000000000001.png'), 'old');
    await writeFile(path.join(dir, alice.id, 'bbbbbbbb-0000-4000-8000-000000000002.png'), 'old');
    await migrateLocalDocuments({ ...deps, local }, { apply: true, limit: 1 });
    void moved;
    void kept;

    const orphans = await findOrphanFiles({ repos, rootDir: dir });
    expect(orphans).toEqual([`${alice.id}/bbbbbbbb-0000-4000-8000-000000000002.png`, 'someone/aaaaaaaa-0000-4000-8000-000000000001.png'].sort());
    // Listing is all it does.
    expect((await readdir(path.join(dir, 'someone'))).length).toBe(1);
  });

  it('returns nothing when there is no upload folder', async () => {
    const { repos } = await setup();
    expect(await findOrphanFiles({ repos, rootDir: path.join(os.tmpdir(), 'tajir-does-not-exist-12345') })).toEqual([]);
  });
});
