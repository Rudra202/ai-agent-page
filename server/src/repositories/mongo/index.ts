import type { ApplicationStatus, WorkflowEvent } from '@tajir/shared';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import type { ChunkRecord, ExtractionRecord, JobRecord } from '../../domain/documents.js';
import { eventUniqueKey } from '../../domain/entities.js';
import type {
  ApplicationRecord,
  BusinessProfile,
  ConversationRecord,
  DocumentRecord,
  MessageRecord,
  ServiceRecord,
  User,
  UserWithSecret,
} from '../../domain/entities.js';
import { DuplicateError } from '../errors.js';
import type { Repositories } from '../types.js';
import { registerModels } from './schemas.js';
import type { MongoModels } from './schemas.js';

type Lean = { _id: Types.ObjectId; [key: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

const OBJECT_ID = /^[a-f0-9]{24}$/i;
/** Returns an ObjectId, or null for anything that is not one, so a bad id means "not found" and never a crash. */
const oid = (id: string): Types.ObjectId | null => (OBJECT_ID.test(id) ? new Types.ObjectId(id) : null);
const str = (value: Types.ObjectId | string | undefined | null): string | undefined => (value ? String(value) : undefined);

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}

const toUser = (d: Lean): User => ({ id: String(d._id), name: d.name, email: d.email, createdAt: d.createdAt });

const toProfile = (d: Lean): BusinessProfile => ({
  id: String(d._id),
  userId: String(d.userId),
  kind: d.kind,
  name: d.name,
  registrationType: d.registrationType ?? undefined,
  jurisdictionId: d.jurisdictionId ?? undefined,
  packageId: d.packageId ?? undefined,
  activity: d.activity ?? undefined,
  category: d.category ?? undefined,
  description: d.description ?? undefined,
  shareholders: d.shareholders ?? undefined,
  createdAt: d.createdAt,
});

const toService = (d: Lean): ServiceRecord => ({
  id: String(d._id),
  slug: d.slug,
  type: d.type,
  name: d.name,
  description: d.description,
  steps: d.steps ?? [],
  config: d.config ?? {},
  sample: d.sample ?? true,
});

const toConversation = (d: Lean): ConversationRecord => ({
  id: String(d._id),
  userId: String(d.userId),
  title: d.title,
  workflow: d.workflow ?? {},
  quickReplies: d.quickReplies ?? [],
  status: d.status,
  lastMessageAt: d.lastMessageAt,
  createdAt: d.createdAt,
});

const toMessage = (d: Lean): MessageRecord => ({
  id: String(d._id),
  conversationId: String(d.conversationId),
  userId: String(d.userId),
  role: d.role,
  kind: d.kind,
  text: d.text ?? undefined,
  payload: d.payload ?? undefined,
  createdAt: d.createdAt,
});

const toApplication = (d: Lean): ApplicationRecord => ({
  id: String(d._id),
  userId: String(d.userId),
  reference: d.reference,
  service: d.service,
  serviceId: str(d.serviceId),
  title: d.title,
  subtitle: d.subtitle,
  details: (d.details ?? []).map((row: { label: string; value: string }) => ({ label: row.label, value: row.value })),
  businessProfileId: str(d.businessProfileId),
  status: d.status,
  lastEventAt: d.lastEventAt,
  createdAt: d.createdAt,
});

function toEvent(d: Lean): WorkflowEvent {
  const event: WorkflowEvent = {
    id: d.eventId,
    at: new Date(d.at).toISOString(),
    kind: d.kind,
    actor: d.actor,
    title: d.title,
  };
  if (d.detail != null) event.detail = d.detail;
  if (d.requirement != null) {
    event.requirement = {
      id: d.requirement.id,
      label: d.requirement.label,
      kind: d.requirement.kind,
      ...(d.requirement.docTypeId != null ? { docTypeId: d.requirement.docTypeId } : {}),
    };
  }
  if (d.requirementId != null) event.requirementId = d.requirementId;
  if (d.value != null) event.value = d.value;
  return event;
}

const toDocument = (d: Lean): DocumentRecord => ({
  id: String(d._id),
  userId: String(d.userId),
  applicationId: str(d.applicationId),
  requirementId: d.requirementId ?? undefined,
  typeId: d.typeId,
  originalName: d.originalName,
  mimeType: d.mimeType,
  sizeBytes: d.sizeBytes,
  sha256: d.sha256,
  storageKey: d.storageKey,
  storageProvider: d.storageProvider,
  previousStorage: d.previousStorage?.provider ? { provider: d.previousStorage.provider, key: d.previousStorage.key } : undefined,
  businessProfileId: str(d.businessProfileId),
  processingStatus: d.processingStatus ?? 'uploaded',
  aiStatus: d.aiStatus ?? 'not_requested',
  detectedType: d.detectedType ?? undefined,
  errorMessage: d.errorMessage ?? undefined,
  retryCount: d.retryCount ?? 0,
  processedAt: d.processedAt ?? undefined,
  deletedAt: d.deletedAt ?? undefined,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt ?? d.createdAt,
});

const toExtraction = (d: Lean): ExtractionRecord => ({
  id: String(d._id),
  documentId: String(d.documentId),
  userId: String(d.userId),
  sourceSha256: d.sourceSha256,
  text: d.text ?? '',
  textLength: d.textLength,
  truncated: d.truncated ?? false,
  pageCount: d.pageCount ?? undefined,
  method: d.method,
  detectedType: d.detectedType,
  confidence: d.confidence,
  structured: d.structured ?? null,
  ai: {
    status: d.ai?.status ?? 'not_requested',
    ...(d.ai?.provider ? { provider: d.ai.provider } : {}),
    ...(d.ai?.model ? { model: d.ai.model } : {}),
    ...(d.ai?.error ? { error: d.ai.error } : {}),
    ...(d.ai?.at ? { at: d.ai.at } : {}),
  },
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

const toChunk = (d: Lean): ChunkRecord => ({
  id: String(d._id),
  documentId: String(d.documentId),
  userId: String(d.userId),
  index: d.index,
  text: d.text,
  ...(d.page != null ? { page: d.page } : {}),
});

const toJob = (d: Lean): JobRecord => ({
  id: String(d._id),
  documentId: String(d.documentId),
  userId: String(d.userId),
  status: d.status,
  attempts: d.attempts,
  maxAttempts: d.maxAttempts,
  runAfter: d.runAfter,
  lockToken: d.lockToken ?? undefined,
  lockedUntil: d.lockedUntil ?? undefined,
  lastError: d.lastError ?? undefined,
  history: (d.history ?? []).map((h: { at: Date; status: JobRecord['history'][number]['status']; note: string }) => ({ at: h.at, status: h.status, note: h.note ?? '' })),
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MAX_HISTORY = 30;

export interface MongoRepositories {
  repositories: Repositories;
  models: MongoModels;
  /** Builds the indexes (including the unique ones). Safe to call repeatedly. */
  ensureIndexes: () => Promise<void>;
}

/** MongoDB implementation of the repository contract, bound to a specific connection. */
export function createMongoRepositories(connection: Connection): MongoRepositories {
  const m = registerModels(connection);

  const repositories: Repositories = {
    users: {
      async create(input) {
        try {
          const doc = await m.User.create({ name: input.name, email: input.email.trim().toLowerCase(), passwordHash: input.passwordHash });
          return toUser(doc.toObject() as Lean);
        } catch (error) {
          if (isDuplicateKey(error)) throw new DuplicateError('email');
          throw error;
        }
      },
      async findByEmail(email) {
        const d = (await m.User.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash').lean()) as Lean | null;
        return d ? ({ ...toUser(d), passwordHash: d.passwordHash } satisfies UserWithSecret) : null;
      },
      async findById(id) {
        const _id = oid(id);
        if (!_id) return null;
        const d = (await m.User.findById(_id).lean()) as Lean | null;
        return d ? toUser(d) : null;
      },
    },

    businessProfiles: {
      async create(input) {
        const userId = oid(input.userId);
        if (!userId) throw new Error('Invalid user id');
        const doc = await m.BusinessProfile.create({ ...input, userId });
        return toProfile(doc.toObject() as Lean);
      },
      async findPrimaryCompany(userId) {
        const _id = oid(userId);
        if (!_id) return null;
        const d = (await m.BusinessProfile.findOne({ userId: _id, kind: 'existing_company' }).sort({ createdAt: 1, _id: 1 }).lean()) as Lean | null;
        return d ? toProfile(d) : null;
      },
      async getById(userId, id) {
        const u = oid(userId);
        const _id = oid(id);
        if (!u || !_id) return null;
        const d = (await m.BusinessProfile.findOne({ _id, userId: u }).lean()) as Lean | null;
        return d ? toProfile(d) : null;
      },
    },

    services: {
      async upsert(input) {
        const d = (await m.Service.findOneAndUpdate(
          { slug: input.slug },
          { $set: { type: input.type, name: input.name, description: input.description, steps: input.steps, config: input.config, sample: input.sample } },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true },
        ).lean()) as Lean;
        return toService(d);
      },
      async list() {
        const docs = (await m.Service.find().sort({ name: 1 }).lean()) as Lean[];
        return docs.map(toService);
      },
      async findByIdOrSlug(value) {
        const id = oid(value);
        const d = (await m.Service.findOne(id ? { $or: [{ _id: id }, { slug: value }] } : { slug: value }).lean()) as Lean | null;
        return d ? toService(d) : null;
      },
    },

    conversations: {
      async create(input) {
        const userId = oid(input.userId);
        if (!userId) throw new Error('Invalid user id');
        const doc = await m.Conversation.create({ userId, title: input.title, workflow: input.workflow, quickReplies: input.quickReplies ?? [], lastMessageAt: new Date() });
        return toConversation(doc.toObject() as Lean);
      },
      async list(userId, limit) {
        const u = oid(userId);
        if (!u) return [];
        const docs = (await m.Conversation.find({ userId: u }).sort({ lastMessageAt: -1, _id: -1 }).limit(limit).lean()) as Lean[];
        return docs.map(toConversation);
      },
      async get(userId, id) {
        const u = oid(userId);
        const _id = oid(id);
        if (!u || !_id) return null;
        const d = (await m.Conversation.findOne({ _id, userId: u }).lean()) as Lean | null;
        return d ? toConversation(d) : null;
      },
      async update(userId, id, patch) {
        const u = oid(userId);
        const _id = oid(id);
        if (!u || !_id) return null;
        const set: Record<string, unknown> = {};
        if (patch.title !== undefined) set.title = patch.title;
        if (patch.workflow !== undefined) set.workflow = patch.workflow;
        if (patch.quickReplies !== undefined) set.quickReplies = patch.quickReplies;
        if (patch.lastMessageAt !== undefined) set.lastMessageAt = patch.lastMessageAt;
        const d = (await m.Conversation.findOneAndUpdate({ _id, userId: u }, { $set: set }, { returnDocument: 'after', runValidators: true }).lean()) as Lean | null;
        return d ? toConversation(d) : null;
      },
    },

    messages: {
      async append(input) {
        const userId = oid(input.userId);
        const conversationId = oid(input.conversationId);
        if (!userId || !conversationId) throw new Error('Invalid id');
        const doc = await m.Message.create({ ...input, userId, conversationId });
        return toMessage(doc.toObject() as Lean);
      },
      async list(userId, conversationId, limit) {
        const u = oid(userId);
        const c = oid(conversationId);
        if (!u || !c) return [];
        const docs = (await m.Message.find({ userId: u, conversationId: c }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean()) as Lean[];
        return docs.reverse().map(toMessage);
      },
      async count(userId, conversationId) {
        const u = oid(userId);
        const c = oid(conversationId);
        if (!u || !c) return 0;
        return m.Message.countDocuments({ userId: u, conversationId: c });
      },
    },

    applications: {
      async create(input) {
        const userId = oid(input.userId);
        if (!userId) throw new Error('Invalid user id');
        try {
          const doc = await m.Application.create({
            ...input,
            userId,
            serviceId: input.serviceId ? oid(input.serviceId) : undefined,
            businessProfileId: input.businessProfileId ? oid(input.businessProfileId) : undefined,
          });
          return toApplication(doc.toObject() as Lean);
        } catch (error) {
          if (isDuplicateKey(error)) throw new DuplicateError('reference');
          throw error;
        }
      },
      async findByReference(userId, reference) {
        const u = oid(userId);
        if (!u) return null;
        const d = (await m.Application.findOne({ reference, userId: u }).lean()) as Lean | null;
        return d ? toApplication(d) : null;
      },
      async listByUser(userId, filter) {
        const u = oid(userId);
        if (!u) return [];
        const query: Record<string, unknown> = { userId: u };
        if (filter?.statuses) query.status = { $in: filter.statuses };
        const docs = (await m.Application.find(query).sort({ lastEventAt: -1, _id: -1 }).lean()) as Lean[];
        return docs.map(toApplication);
      },
      async updateCache(userId, id, cache: { status: ApplicationStatus; lastEventAt: Date }) {
        const u = oid(userId);
        const _id = oid(id);
        if (!u || !_id) return;
        await m.Application.updateOne({ _id, userId: u }, { $set: { status: cache.status, lastEventAt: cache.lastEventAt } });
      },
    },

    events: {
      async append({ applicationId, userId, event }) {
        const a = oid(applicationId);
        const u = oid(userId);
        if (!a || !u) throw new Error('Invalid id');
        try {
          await m.ApplicationEvent.create({
            applicationId: a,
            userId: u,
            eventId: event.id,
            uniqueKey: eventUniqueKey(event),
            kind: event.kind,
            actor: event.actor,
            title: event.title,
            detail: event.detail,
            requirement: event.requirement,
            requirementId: event.requirementId,
            value: event.value,
            at: new Date(event.at),
          });
        } catch (error) {
          if (isDuplicateKey(error)) throw new DuplicateError('event');
          throw error;
        }
      },
      async listByApplication(applicationId) {
        const a = oid(applicationId);
        if (!a) return [];
        const docs = (await m.ApplicationEvent.find({ applicationId: a }).sort({ at: 1, _id: 1 }).lean()) as Lean[];
        return docs.map(toEvent);
      },
      async listByApplications(applicationIds) {
        const map = new Map<string, WorkflowEvent[]>(applicationIds.map((id) => [id, []]));
        const ids = applicationIds.map(oid).filter((id): id is Types.ObjectId => id !== null);
        if (ids.length === 0) return map;
        const docs = (await m.ApplicationEvent.find({ applicationId: { $in: ids } }).sort({ at: 1, _id: 1 }).lean()) as Lean[];
        for (const d of docs) map.get(String(d.applicationId))?.push(toEvent(d));
        return map;
      },
    },

    documents: {
      async create(input) {
        const userId = oid(input.userId);
        if (!userId) throw new Error('Invalid user id');
        const doc = await m.Document.create({
          ...input,
          userId,
          applicationId: input.applicationId ? oid(input.applicationId) : undefined,
          businessProfileId: input.businessProfileId ? oid(input.businessProfileId) : undefined,
          processingStatus: 'uploaded',
          aiStatus: 'not_requested',
          retryCount: 0,
        });
        return toDocument(doc.toObject() as Lean);
      },
      async findById(userId, id) {
        const u = oid(userId);
        const _id = oid(id);
        if (!u || !_id) return null;
        const d = (await m.Document.findOne({ _id, userId: u, deletedAt: { $exists: false } }).lean()) as Lean | null;
        return d ? toDocument(d) : null;
      },
      async findByIdForSystem(id) {
        const _id = oid(id);
        if (!_id) return null;
        const d = (await m.Document.findOne({ _id, deletedAt: { $exists: false } }).lean()) as Lean | null;
        return d ? toDocument(d) : null;
      },
      async listByUser(userId, limit) {
        const u = oid(userId);
        if (!u) return [];
        const docs = (await m.Document.find({ userId: u, deletedAt: { $exists: false } }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean()) as Lean[];
        return docs.map(toDocument);
      },
      async query(userId, q) {
        const u = oid(userId);
        if (!u) return { items: [], total: 0 };
        const filter: Record<string, unknown> = { userId: u, deletedAt: { $exists: false } };
        if (q.status) filter.processingStatus = q.status;
        if (q.typeId) filter.typeId = q.typeId;
        if (q.applicationId) {
          const a = oid(q.applicationId);
          if (!a) return { items: [], total: 0 };
          filter.applicationId = a;
        }
        // The search text is escaped, so it can only ever be matched literally.
        if (q.search) filter.originalName = { $regex: escapeRegex(q.search), $options: 'i' };
        const [docs, total] = await Promise.all([
          m.Document.find(filter)
            .sort({ createdAt: -1, _id: -1 })
            .skip((q.page - 1) * q.pageSize)
            .limit(q.pageSize)
            .lean() as Promise<Lean[]>,
          m.Document.countDocuments(filter),
        ]);
        return { items: docs.map(toDocument), total };
      },
      async listByApplication(userId, applicationId) {
        const u = oid(userId);
        const a = oid(applicationId);
        if (!u || !a) return [];
        const docs = (await m.Document.find({ userId: u, applicationId: a, deletedAt: { $exists: false } }).sort({ createdAt: -1, _id: -1 }).lean()) as Lean[];
        return docs.map(toDocument);
      },
      async countByUser(userId) {
        const u = oid(userId);
        return u ? m.Document.countDocuments({ userId: u, deletedAt: { $exists: false } }) : 0;
      },
      async update(id, patch) {
        const _id = oid(id);
        if (!_id) return null;
        const set: Record<string, unknown> = {};
        const unset: Record<string, 1> = {};
        const assign = (key: string, value: unknown) => {
          if (value === undefined) return;
          if (value === null) unset[key] = 1;
          else set[key] = value;
        };
        assign('processingStatus', patch.processingStatus);
        assign('aiStatus', patch.aiStatus);
        assign('detectedType', patch.detectedType);
        assign('errorMessage', patch.errorMessage);
        assign('retryCount', patch.retryCount);
        assign('processedAt', patch.processedAt);
        const update: Record<string, unknown> = {};
        if (Object.keys(set).length) update.$set = set;
        if (Object.keys(unset).length) update.$unset = unset;
        const d = (await m.Document.findOneAndUpdate({ _id, deletedAt: { $exists: false } }, Object.keys(update).length ? update : { $set: {} }, { returnDocument: 'after', runValidators: true }).lean()) as Lean | null;
        return d ? toDocument(d) : null;
      },
      async markDeleted(userId, id) {
        const u = oid(userId);
        const _id = oid(id);
        if (!u || !_id) return null;
        const d = (await m.Document.findOneAndUpdate({ _id, userId: u, deletedAt: { $exists: false } }, { $set: { deletedAt: new Date() } }, { returnDocument: 'after' }).lean()) as Lean | null;
        return d ? toDocument(d) : null;
      },
      async listDeleted(limit) {
        const docs = (await m.Document.find({ deletedAt: { $exists: true } }).sort({ deletedAt: 1 }).limit(limit).lean()) as Lean[];
        return docs.map(toDocument);
      },
      async findBySha256(userId, sha256) {
        const u = oid(userId);
        if (!u || !/^[a-f0-9]{64}$/.test(sha256)) return null;
        const d = (await m.Document.findOne({ userId: u, sha256, deletedAt: { $exists: false } }).sort({ createdAt: 1, _id: 1 }).lean()) as Lean | null;
        return d ? toDocument(d) : null;
      },
      async listByStorageProvider(provider, limit) {
        const docs = (await m.Document.find({ storageProvider: provider, deletedAt: { $exists: false } }).sort({ createdAt: 1, _id: 1 }).limit(limit).lean()) as Lean[];
        return docs.map(toDocument);
      },
      async repointStorage(id, from, to, previous) {
        const _id = oid(id);
        if (!_id) return null;
        // The filter makes this atomic: it only happens if the document still points at `from` and has not been deleted.
        const d = (await m.Document.findOneAndUpdate(
          { _id, storageProvider: from.provider, storageKey: from.key, deletedAt: { $exists: false } },
          previous ? { $set: { storageProvider: to.provider, storageKey: to.key, previousStorage: previous } } : { $set: { storageProvider: to.provider, storageKey: to.key }, $unset: { previousStorage: 1 } },
          { returnDocument: 'after' },
        ).lean()) as Lean | null;
        return d ? toDocument(d) : null;
      },
      async listByStatus(status, before, limit) {
        const docs = (await m.Document.find({ processingStatus: status, deletedAt: { $exists: false }, updatedAt: { $lt: before } }).sort({ updatedAt: 1 }).limit(limit).lean()) as Lean[];
        return docs.map(toDocument);
      },
      async removeRecord(id) {
        const _id = oid(id);
        if (!_id) return false;
        const result = await m.Document.deleteOne({ _id });
        return result.deletedCount > 0;
      },
      async delete(userId, id) {
        const u = oid(userId);
        const _id = oid(id);
        if (!u || !_id) return false;
        const result = await m.Document.deleteOne({ _id, userId: u });
        return result.deletedCount > 0;
      },
    },

    extractions: {
      async save(input) {
        const documentId = oid(input.documentId);
        const userId = oid(input.userId);
        if (!documentId || !userId) throw new Error('Invalid id');
        const d = (await m.ExtractedDocument.findOneAndUpdate(
          { documentId },
          { $set: { ...input, documentId, userId } },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true },
        ).lean()) as Lean;
        return toExtraction(d);
      },
      async findByDocument(userId, documentId) {
        const u = oid(userId);
        const documentOid = oid(documentId);
        if (!u || !documentOid) return null;
        const d = (await m.ExtractedDocument.findOne({ documentId: documentOid, userId: u }).lean()) as Lean | null;
        return d ? toExtraction(d) : null;
      },
      async findByDocumentForSystem(documentId) {
        const documentOid = oid(documentId);
        if (!documentOid) return null;
        const d = (await m.ExtractedDocument.findOne({ documentId: documentOid }).lean()) as Lean | null;
        return d ? toExtraction(d) : null;
      },
      async setUnderstanding(documentId, patch) {
        const documentOid = oid(documentId);
        if (!documentOid) return null;
        const set: Record<string, unknown> = { structured: patch.structured, ai: patch.ai };
        if (patch.detectedType !== undefined) set.detectedType = patch.detectedType;
        const d = (await m.ExtractedDocument.findOneAndUpdate({ documentId: documentOid }, { $set: set }, { returnDocument: 'after', runValidators: true }).lean()) as Lean | null;
        return d ? toExtraction(d) : null;
      },
      async deleteByDocument(documentId) {
        const documentOid = oid(documentId);
        if (!documentOid) return;
        await m.ExtractedDocument.deleteMany({ documentId: documentOid });
        await m.DocumentChunk.deleteMany({ documentId: documentOid });
      },
      async saveChunks(documentId, userId, items) {
        const documentOid = oid(documentId);
        const u = oid(userId);
        if (!documentOid || !u) throw new Error('Invalid id');
        await m.DocumentChunk.deleteMany({ documentId: documentOid });
        if (items.length === 0) return;
        await m.DocumentChunk.insertMany(items.map((item, index) => ({ documentId: documentOid, userId: u, index, text: item.text, ...(item.page !== undefined ? { page: item.page } : {}) })));
      },
      async listChunks(userId, options) {
        const u = oid(userId);
        if (!u) return [];
        const filter: Record<string, unknown> = { userId: u };
        if (options.documentIds) {
          const ids = options.documentIds.map(oid).filter((id): id is Types.ObjectId => id !== null);
          if (ids.length === 0) return [];
          filter.documentId = { $in: ids };
        }
        const docs = (await m.DocumentChunk.find(filter).sort({ documentId: 1, index: 1 }).limit(options.limit).lean()) as Lean[];
        return docs.map(toChunk);
      },
      async listByUser(userId, limit) {
        const u = oid(userId);
        if (!u) return [];
        const docs = (await m.ExtractedDocument.find({ userId: u }, { text: 0 }).sort({ createdAt: -1 }).limit(limit).lean()) as Lean[];
        return docs.map((d) => {
          const e = toExtraction({ ...d, text: '' });
          return { documentId: e.documentId, detectedType: e.detectedType, confidence: e.confidence, structured: e.structured, ai: e.ai, pageCount: e.pageCount, textLength: e.textLength };
        });
      },
    },

    jobs: {
      async enqueue(documentId, userId, { maxAttempts, now }) {
        const documentOid = oid(documentId);
        const u = oid(userId);
        if (!documentOid || !u) throw new Error('Invalid id');
        // Already waiting or running: hand back the same job. No duplicate is ever created.
        const active = (await m.DocumentProcessingJob.findOne({ documentId: documentOid, status: { $in: ['queued', 'processing', 'retrying'] } }).lean()) as Lean | null;
        if (active) return { job: toJob(active), created: false };
        // Finished or failed: put the same record back in the queue (atomically, only if it is still finished or failed).
        const requeued = (await m.DocumentProcessingJob.findOneAndUpdate(
          { documentId: documentOid, status: { $in: ['completed', 'failed'] } },
          {
            $set: { status: 'queued', attempts: 0, maxAttempts, runAfter: now },
            $unset: { lockToken: 1, lockedUntil: 1, lastError: 1 },
            $push: { history: { $each: [{ at: now, status: 'requeued', note: 'Queued again' }], $slice: -MAX_HISTORY } },
          },
          { returnDocument: 'after' },
        ).lean()) as Lean | null;
        if (requeued) return { job: toJob(requeued), created: false };
        try {
          const doc = await m.DocumentProcessingJob.create({
            documentId: documentOid,
            userId: u,
            status: 'queued',
            attempts: 0,
            maxAttempts,
            runAfter: now,
            history: [{ at: now, status: 'queued', note: 'Queued' }],
          });
          return { job: toJob(doc.toObject() as Lean), created: true };
        } catch (error) {
          // A concurrent request created it first: the unique index on documentId made sure of that.
          if (!isDuplicateKey(error)) throw error;
          const existing = (await m.DocumentProcessingJob.findOne({ documentId: documentOid }).lean()) as Lean;
          return { job: toJob(existing), created: false };
        }
      },
      async claim(token, leaseMs, now) {
        const d = (await m.DocumentProcessingJob.findOneAndUpdate(
          {
            $or: [
              { status: { $in: ['queued', 'retrying'] }, runAfter: { $lte: now } },
              { status: 'processing', lockedUntil: { $lt: now } },
            ],
          },
          {
            $set: { status: 'processing', lockToken: token, lockedUntil: new Date(now.getTime() + leaseMs) },
            $inc: { attempts: 1 },
            $push: { history: { $each: [{ at: now, status: 'processing', note: 'Started' }], $slice: -MAX_HISTORY } },
          },
          { sort: { runAfter: 1 }, returnDocument: 'after' },
        ).lean()) as Lean | null;
        return d ? toJob(d) : null;
      },
      async complete(id, token, now, note) {
        const _id = oid(id);
        if (!_id) return false;
        const result = await m.DocumentProcessingJob.updateOne(
          { _id, lockToken: token, status: 'processing' },
          {
            $set: { status: 'completed' },
            $unset: { lockToken: 1, lockedUntil: 1, lastError: 1 },
            $push: { history: { $each: [{ at: now, status: 'completed', note }], $slice: -MAX_HISTORY } },
          },
        );
        return result.modifiedCount > 0;
      },
      async fail(id, token, now, error, retryAt) {
        const _id = oid(id);
        if (!_id) return null;
        const current = (await m.DocumentProcessingJob.findOne({ _id, lockToken: token, status: 'processing' }).lean()) as Lean | null;
        if (!current) return null;
        const retry = retryAt !== undefined && current.attempts < current.maxAttempts;
        const status = retry ? 'retrying' : 'failed';
        const d = (await m.DocumentProcessingJob.findOneAndUpdate(
          { _id, lockToken: token, status: 'processing' },
          {
            $set: { status, lastError: error, ...(retry ? { runAfter: retryAt } : {}) },
            $unset: { lockToken: 1, lockedUntil: 1 },
            $push: { history: { $each: [{ at: now, status, note: error }], $slice: -MAX_HISTORY } },
          },
          { returnDocument: 'after' },
        ).lean()) as Lean | null;
        return d ? toJob(d) : null;
      },
      async findByDocument(documentId) {
        const documentOid = oid(documentId);
        if (!documentOid) return null;
        const d = (await m.DocumentProcessingJob.findOne({ documentId: documentOid }).lean()) as Lean | null;
        return d ? toJob(d) : null;
      },
      async listRecoverable(now, limit) {
        const docs = (await m.DocumentProcessingJob.find({
          $or: [{ status: { $in: ['queued', 'retrying'] } }, { status: 'processing', lockedUntil: { $lt: now } }],
        })
          .sort({ runAfter: 1 })
          .limit(limit)
          .lean()) as Lean[];
        return docs.map(toJob);
      },
      async deleteByDocument(documentId) {
        const documentOid = oid(documentId);
        if (!documentOid) return;
        await m.DocumentProcessingJob.deleteMany({ documentId: documentOid });
      },
    },
  };

  return {
    repositories,
    models: m,
    ensureIndexes: async () => {
      await Promise.all(Object.values(m).map((model) => model.createIndexes()));
    },
  };
}
