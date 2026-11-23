import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { DocumentRecord } from '../domain/entities.js';
import type { Repositories } from '../repositories/types.js';
import type { StorageProvider } from '../storage/types.js';

/**
 * Moves documents from the old local-disk storage into GridFS, safely.
 *
 * The rules this follows:
 *  - It does nothing unless asked to apply. The default is a dry run that only reads and reports.
 *  - A file is copied only if what is on disk is exactly what was recorded (size and SHA-256). A file that does not
 *    match is reported and left alone, never copied.
 *  - After copying, the copy is read back and checked again. Only then is the record pointed at it, and only if the
 *    record still pointed at the old file (so a document deleted or moved meanwhile is left alone).
 *  - The local file is NEVER deleted. The record remembers where the file was, so the move can be undone.
 *  - Anything that goes wrong removes the copy it made and leaves the record exactly as it was.
 *  - It is safe to run again: documents that have moved are no longer candidates.
 */

export interface MigrationDeps {
  repos: Repositories;
  local: StorageProvider;
  gridfs: StorageProvider;
  newId?: () => string;
  /** Operational messages. They never contain file names or content. */
  log?: (message: string) => void;
}

export interface MigrationOptions {
  /** False (the default) only reports what would happen. */
  apply?: boolean;
  /** The most documents to look at in one run. */
  limit?: number;
}

export type MigrationOutcome =
  | 'migrated'
  | 'would_migrate'
  | 'rolled_back'
  | 'would_roll_back'
  | 'missing_file'
  | 'hash_mismatch'
  | 'size_mismatch'
  | 'verify_failed'
  | 'skipped_changed'
  | 'error';

export interface MigrationItem {
  documentId: string;
  outcome: MigrationOutcome;
}

export interface MigrationReport {
  mode: 'dry-run' | 'apply';
  examined: number;
  /** Documents moved (or that would be moved, in a dry run). */
  moved: number;
  /** Documents that could not be moved, and why, one entry each. */
  problems: MigrationItem[];
  items: MigrationItem[];
}

const EXTENSION: Record<string, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };

async function digest(stream: Readable): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    const piece = chunk as Buffer;
    hash.update(piece);
    size += piece.length;
  }
  return { sha256: hash.digest('hex'), size };
}

/** The size and hash of what a storage really holds for a key, or null if it holds nothing. */
async function measureStored(storage: StorageProvider, key: string): Promise<{ sha256: string; size: number } | null> {
  const found = await storage.getStream(key);
  return found ? digest(found.stream) : null;
}

function reportOf(mode: 'dry-run' | 'apply', examined: number, items: MigrationItem[]): MigrationReport {
  const ok = new Set<MigrationOutcome>(['migrated', 'would_migrate', 'rolled_back', 'would_roll_back']);
  return { mode, examined, moved: items.filter((i) => ok.has(i.outcome)).length, problems: items.filter((i) => !ok.has(i.outcome)), items };
}

/** Local-disk documents into GridFS. */
export async function migrateLocalDocuments(deps: MigrationDeps, options: MigrationOptions = {}): Promise<MigrationReport> {
  const { repos, local, gridfs, newId = randomUUID } = deps;
  const log = deps.log ?? (() => undefined);
  const apply = options.apply === true;
  const candidates = await repos.documents.listByStorageProvider('local', options.limit ?? 1_000);
  const items: MigrationItem[] = [];

  async function one(doc: DocumentRecord): Promise<MigrationOutcome> {
    const found = await measureStored(local, doc.storageKey);
    if (!found) return 'missing_file';
    if (found.size !== doc.sizeBytes) return 'size_mismatch';
    if (found.sha256 !== doc.sha256) return 'hash_mismatch';
    if (!apply) return 'would_migrate';

    const source = await local.getStream(doc.storageKey);
    if (!source) return 'missing_file';
    const key = `${doc.userId}/${newId()}.${EXTENSION[doc.mimeType] ?? 'pdf'}`;
    // One byte of headroom, so a file that grew since it was measured fails instead of being cut short.
    const copy = await gridfs.putStream(key, source.stream, { contentType: doc.mimeType, maxBytes: doc.sizeBytes + 1 });
    try {
      if (copy.size !== doc.sizeBytes || copy.sha256 !== doc.sha256) {
        await gridfs.delete(copy.ref);
        return 'verify_failed';
      }
      // Read the copy back from where it now lives, rather than trusting what was written.
      const readBack = await measureStored(gridfs, copy.ref);
      if (!readBack || readBack.size !== doc.sizeBytes || readBack.sha256 !== doc.sha256) {
        await gridfs.delete(copy.ref);
        return 'verify_failed';
      }
      const from = { provider: 'local', key: doc.storageKey };
      const moved = await repos.documents.repointStorage(doc.id, from, { provider: 'gridfs', key: copy.ref }, from);
      if (!moved) {
        // Deleted or moved by someone else in the meantime: this copy is not wanted.
        await gridfs.delete(copy.ref);
        return 'skipped_changed';
      }
      return 'migrated';
    } catch (error) {
      await gridfs.delete(copy.ref).catch(() => undefined);
      throw error;
    }
  }

  for (const doc of candidates) {
    let outcome: MigrationOutcome;
    try {
      outcome = await one(doc);
    } catch (error) {
      // One document failing never stops the others, and leaves its own record as it was.
      log(`[migration] ${doc.id} could not be moved (${error instanceof Error ? error.name : 'Error'})`);
      outcome = 'error';
    }
    items.push({ documentId: doc.id, outcome });
  }
  return reportOf(apply ? 'apply' : 'dry-run', candidates.length, items);
}

