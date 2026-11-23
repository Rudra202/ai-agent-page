import { randomUUID } from 'node:crypto';
import type { WorkflowEvent } from '@tajir/shared';
import { eventUniqueKey } from '../domain/entities.js';
import type { ChunkRecord, ExtractionRecord, JobRecord } from '../domain/documents.js';
import type {
  ApplicationRecord,
  BusinessProfile,
  ConversationRecord,
  DocumentRecord,
  MessageRecord,
  ServiceRecord,
  User,
  UserWithSecret,
} from '../domain/entities.js';
import { DuplicateError } from './errors.js';
import type { Repositories } from './types.js';

const copy = <T>(value: T): T => structuredClone(value);

/**
 * In-memory repositories. Used for fast tests and for running the server
 * without a database during development. Data is lost when the process stops.
 * It follows the same rules as the MongoDB implementation, including uniqueness.
 */
export function createMemoryRepositories(clock: () => Date = () => new Date()): Repositories {
  const users = new Map<string, UserWithSecret>();
  const profiles: BusinessProfile[] = [];
  const services = new Map<string, ServiceRecord>();
  const conversations: ConversationRecord[] = [];
  const messages: MessageRecord[] = [];
  const applications: ApplicationRecord[] = [];
  const events: Array<{ applicationId: string; userId: string; event: WorkflowEvent }> = [];
  const eventKeys = new Set<string>();
  const documents: DocumentRecord[] = [];
  const extractions: ExtractionRecord[] = [];
  const chunks: ChunkRecord[] = [];
  const jobs: JobRecord[] = [];

  const publicUser = ({ passwordHash: _passwordHash, ...user }: UserWithSecret): User => user;

  return {
    users: {
      async create(input) {
        const email = input.email.trim().toLowerCase();
        if ([...users.values()].some((u) => u.email === email)) throw new DuplicateError('email');
        const user: UserWithSecret = { id: randomUUID(), name: input.name, email, passwordHash: input.passwordHash, createdAt: clock() };
        users.set(user.id, user);
        return copy(publicUser(user));
      },
      async findByEmail(email) {
        const found = [...users.values()].find((u) => u.email === email.trim().toLowerCase());
        return found ? copy(found) : null;
      },
      async findById(id) {
        const found = users.get(id);
        return found ? copy(publicUser(found)) : null;
      },
    },

    businessProfiles: {
      async create(input) {
        const profile: BusinessProfile = { ...copy(input), id: randomUUID(), createdAt: clock() };
        profiles.push(profile);
        return copy(profile);
      },
      async findPrimaryCompany(userId) {
        const found = profiles
          .filter((p) => p.userId === userId && p.kind === 'existing_company')
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
        return found ? copy(found) : null;
      },
      async getById(userId, id) {
        const found = profiles.find((p) => p.id === id && p.userId === userId);
        return found ? copy(found) : null;
      },
    },

    services: {
      async upsert(input) {
        const existing = services.get(input.slug);
        const record: ServiceRecord = { ...copy(input), id: existing?.id ?? randomUUID() };
        services.set(input.slug, record);
        return copy(record);
      },
      async list() {
        return copy([...services.values()].sort((a, b) => a.name.localeCompare(b.name)));
      },
      async findByIdOrSlug(value) {
        const found = [...services.values()].find((s) => s.id === value || s.slug === value);
        return found ? copy(found) : null;
      },
    },

    conversations: {
      async create(input) {
        const now = clock();
        const record: ConversationRecord = {
          id: randomUUID(),
          userId: input.userId,
          title: input.title,
          workflow: copy(input.workflow),
          quickReplies: [...(input.quickReplies ?? [])],
          status: 'active',
          lastMessageAt: now,
          createdAt: now,
        };
        conversations.push(record);
        return copy(record);
      },
      async list(userId, limit) {
        return copy(
          // Reversed first so records with equal timestamps come back newest first, like the database.
          [...conversations]
            .reverse()
            .filter((c) => c.userId === userId)
            .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())
            .slice(0, limit),
        );
      },
      async get(userId, id) {
        const found = conversations.find((c) => c.id === id && c.userId === userId);
        return found ? copy(found) : null;
      },
      async update(userId, id, patch) {
        const found = conversations.find((c) => c.id === id && c.userId === userId);
        if (!found) return null;
        if (patch.title !== undefined) found.title = patch.title;
        if (patch.workflow !== undefined) found.workflow = copy(patch.workflow);
        if (patch.quickReplies !== undefined) found.quickReplies = [...patch.quickReplies];
        if (patch.lastMessageAt !== undefined) found.lastMessageAt = patch.lastMessageAt;
        return copy(found);
      },
    },

    messages: {
      async append(input) {
        const record: MessageRecord = { ...copy(input), id: randomUUID(), createdAt: clock() };
        messages.push(record);
        return copy(record);
      },
      async list(userId, conversationId, limit) {
        const mine = messages.filter((m) => m.userId === userId && m.conversationId === conversationId);
        return copy(mine.slice(Math.max(0, mine.length - limit)));
      },
      async count(userId, conversationId) {
        return messages.filter((m) => m.userId === userId && m.conversationId === conversationId).length;
      },
    },

    applications: {
      async create(input) {
        if (applications.some((a) => a.reference === input.reference)) throw new DuplicateError('reference');
        const record: ApplicationRecord = { ...copy(input), id: randomUUID(), createdAt: clock() };
        applications.push(record);
        return copy(record);
      },
      async findByReference(userId, reference) {
        const found = applications.find((a) => a.reference === reference && a.userId === userId);
        return found ? copy(found) : null;
      },
      async listByUser(userId, filter) {
        return copy(
          [...applications]
            .reverse()
            .filter((a) => a.userId === userId && (!filter?.statuses || filter.statuses.includes(a.status)))
            .sort((a, b) => b.lastEventAt.getTime() - a.lastEventAt.getTime() || b.createdAt.getTime() - a.createdAt.getTime()),
        );
      },
      async updateCache(userId, id, cache) {
        const found = applications.find((a) => a.id === id && a.userId === userId);
        if (!found) return;
        found.status = cache.status;
        found.lastEventAt = cache.lastEventAt;
      },
    },

    events: {
      async append({ applicationId, userId, event }) {
        const key = `${applicationId}|${eventUniqueKey(event)}`;
        if (eventKeys.has(key)) throw new DuplicateError('event');
        eventKeys.add(key);
        events.push({ applicationId, userId, event: copy(event) });
      },
      async listByApplication(applicationId) {
        return copy(events.filter((e) => e.applicationId === applicationId).map((e) => e.event));
      },
      async listByApplications(applicationIds) {
        const map = new Map<string, WorkflowEvent[]>(applicationIds.map((id) => [id, []]));
        for (const entry of events) map.get(entry.applicationId)?.push(copy(entry.event));
        return map;
      },
    },

    documents: {
      async create(input) {
        const now = clock();
        const record: DocumentRecord = { ...copy(input), id: randomUUID(), processingStatus: 'uploaded', aiStatus: 'not_requested', retryCount: 0, createdAt: now, updatedAt: now };
        documents.push(record);
        return copy(record);
      },
      async findById(userId, id) {
        const found = documents.find((d) => d.id === id && d.userId === userId && !d.deletedAt);
        return found ? copy(found) : null;
      },
      async findByIdForSystem(id) {
        const found = documents.find((d) => d.id === id && !d.deletedAt);
        return found ? copy(found) : null;
      },
      async listByUser(userId, limit) {
        return copy(
          [...documents]
            .reverse()
            .filter((d) => d.userId === userId && !d.deletedAt)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, limit),
        );
      },
      async query(userId, q) {
        const needle = q.search?.toLowerCase();
        const matching = [...documents]
          .reverse()
          .filter((d) => d.userId === userId && !d.deletedAt)
          .filter((d) => (q.status ? d.processingStatus === q.status : true))
          .filter((d) => (q.typeId ? d.typeId === q.typeId : true))
          .filter((d) => (q.applicationId ? d.applicationId === q.applicationId : true))
          .filter((d) => (needle ? d.originalName.toLowerCase().includes(needle) : true))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const start = (q.page - 1) * q.pageSize;
        return { items: copy(matching.slice(start, start + q.pageSize)), total: matching.length };
      },
      async listByApplication(userId, applicationId) {
        return copy([...documents].reverse().filter((d) => d.userId === userId && d.applicationId === applicationId && !d.deletedAt));
      },
      async countByUser(userId) {
        return documents.filter((d) => d.userId === userId && !d.deletedAt).length;
      },
      async update(id, patch) {
        const found = documents.find((d) => d.id === id && !d.deletedAt);
        if (!found) return null;
        if (patch.processingStatus !== undefined) found.processingStatus = patch.processingStatus;
        if (patch.aiStatus !== undefined) found.aiStatus = patch.aiStatus;
        if (patch.detectedType !== undefined) found.detectedType = patch.detectedType ?? undefined;
        if (patch.errorMessage !== undefined) found.errorMessage = patch.errorMessage ?? undefined;
        if (patch.retryCount !== undefined) found.retryCount = patch.retryCount;
        if (patch.processedAt !== undefined) found.processedAt = patch.processedAt ?? undefined;
        found.updatedAt = clock();
        return copy(found);
      },
      async markDeleted(userId, id) {
        const found = documents.find((d) => d.id === id && d.userId === userId && !d.deletedAt);
        if (!found) return null;
        found.deletedAt = clock();
        found.updatedAt = found.deletedAt;
        return copy(found);
      },
      async listDeleted(limit) {
        return copy(documents.filter((d) => d.deletedAt).slice(0, limit));
      },
      async findBySha256(userId, sha256) {
        const found = documents.find((d) => d.userId === userId && d.sha256 === sha256 && !d.deletedAt);
        return found ? copy(found) : null;
      },
      async listByStorageProvider(provider, limit) {
        return copy(documents.filter((d) => !d.deletedAt && d.storageProvider === provider).slice(0, limit));
      },
      async repointStorage(id, from, to, previous) {
        const found = documents.find((d) => d.id === id && !d.deletedAt);
        if (!found || found.storageProvider !== from.provider || found.storageKey !== from.key) return null;
        found.storageProvider = to.provider;
        found.storageKey = to.key;
        found.previousStorage = previous ?? undefined;
        found.updatedAt = clock();
        return copy(found);
      },
      async listByStatus(status, before, limit) {
        return copy(
          documents
            .filter((d) => !d.deletedAt && d.processingStatus === status && d.updatedAt.getTime() < before.getTime())
            .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
            .slice(0, limit),
        );
      },
      async removeRecord(id) {
        const index = documents.findIndex((d) => d.id === id);
        if (index === -1) return false;
        documents.splice(index, 1);
        return true;
      },
      async delete(userId, id) {
        const index = documents.findIndex((d) => d.id === id && d.userId === userId);
        if (index === -1) return false;
        documents.splice(index, 1);
        return true;
      },
    },

    extractions: {
      async save(input) {
        const now = clock();
        const existing = extractions.findIndex((e) => e.documentId === input.documentId);
        const record: ExtractionRecord = { ...copy(input), id: existing >= 0 ? extractions[existing]!.id : randomUUID(), createdAt: existing >= 0 ? extractions[existing]!.createdAt : now, updatedAt: now };
        if (existing >= 0) extractions[existing] = record;
        else extractions.push(record);
        return copy(record);
      },
      async findByDocument(userId, documentId) {
        const found = extractions.find((e) => e.documentId === documentId && e.userId === userId);
        return found ? copy(found) : null;
      },
      async findByDocumentForSystem(documentId) {
        const found = extractions.find((e) => e.documentId === documentId);
        return found ? copy(found) : null;
      },
      async setUnderstanding(documentId, patch) {
        const found = extractions.find((e) => e.documentId === documentId);
        if (!found) return null;
        found.structured = patch.structured === null ? null : copy(patch.structured);
        found.ai = copy(patch.ai);
        if (patch.detectedType !== undefined) found.detectedType = patch.detectedType;
        found.updatedAt = clock();
        return copy(found);
      },
      async deleteByDocument(documentId) {
        for (let i = extractions.length - 1; i >= 0; i -= 1) if (extractions[i]!.documentId === documentId) extractions.splice(i, 1);
        for (let i = chunks.length - 1; i >= 0; i -= 1) if (chunks[i]!.documentId === documentId) chunks.splice(i, 1);
      },
      async saveChunks(documentId, userId, items) {
        for (let i = chunks.length - 1; i >= 0; i -= 1) if (chunks[i]!.documentId === documentId) chunks.splice(i, 1);
        items.forEach((item, index) => chunks.push({ id: randomUUID(), documentId, userId, index, text: item.text, ...(item.page !== undefined ? { page: item.page } : {}) }));
      },
      async listChunks(userId, options) {
        const wanted = options.documentIds ? new Set(options.documentIds) : null;
        return copy(chunks.filter((c) => c.userId === userId && (!wanted || wanted.has(c.documentId))).slice(0, options.limit));
      },
      async listByUser(userId, limit) {
        return copy(
          extractions
            .filter((e) => e.userId === userId)
            .slice(0, limit)
            .map((e) => ({ documentId: e.documentId, detectedType: e.detectedType, confidence: e.confidence, structured: e.structured, ai: e.ai, pageCount: e.pageCount, textLength: e.textLength })),
        );
      },
    },

    jobs: {
      async enqueue(documentId, userId, { maxAttempts, now }) {
        const existing = jobs.find((j) => j.documentId === documentId);
        if (existing && (existing.status === 'queued' || existing.status === 'processing' || existing.status === 'retrying')) {
          return { job: copy(existing), created: false };
        }
        if (existing) {
          existing.status = 'queued';
          existing.attempts = 0;
          existing.maxAttempts = maxAttempts;
          existing.runAfter = now;
          existing.lockToken = undefined;
          existing.lockedUntil = undefined;
          existing.lastError = undefined;
          existing.history.push({ at: now, status: 'requeued', note: 'Queued again' });
          existing.history = existing.history.slice(-30);
          existing.updatedAt = now;
          return { job: copy(existing), created: false };
        }
        const job: JobRecord = {
          id: randomUUID(),
          documentId,
          userId,
          status: 'queued',
          attempts: 0,
          maxAttempts,
          runAfter: now,
          history: [{ at: now, status: 'queued', note: 'Queued' }],
          createdAt: now,
          updatedAt: now,
        };
        jobs.push(job);
        return { job: copy(job), created: true };
      },
      async claim(token, leaseMs, now) {
        const due = jobs
          .filter((j) => ((j.status === 'queued' || j.status === 'retrying') && j.runAfter.getTime() <= now.getTime()) || (j.status === 'processing' && (j.lockedUntil?.getTime() ?? 0) < now.getTime()))
          .sort((a, b) => a.runAfter.getTime() - b.runAfter.getTime());
        const job = due[0];
        if (!job) return null;
        job.status = 'processing';
        job.attempts += 1;
        job.lockToken = token;
        job.lockedUntil = new Date(now.getTime() + leaseMs);
        job.history.push({ at: now, status: 'processing', note: `Attempt ${job.attempts}` });
        job.history = job.history.slice(-30);
        job.updatedAt = now;
        return copy(job);
      },
      async complete(id, token, now, note) {
        const job = jobs.find((j) => j.id === id && j.lockToken === token && j.status === 'processing');
        if (!job) return false;
        job.status = 'completed';
        job.lockToken = undefined;
        job.lockedUntil = undefined;
        job.lastError = undefined;
        job.history.push({ at: now, status: 'completed', note });
        job.history = job.history.slice(-30);
        job.updatedAt = now;
        return true;
      },
      async fail(id, token, now, error, retryAt) {
        const job = jobs.find((j) => j.id === id && j.lockToken === token && j.status === 'processing');
        if (!job) return null;
        const retry = retryAt !== undefined && job.attempts < job.maxAttempts;
        job.status = retry ? 'retrying' : 'failed';
        if (retry) job.runAfter = retryAt;
        job.lockToken = undefined;
        job.lockedUntil = undefined;
        job.lastError = error;
        job.history.push({ at: now, status: job.status, note: error });
        job.history = job.history.slice(-30);
        job.updatedAt = now;
        return copy(job);
      },
      async findByDocument(documentId) {
        const found = jobs.find((j) => j.documentId === documentId);
        return found ? copy(found) : null;
      },
      async listRecoverable(now, limit) {
        return copy(
          jobs
            .filter((j) => j.status === 'queued' || j.status === 'retrying' || (j.status === 'processing' && (j.lockedUntil?.getTime() ?? 0) < now.getTime()))
            .sort((a, b) => a.runAfter.getTime() - b.runAfter.getTime())
            .slice(0, limit),
        );
      },
      async deleteByDocument(documentId) {
        for (let i = jobs.length - 1; i >= 0; i -= 1) if (jobs[i]!.documentId === documentId) jobs.splice(i, 1);
      },
    },
  };
}
