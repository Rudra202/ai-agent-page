import { randomUUID } from 'node:crypto';
import { DOCUMENT_TYPES, documentLabel } from '@tajir/shared';
import type multer from 'multer';
import { z } from 'zod';
import type { ExtractionRecord } from '../domain/documents.js';
import type { DocumentRecord, User } from '../domain/entities.js';
import { HttpError } from '../middleware/errorHandler.js';
import type { DocumentQuery, Repositories } from '../repositories/types.js';
import type { StorageProvider, StoredStream } from '../storage/types.js';
import type { ApplicationService, ApplicationView } from './applications.js';
import { APPLICATION_REFERENCE } from './applications.js';
import { sanitizeFileName } from './fileInspection.js';
import { createUploadEngine } from './uploadEngine.js';
import type { StoredUpload } from './uploadEngine.js';

/** Form fields sent with the file. The file itself is validated separately, by content. */
export const uploadFieldsSchema = z
  .object({
    typeId: z.string().min(1).max(64),
    applicationId: z.string().regex(APPLICATION_REFERENCE, 'Not a valid application reference').optional(),
    requirementId: z.string().min(1).max(96).optional(),
    /** The chat's attach button sends this: if the same file is already one of this user's documents, use that one. */
    reuseExisting: z.literal('true').optional(),
  })
  .strict()
  .refine((v) => (v.applicationId === undefined) === (v.requirementId === undefined), {
    message: 'applicationId and requirementId must be sent together',
    path: ['requirementId'],
  });
export type UploadFields = z.output<typeof uploadFieldsSchema>;

/** Query string of the list endpoint. Anything unknown is refused. */
export const listQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(100),
    status: z.enum(['uploaded', 'queued', 'processing', 'retrying', 'completed', 'partially_completed', 'failed']).optional(),
    typeId: z.string().min(1).max(64).optional(),
    applicationId: z.string().regex(APPLICATION_REFERENCE, 'Not a valid application reference').optional(),
    search: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export type ListQuery = z.output<typeof listQuerySchema>;