/** Undoes a migration for documents whose old local file is still there and unchanged. */
export async function rollbackMigration(deps: MigrationDeps, options: MigrationOptions = {}): Promise<MigrationReport> {
  const { repos, local, gridfs } = deps;
  const log = deps.log ?? (() => undefined);
  const apply = options.apply === true;
  const candidates = (await repos.documents.listByStorageProvider('gridfs', options.limit ?? 1_000)).filter((d) => d.previousStorage?.provider === 'local');
  const items: MigrationItem[] = [];

  async function one(doc: DocumentRecord): Promise<MigrationOutcome> {
    const previous = doc.previousStorage!;
    const found = await measureStored(local, previous.key);
    if (!found) return 'missing_file';
    if (found.size !== doc.sizeBytes) return 'size_mismatch';
    if (found.sha256 !== doc.sha256) return 'hash_mismatch';
    if (!apply) return 'would_roll_back';
    const moved = await repos.documents.repointStorage(doc.id, { provider: 'gridfs', key: doc.storageKey }, { provider: 'local', key: previous.key }, null);
    if (!moved) return 'skipped_changed';
    // Only now, with the record back on the local file, is the GridFS copy removed.
    await gridfs.delete(doc.storageKey);
    return 'rolled_back';
  }

  for (const doc of candidates) {
    let outcome: MigrationOutcome;
    try {
      outcome = await one(doc);
    } catch (error) {
      log(`[migration] ${doc.id} could not be moved back (${error instanceof Error ? error.name : 'Error'})`);
      outcome = 'error';
    }
    items.push({ documentId: doc.id, outcome });
  }
  return reportOf(apply ? 'apply' : 'dry-run', candidates.length, items);
}

/**
 * Files in the local upload folder that no document record refers to (left by uploads from before records were kept,
 * or by earlier tests). They are only listed. Nothing here ever deletes a file.
 */
export async function findOrphanFiles(deps: { repos: Repositories; rootDir: string }): Promise<string[]> {
  const referenced = new Set<string>();
  for (const doc of await deps.repos.documents.listByStorageProvider('local', 100_000)) referenced.add(doc.storageKey);
  for (const doc of await deps.repos.documents.listByStorageProvider('gridfs', 100_000)) if (doc.previousStorage?.provider === 'local') referenced.add(doc.previousStorage.key);
  for (const doc of await deps.repos.documents.listDeleted(100_000)) if (doc.storageProvider === 'local') referenced.add(doc.storageKey);

  const orphans: string[] = [];
  let owners: string[];
  try {
    owners = await readdir(deps.rootDir);
  } catch {
    return [];
  }
  for (const owner of owners) {
    let files: string[];
    try {
      files = await readdir(path.join(deps.rootDir, owner));
    } catch {
      continue;
    }
    for (const file of files) {
      const key = `${owner}/${file}`;
      if (!referenced.has(key)) orphans.push(key);
    }
  }
  return orphans.sort();
}
