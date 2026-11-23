import type { ApplicationStatus, WorkflowEvent } from '@tajir/shared';
import type { AiStatus, ChunkRecord, DocumentStatus, ExtractionRecord, JobRecord } from '../domain/documents.js';
import type {
  ApplicationRecord,
  BusinessProfile,
  ConversationRecord,
  DocumentRecord,
  MessageKind,
  MessageRecord,
  ServiceRecord,
  User,
  UserWithSecret,
} from '../domain/entities.js';

/**
 * Persistence contract. Two implementations exist: an in-memory one (tests and
 * database-free development) and a MongoDB one. Both run the same contract
 * tests. Every read or write that belongs to a user takes the user id, so an
 * ownership mistake in a higher layer cannot leak another user's data.
 */

export interface UserRepository {
  /** Throws DuplicateError("email") if the email is taken. */
  create(input: { name: string; email: string; passwordHash: string }): Promise<User>;
  findByEmail(email: string): Promise<UserWithSecret | null>;
  findById(id: string): Promise<User | null>;
}

export interface BusinessProfileRepository {
  create(input: Omit<BusinessProfile, 'id' | 'createdAt'>): Promise<BusinessProfile>;
  /** The user's own existing company, oldest first. */
  findPrimaryCompany(userId: string): Promise<BusinessProfile | null>;
  getById(userId: string, id: string): Promise<BusinessProfile | null>;
}

export interface ServiceRepository {
  /** Inserts or updates by slug. */
  upsert(input: Omit<ServiceRecord, 'id'>): Promise<ServiceRecord>;
  list(): Promise<ServiceRecord[]>;
  findByIdOrSlug(value: string): Promise<ServiceRecord | null>;
}

export interface ConversationRepository {
  create(input: { userId: string; title: string; workflow: Record<string, unknown>; quickReplies?: string[] }): Promise<ConversationRecord>;
  /** Most recently active first. */
  list(userId: string, limit: number): Promise<ConversationRecord[]>;
  get(userId: string, id: string): Promise<ConversationRecord | null>;
  update(
    userId: string,
    id: string,
    patch: Partial<Pick<ConversationRecord, 'title' | 'workflow' | 'quickReplies' | 'lastMessageAt'>>,
  ): Promise<ConversationRecord | null>;
}

export interface NewMessage {
  conversationId: string;
  userId: string;
  role: 'user' | 'assistant';
  kind: MessageKind;
  text?: string;
  payload?: unknown;
}

export interface MessageRepository {
  append(input: NewMessage): Promise<MessageRecord>;
  /** The most recent `limit` messages of the user's conversation, oldest first. */
  list(userId: string, conversationId: string, limit: number): Promise<MessageRecord[]>;
  count(userId: string, conversationId: string): Promise<number>;
}

export interface NewApplicationRecord {
  userId: string;
  reference: string;
  service: ApplicationRecord['service'];
  serviceId?: string;
  title: string;
  subtitle: string;
  details: ApplicationRecord['details'];
  businessProfileId?: string;
  status: ApplicationStatus;
  lastEventAt: Date;
}

export interface ApplicationRepository {
  /** Throws DuplicateError("reference") if the reference exists. */
  create(input: NewApplicationRecord): Promise<ApplicationRecord>;
  findByReference(userId: string, reference: string): Promise<ApplicationRecord | null>;
  /** Most recently updated first. */
  listByUser(userId: string, filter?: { statuses?: ApplicationStatus[] }): Promise<ApplicationRecord[]>;
  updateCache(userId: string, id: string, cache: { status: ApplicationStatus; lastEventAt: Date }): Promise<void>;
}

export interface EventRepository {
  /** Throws DuplicateError("event") if the same milestone or requirement step was already recorded. */
  append(input: { applicationId: string; userId: string; event: WorkflowEvent }): Promise<void>;
  /** In the order the events were recorded. */
  listByApplication(applicationId: string): Promise<WorkflowEvent[]>;
  listByApplications(applicationIds: string[]): Promise<Map<string, WorkflowEvent[]>>;
}

export interface NewDocument {
  userId: string;
  businessProfileId?: string;
  applicationId?: string;
  requirementId?: string;
  typeId: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  storageProvider: string;
}

export interface DocumentQuery {
  /** 1-based. */
  page: number;
  pageSize: number;
  status?: DocumentStatus;
  typeId?: string;
  applicationId?: string;
  /** Matched against the file name, case-insensitively. */
  search?: string;
}

/** What the processing worker may change. Ownership, storage and the file's identity are not on this list. */
export interface DocumentPatch {
  processingStatus?: DocumentStatus;
  aiStatus?: AiStatus;
  detectedType?: string | null;
  errorMessage?: string | null;
  retryCount?: number;
  processedAt?: Date | null;
}