/** What the API returns. The storage key is internal and never leaves the server. */
export interface DocumentView {
  id: string;
  typeId: string;
  label: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  /** Application reference, when the document was uploaded for one. */
  applicationId: string | null;
  requirementId: string | null;
  processingStatus: DocumentRecord['processingStatus'];
  aiStatus: DocumentRecord['aiStatus'];
  /** What the content looks like, when it has been read. Set by the system, and a reading, not a verification. */
  detectedType: string | null;
  /** A short, safe reason, when processing failed. */
  errorMessage: string | null;
  retryCount: number;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What was read from a document. The AI part is an interpretation, and says so. */
export interface ExtractionView {
  method: ExtractionRecord['method'];
  detectedType: string;
  confidence: ExtractionRecord['confidence'];
  pageCount: number | null;
  textLength: number;
  truncated: boolean;
  structured: Record<string, unknown> | null;
  ai: { status: ExtractionRecord['ai']['status']; provider: string | null; model: string | null; error: string | null };
}

export interface DocumentDetail extends DocumentView {
  extraction: ExtractionView | null;
}

export interface DocumentStatusView {
  id: string;
  processingStatus: DocumentView['processingStatus'];
  aiStatus: DocumentView['aiStatus'];
  detectedType: string | null;
  errorMessage: string | null;
  retryCount: number;
  processedAt: string | null;
  updatedAt: string;
  /** True while the system is still working on it, so a screen knows to keep asking. */
  active: boolean;
}

export const MAX_DOCUMENTS_PER_USER = 100;

const ACTIVE = new Set<DocumentRecord['processingStatus']>(['uploaded', 'queued', 'processing', 'retrying']);

const toView = (doc: DocumentRecord, referenceById: Map<string, string>): DocumentView => ({
  id: doc.id,
  typeId: doc.typeId,
  label: documentLabel(doc.typeId),
  originalName: doc.originalName,
  mimeType: doc.mimeType,
  sizeBytes: doc.sizeBytes,
  sha256: doc.sha256,
  applicationId: doc.applicationId ? (referenceById.get(doc.applicationId) ?? null) : null,
  requirementId: doc.requirementId ?? null,
  processingStatus: doc.processingStatus,
  aiStatus: doc.aiStatus,
  detectedType: doc.detectedType ?? null,
  errorMessage: doc.errorMessage ?? null,
  retryCount: doc.retryCount,
  processedAt: doc.processedAt ? doc.processedAt.toISOString() : null,
  createdAt: doc.createdAt.toISOString(),
  updatedAt: doc.updatedAt.toISOString(),
});

const toExtractionView = (e: ExtractionRecord): ExtractionView => ({
  method: e.method,
  detectedType: e.detectedType,
  confidence: e.confidence,
  pageCount: e.pageCount ?? null,
  textLength: e.textLength,
  truncated: e.truncated,
  structured: e.structured,
  ai: { status: e.ai.status, provider: e.ai.provider ?? null, model: e.ai.model ?? null, error: e.ai.error ?? null },
});

export interface DocumentServiceDeps {
  repos: Repositories;
  /** Where new files go. */
  storage: StorageProvider;
  /** Other places existing documents may still live (documents uploaded before GridFS are on local disk). Read and delete only. */
  legacyStorage?: StorageProvider[];
  applications: ApplicationService;
  newId?: () => string;
  /** Called after a document is recorded, to hand it to processing. A failure here never loses the upload. */
  onUploaded?: (doc: DocumentRecord) => Promise<void>;
  /** Processing, for "process this again". Without it that action is refused as unavailable. */
  reprocess?: (doc: DocumentRecord) => Promise<void>;
  log?: (message: string) => void;
}

export function createDocumentService({ repos, storage, legacyStorage = [], applications, newId = randomUUID, onUploaded, reprocess, log = console.warn }: DocumentServiceDeps) {
  const providers = [storage, ...legacyStorage];
  const providerFor = (name: string): StorageProvider | undefined => providers.find((p) => p.name === name);

  async function referenceMap(user: User): Promise<Map<string, string>> {
    const records = await repos.applications.listByUser(user.id);
    return new Map(records.map((r) => [r.id, r.reference]));
  }

  async function owned(user: User, id: string): Promise<DocumentRecord> {
    const doc = await repos.documents.findById(user.id, id);
    // A document that is someone else's looks exactly like one that does not exist.
    if (!doc) throw new HttpError(404, 'Document not found');
    return doc;
  }

  /** Removes the file, the reading of it and its job, then the record. Safe to run again: every step is idempotent. */
  async function cleanup(doc: DocumentRecord): Promise<boolean> {
    try {
      const provider = providerFor(doc.storageProvider);
      if (provider) await provider.delete(doc.storageKey);
      await repos.jobs.deleteByDocument(doc.id);
      await repos.extractions.deleteByDocument(doc.id);
      await repos.documents.removeRecord(doc.id);
      return true;
    } catch (error) {
      // The record stays marked as deleted (so it is still hidden) and the next sweep tries again.
      log(`[documents] cleanup of ${doc.id} will be retried: ${error instanceof Error ? error.message : 'unknown error'}`);
      return false;
    }
  }

  return {
    /** The multer engine that streams an upload into storage. */
    uploadEngine(maxBytes: number): multer.StorageEngine {
      return createUploadEngine({ repos, storage, maxBytes, maxDocuments: MAX_DOCUMENTS_PER_USER, newId });
    },

    /**
     * Turns a stored file into a document. When it is for an application requirement, the requirement is checked,
     * and if anything fails the stored file is removed again, so a refused upload leaves nothing behind.
     */
    async completeUpload(
      user: User,
      stored: StoredUpload,
      originalName: string,
      fields: UploadFields,
    ): Promise<{ document: DocumentView; application?: ApplicationView; reused?: true }> {
      let record: DocumentRecord | undefined;
      try {
        if (!(fields.typeId in DOCUMENT_TYPES)) throw new HttpError(422, 'Unknown document type');

        // The same file, already one of this user's documents: nothing new is kept, and the existing record (with its
        // reading) is used. Only when asked for, and never for a file that belongs to an application requirement.
        if (fields.reuseExisting && !fields.applicationId) {
          const existing = await repos.documents.findBySha256(user.id, stored.sha256);
          if (existing) {
            await storage.delete(stored.ref).catch(() => undefined);
            return { document: toView(existing, await referenceMap(user)), reused: true };
          }
        }

        let applicationRecord: { id: string; businessProfileId?: string } | undefined;
        if (fields.applicationId && fields.requirementId) {
          await applications.assertDocumentRequirement(user, fields.applicationId, fields.requirementId, fields.typeId);
          const found = await applications.record(user, fields.applicationId);
          applicationRecord = { id: found.id, businessProfileId: found.businessProfileId };
        }

        const safeName = sanitizeFileName(originalName);
        record = await repos.documents.create({
          userId: user.id,
          applicationId: applicationRecord?.id,
          businessProfileId: applicationRecord?.businessProfileId,
          requirementId: fields.requirementId,
          typeId: fields.typeId,
          originalName: safeName,
          mimeType: stored.mime,
          sizeBytes: stored.size,
          sha256: stored.sha256,
          storageKey: stored.ref,
          storageProvider: storage.name,
        });

        let application: ApplicationView | undefined;
        if (fields.applicationId && fields.requirementId) {
          application = await applications.provideDocument(user, fields.applicationId, fields.requirementId, safeName);
        }

        if (onUploaded) {
          try {
            await onUploaded(record);
          } catch (error) {
            // The file is safe and the document is recorded as "uploaded"; the recovery sweep will queue it.
            log(`[documents] ${record.id} was saved but not queued yet: ${error instanceof Error ? error.message : 'unknown error'}`);
          }
        }

        const references = fields.applicationId && applicationRecord ? new Map([[applicationRecord.id, fields.applicationId]]) : new Map<string, string>();
        const fresh = (await repos.documents.findById(user.id, record.id)) ?? record;
        return { document: toView(fresh, references), application };
      } catch (error) {
        if (record) await repos.documents.removeRecord(record.id).catch(() => undefined);
        await storage.delete(stored.ref).catch(() => undefined);
        throw error;
      }
    },

    /** Removes a file that was stored but never became a document (for example when the form fields were invalid). */
    async discardUpload(stored: StoredUpload): Promise<void> {
      await storage.delete(stored.ref).catch(() => undefined);
    },

    async list(user: User, query: Partial<ListQuery> = {}): Promise<{ documents: DocumentView[]; total: number; page: number; pageSize: number }> {
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 100;
      const references = await referenceMap(user);

      let applicationRecordId: string | undefined;
      if (query.applicationId) {
        const wanted = [...references.entries()].find(([, reference]) => reference === query.applicationId);
        // A reference that is not the user's own matches nothing.
        if (!wanted) return { documents: [], total: 0, page, pageSize };
        applicationRecordId = wanted[0];
      }
      const repoQuery: DocumentQuery = { page, pageSize, status: query.status, typeId: query.typeId, applicationId: applicationRecordId, search: query.search };
      const { items, total } = await repos.documents.query(user.id, repoQuery);
      return { documents: items.map((d) => toView(d, references)), total, page, pageSize };
    },

    async listForApplication(user: User, reference: string): Promise<DocumentView[]> {
      const record = await applications.record(user, reference);
      const docs = await repos.documents.listByApplication(user.id, record.id);
      return docs.map((d) => toView(d, new Map([[record.id, record.reference]])));
    },

    async get(user: User, id: string): Promise<DocumentDetail> {
      const doc = await owned(user, id);
      const [references, extraction] = await Promise.all([referenceMap(user), repos.extractions.findByDocument(user.id, doc.id)]);
      return { ...toView(doc, references), extraction: extraction ? toExtractionView(extraction) : null };
    },

    async status(user: User, id: string): Promise<DocumentStatusView> {
      const doc = await owned(user, id);
      return {
        id: doc.id,
        processingStatus: doc.processingStatus,
        aiStatus: doc.aiStatus,
        detectedType: doc.detectedType ?? null,
        errorMessage: doc.errorMessage ?? null,
        retryCount: doc.retryCount,
        processedAt: doc.processedAt ? doc.processedAt.toISOString() : null,
        updatedAt: doc.updatedAt.toISOString(),
        active: ACTIVE.has(doc.processingStatus),
      };
    },

    /**
     * Reads the document again, from the stored file. It does nothing to a document that is already waiting or being
     * processed (it keeps its one job), so pressing the button twice is harmless.
     */
    async reprocess(user: User, id: string): Promise<DocumentStatusView> {
      const doc = await owned(user, id);
      if (!reprocess) throw new HttpError(503, 'Document processing is not available right now. Please try again later.');
      const idle = !ACTIVE.has(doc.processingStatus) || doc.processingStatus === 'uploaded';
      if (idle) await reprocess(doc);
      return this.status(user, id);
    },

    /** The file itself, for the owner only. */
    async open(user: User, id: string): Promise<{ doc: DocumentRecord; file: StoredStream }> {
      const doc = await owned(user, id);
      const provider = providerFor(doc.storageProvider);
      const file = provider ? await provider.getStream(doc.storageKey) : null;
      if (!file) {
        // The record exists but the bytes do not (or their storage is not configured here). Say so plainly, reveal nothing else.
        log(`[documents] file for ${doc.id} is not available in "${doc.storageProvider}" storage`);
        throw new HttpError(404, 'The file for this document is not available.');
      }
      return { doc, file };
    },

    /** Hides the document at once, then removes its file and everything read from it. */
    async remove(user: User, id: string): Promise<void> {
      const doc = await repos.documents.markDeleted(user.id, id);
      if (!doc) throw new HttpError(404, 'Document not found');
      await cleanup(doc);
    },

    /** Finishes the cleanup of documents whose removal was interrupted. Returns how many were completed. */
    async sweepDeleted(limit = 50): Promise<number> {
      let done = 0;
      for (const doc of await repos.documents.listDeleted(limit)) {
        if (await cleanup(doc)) done += 1;
      }
      return done;
    },
  };
}

export type DocumentService = ReturnType<typeof createDocumentService>;
