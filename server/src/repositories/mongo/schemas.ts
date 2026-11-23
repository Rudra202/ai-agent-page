import { APPLICATION_STATUSES, EVENT_ACTORS, EVENT_KINDS, WORKFLOW_TYPES } from '@tajir/shared';
import { Schema } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import { MESSAGE_KINDS } from '../../domain/entities.js';
import { AI_STATUSES, DOCUMENT_STATUSES, EXTRACTION_METHODS, JOB_STATUSES } from '../../domain/documents.js';

/**
 * Mongoose schemas for the collections (documents, extractions, chunks and jobs were added for document intelligence). Application status, progress and
 * requirements are NOT modelled as stored truth: they are derived from the
 * ApplicationEvent collection. `Application.status` is only a cache for filtering.
 */

const objectId = Schema.Types.ObjectId;

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 100 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    // Never returned unless asked for explicitly.
    passwordHash: { type: String, required: true, select: false },
  },
  { timestamps: true },
);
userSchema.index({ email: 1 }, { unique: true });

const businessProfileSchema = new Schema(
  {
    userId: { type: objectId, ref: 'User', required: true },
    kind: { type: String, enum: ['existing_company', 'new_company'], required: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    registrationType: { type: String, enum: ['mainland', 'free_zone', 'offshore'] },
    jurisdictionId: { type: String, maxlength: 64 },
    packageId: { type: String, maxlength: 96 },
    activity: { type: String, trim: true, maxlength: 80 },
    category: { type: String, trim: true, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 500 },
    shareholders: { type: Number, min: 1, max: 20 },
  },
  { timestamps: true },
);
businessProfileSchema.index({ userId: 1, kind: 1, createdAt: 1 });

const serviceSchema = new Schema(
  {
    slug: { type: String, enum: WORKFLOW_TYPES, required: true },
    type: { type: String, enum: WORKFLOW_TYPES, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, required: true, maxlength: 600 },
    steps: [new Schema({ kind: { type: String, required: true }, label: { type: String, required: true } }, { _id: false })],
    config: { type: Schema.Types.Mixed, default: {} },
    sample: { type: Boolean, default: true },
  },
  { timestamps: true },
);
serviceSchema.index({ slug: 1 }, { unique: true });

const conversationSchema = new Schema(
  {
    userId: { type: objectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    workflow: { type: Schema.Types.Mixed, required: true },
    quickReplies: { type: [String], default: [] },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    lastMessageAt: { type: Date, required: true },
  },
  { timestamps: true },
);
conversationSchema.index({ userId: 1, lastMessageAt: -1 });

const messageSchema = new Schema(
  {
    conversationId: { type: objectId, ref: 'Conversation', required: true },
    userId: { type: objectId, ref: 'User', required: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    kind: { type: String, enum: MESSAGE_KINDS, required: true },
    text: { type: String, maxlength: 2000 },
    payload: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);
messageSchema.index({ conversationId: 1, createdAt: 1, _id: 1 });

const applicationSchema = new Schema(
  {
    userId: { type: objectId, ref: 'User', required: true },
    reference: { type: String, required: true, match: /^(REG|FIN)-\d{4}-\d{6}$/ },
    service: { type: String, enum: WORKFLOW_TYPES, required: true },
    serviceId: { type: objectId, ref: 'Service' },
    title: { type: String, required: true, maxlength: 120 },
    subtitle: { type: String, required: true, maxlength: 200 },
    details: [new Schema({ label: { type: String, required: true }, value: { type: String, required: true } }, { _id: false })],
    businessProfileId: { type: objectId, ref: 'BusinessProfile' },
    status: { type: String, enum: APPLICATION_STATUSES, required: true },
    lastEventAt: { type: Date, required: true },
  },
  { timestamps: true },
);
applicationSchema.index({ reference: 1 }, { unique: true });
applicationSchema.index({ userId: 1, status: 1, lastEventAt: -1 });
applicationSchema.index({ userId: 1, lastEventAt: -1 });

const applicationEventSchema = new Schema(
  {
    applicationId: { type: objectId, ref: 'Application', required: true },
    userId: { type: objectId, ref: 'User', required: true },
    eventId: { type: String, required: true },
    /** Natural key: one milestone once, one requirement request once, one provision once. */
    uniqueKey: { type: String, required: true },
    kind: { type: String, enum: EVENT_KINDS, required: true },
    actor: { type: String, enum: EVENT_ACTORS, required: true },
    title: { type: String, required: true, maxlength: 200 },
    detail: { type: String, maxlength: 400 },
    requirement: new Schema(
      {
        id: { type: String, required: true },
        label: { type: String, required: true },
        kind: { type: String, enum: ['document', 'information'], required: true },
        docTypeId: { type: String },
      },
      { _id: false },
    ),
    requirementId: { type: String },
    value: { type: String, maxlength: 400 },
    at: { type: Date, required: true },
  },
  { timestamps: true },
);
// The database, not the application, guarantees a step cannot be recorded twice even under concurrent requests.
applicationEventSchema.index({ applicationId: 1, uniqueKey: 1 }, { unique: true });
applicationEventSchema.index({ applicationId: 1, at: 1, _id: 1 });

const documentSchema = new Schema(
  {
    userId: { type: objectId, ref: 'User', required: true },
    applicationId: { type: objectId, ref: 'Application' },
    requirementId: { type: String, maxlength: 96 },
    typeId: { type: String, required: true, maxlength: 64 },
    originalName: { type: String, required: true, maxlength: 120 },
    mimeType: { type: String, required: true, enum: ['application/pdf', 'image/png', 'image/jpeg'] },
    sizeBytes: { type: Number, required: true, min: 1 },
    sha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    storageKey: { type: String, required: true, maxlength: 200 },
    storageProvider: { type: String, required: true, maxlength: 20 },
    businessProfileId: { type: objectId, ref: 'BusinessProfile' },
    previousStorage: new Schema({ provider: { type: String, maxlength: 20 }, key: { type: String, maxlength: 200 } }, { _id: false }),
    processingStatus: { type: String, enum: DOCUMENT_STATUSES, default: 'uploaded' },
    aiStatus: { type: String, enum: AI_STATUSES, default: 'not_requested' },
    detectedType: { type: String, maxlength: 64 },
    errorMessage: { type: String, maxlength: 300 },
    retryCount: { type: Number, default: 0, min: 0 },
    processedAt: { type: Date },
    // A document the user deleted stays hidden until its file and records are cleaned up.
    deletedAt: { type: Date },
  },
  { timestamps: true },
);
documentSchema.index({ userId: 1, createdAt: -1 });
documentSchema.index({ applicationId: 1 });
documentSchema.index({ userId: 1, sha256: 1 });
documentSchema.index({ userId: 1, processingStatus: 1, createdAt: -1 });
documentSchema.index({ deletedAt: 1 }, { sparse: true });

const extractedDocumentSchema = new Schema(
  {
    documentId: { type: objectId, ref: 'Document', required: true },
    userId: { type: objectId, ref: 'User', required: true },
    sourceSha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    text: { type: String, default: '' },
    textLength: { type: Number, required: true, min: 0 },
    truncated: { type: Boolean, default: false },
    pageCount: { type: Number, min: 0 },
    method: { type: String, enum: EXTRACTION_METHODS, required: true },
    detectedType: { type: String, required: true, maxlength: 64 },
    confidence: { type: String, enum: ['high', 'medium', 'low'], required: true },
    structured: { type: Schema.Types.Mixed, default: null },
    ai: {
      status: { type: String, enum: AI_STATUSES, required: true },
      provider: { type: String, maxlength: 40 },
      model: { type: String, maxlength: 80 },
      error: { type: String, maxlength: 300 },
      at: { type: Date },
    },
  },
  { timestamps: true },
);
extractedDocumentSchema.index({ documentId: 1 }, { unique: true });
extractedDocumentSchema.index({ userId: 1, createdAt: -1 });

const documentChunkSchema = new Schema(
  {
    documentId: { type: objectId, ref: 'Document', required: true },
    userId: { type: objectId, ref: 'User', required: true },
    index: { type: Number, required: true, min: 0 },
    text: { type: String, required: true },
    page: { type: Number, min: 1 },
  },
  { timestamps: false },
);
documentChunkSchema.index({ userId: 1, documentId: 1, index: 1 });
documentChunkSchema.index({ documentId: 1, index: 1 }, { unique: true });

const processingJobSchema = new Schema(
  {
    documentId: { type: objectId, ref: 'Document', required: true },
    userId: { type: objectId, ref: 'User', required: true },
    status: { type: String, enum: JOB_STATUSES, required: true },
    attempts: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, required: true, min: 1 },
    runAfter: { type: Date, required: true },
    lockToken: { type: String, maxlength: 80 },
    lockedUntil: { type: Date },
    lastError: { type: String, maxlength: 300 },
    history: [
      new Schema(
        {
          at: { type: Date, required: true },
          status: { type: String, required: true },
          note: { type: String, maxlength: 300 },
        },
        { _id: false },
      ),
    ],
  },
  { timestamps: true },
);
// One job record per document: this is what makes a second upload or a double click on "reprocess" harmless.
processingJobSchema.index({ documentId: 1 }, { unique: true });
processingJobSchema.index({ status: 1, runAfter: 1 });
processingJobSchema.index({ status: 1, lockedUntil: 1 });

// The repositories map every result into typed entities, so the models are left loosely typed here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;

export interface MongoModels {
  User: AnyModel;
  BusinessProfile: AnyModel;
  Service: AnyModel;
  Conversation: AnyModel;
  Message: AnyModel;
  Application: AnyModel;
  ApplicationEvent: AnyModel;
  Document: AnyModel;
  ExtractedDocument: AnyModel;
  DocumentChunk: AnyModel;
  DocumentProcessingJob: AnyModel;
}

function register(connection: Connection, name: string, schema: Schema): AnyModel {
  return (connection.models[name] as AnyModel | undefined) ?? (connection.model(name, schema) as AnyModel);
}

/** Registers the models on a specific connection, so tests can use an isolated database. */
export function registerModels(connection: Connection): MongoModels {
  return {
    User: register(connection, 'User', userSchema),
    BusinessProfile: register(connection, 'BusinessProfile', businessProfileSchema),
    Service: register(connection, 'Service', serviceSchema),
    Conversation: register(connection, 'Conversation', conversationSchema),
    Message: register(connection, 'Message', messageSchema),
    Application: register(connection, 'Application', applicationSchema),
    ApplicationEvent: register(connection, 'ApplicationEvent', applicationEventSchema),
    Document: register(connection, 'Document', documentSchema),
    ExtractedDocument: register(connection, 'ExtractedDocument', extractedDocumentSchema),
    DocumentChunk: register(connection, 'DocumentChunk', documentChunkSchema),
    DocumentProcessingJob: register(connection, 'DocumentProcessingJob', processingJobSchema),
  };
}