/** Documents a user has deleted but whose cleanup is not finished are never returned by any method here except `listDeleted`. */
export interface DocumentRepository {
  /** Starts as "uploaded", with no AI step requested. */
  create(input: NewDocument): Promise<DocumentRecord>;
  /** A document the user owns, or null. Never a deleted one. */
  findById(userId: string, id: string): Promise<DocumentRecord | null>;
  /** For the processing worker, which acts for the system and not for a user. Deleted documents are not returned. */
  findByIdForSystem(id: string): Promise<DocumentRecord | null>;
  /** Newest first. */
  listByUser(userId: string, limit: number): Promise<DocumentRecord[]>;
  query(userId: string, query: DocumentQuery): Promise<{ items: DocumentRecord[]; total: number }>;
  listByApplication(userId: string, applicationId: string): Promise<DocumentRecord[]>;
  countByUser(userId: string): Promise<number>;
  /** Changes processing fields. Returns null if there is no such document. */
  update(id: string, patch: DocumentPatch): Promise<DocumentRecord | null>;
  /** Hides a document the user owns at once, so it can no longer be read. Returns the record, or null if there was none. */
  markDeleted(userId: string, id: string): Promise<DocumentRecord | null>;
  /** Documents waiting for their cleanup to finish. */
  listDeleted(limit: number): Promise<DocumentRecord[]>;
  /** A live document of this user with exactly this content (SHA-256), oldest first, or null. */
  findBySha256(userId: string, sha256: string): Promise<DocumentRecord | null>;
  /** Live documents whose file is in the given storage, oldest first. For moving files between storages. */
  listByStorageProvider(provider: string, limit: number): Promise<DocumentRecord[]>;
  /**
   * Points a document at a new place for its file, but only if it still points at `from`. A document that was deleted,
   * or already moved, is left alone and null is returned. `previous` records where it came from (null clears it).
   */
  repointStorage(
    id: string,
    from: { provider: string; key: string },
    to: { provider: string; key: string },
    previous: { provider: string; key: string } | null,
  ): Promise<DocumentRecord | null>;
  /** Documents in a given status that have not changed since `before`, oldest first. For finding work that got stuck. */
  listByStatus(status: DocumentStatus, before: Date, limit: number): Promise<DocumentRecord[]>;
  /** Removes the record itself for good. Used when cleanup has finished, and to undo an upload that failed half way. */
  removeRecord(id: string): Promise<boolean>;
  /** Removes a record the user owns. Returns false if there was none. */
  delete(userId: string, id: string): Promise<boolean>;
}

export interface ExtractionRepository {
  /** Saves what was read from a document, replacing any earlier extraction of the same document. */
  save(input: Omit<ExtractionRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<ExtractionRecord>;
  findByDocument(userId: string, documentId: string): Promise<ExtractionRecord | null>;
  findByDocumentForSystem(documentId: string): Promise<ExtractionRecord | null>;
  /** Changes the AI part of an extraction. Returns null if there is no extraction. */
  setUnderstanding(
    documentId: string,
    patch: { structured: Record<string, unknown> | null; ai: ExtractionRecord['ai']; detectedType?: string },
  ): Promise<ExtractionRecord | null>;
  deleteByDocument(documentId: string): Promise<void>;
  /** Replaces the chunks of a document. */
  saveChunks(documentId: string, userId: string, chunks: Array<{ text: string; page?: number }>): Promise<void>;
  /** A user's chunks, in document order. Only ever that user's. Optionally limited to some documents. */
  listChunks(userId: string, options: { documentIds?: string[]; limit: number }): Promise<ChunkRecord[]>;
  /** A user's extractions without their text, for choosing which documents are relevant. */
  listByUser(userId: string, limit: number): Promise<Array<Pick<ExtractionRecord, 'documentId' | 'detectedType' | 'confidence' | 'structured' | 'ai' | 'pageCount' | 'textLength'>>>;
}

export interface EnqueueOptions {
  maxAttempts: number;
  now: Date;
}

export interface JobRepository {
  /**
   * Makes sure the document has a job waiting. A document has one job record: if it is already waiting or running,
   * that same job is returned (so uploading twice or pressing reprocess twice cannot make duplicates).
   * A finished or failed job is reset and queued again.
   */
  enqueue(documentId: string, userId: string, options: EnqueueOptions): Promise<{ job: JobRecord; created: boolean }>;
  /**
   * Takes the next job that is due, for the worker holding `token`, until `now + leaseMs`. Atomic: two workers can
   * never take the same job. A job whose lease ran out (the worker died) can be taken again.
   */
  claim(token: string, leaseMs: number, now: Date): Promise<JobRecord | null>;
  /** Marks a job done. Only the worker that holds the token can do it. */
  complete(id: string, token: string, now: Date, note: string): Promise<boolean>;
  /**
   * Records a failed attempt. With `retryAt` (and attempts left) the job goes to "retrying", otherwise to "failed".
   * Only the worker that holds the token can do it.
   */
  fail(id: string, token: string, now: Date, error: string, retryAt?: Date): Promise<JobRecord | null>;
  findByDocument(documentId: string): Promise<JobRecord | null>;
  /** Jobs that are waiting, or whose lease ran out, whatever their time. */
  listRecoverable(now: Date, limit: number): Promise<JobRecord[]>;
  deleteByDocument(documentId: string): Promise<void>;
}

export interface Repositories {
  users: UserRepository;
  businessProfiles: BusinessProfileRepository;
  services: ServiceRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  applications: ApplicationRepository;
  events: EventRepository;
  documents: DocumentRepository;
  extractions: ExtractionRepository;
  jobs: JobRepository;
}
