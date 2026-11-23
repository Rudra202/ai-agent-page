/**
 * Records for the document system. Plain data shapes, no MongoDB in them.
 *
 * - A document is the uploaded file's metadata. The bytes live in storage (GridFS) and are never in a record.
 * - An extraction is what was read from it (text, and what AI understood), kept separate so it can be redone.
 * - Chunks are the text split into small pieces that chat can search without loading whole documents.
 * - A job is the persistent record of "this document must be processed". It survives restarts: it lives in MongoDB.
 */

/** Where a document is in processing. "completed" is only ever used when text was really extracted. */
export const DOCUMENT_STATUSES = ['uploaded', 'queued', 'processing', 'retrying', 'completed', 'partially_completed', 'failed'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** How the AI understanding step went. It is optional: extraction and OCR work without it. */
export const AI_STATUSES = ['not_requested', 'pending', 'completed', 'skipped', 'unavailable', 'failed'] as const;
export type AiStatus = (typeof AI_STATUSES)[number];

export const EXTRACTION_METHODS = ['pdf_text', 'ocr', 'pdf_ocr'] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

export type Confidence = 'high' | 'medium' | 'low';

/** Statuses in which work is still going on or waiting. */
export const ACTIVE_STATUSES: readonly DocumentStatus[] = ['uploaded', 'queued', 'processing', 'retrying'];

export interface ExtractionRecord {
  id: string;
  documentId: string;
  userId: string;
  /** The SHA-256 of the file this was read from, so the same file is never read twice. */
  sourceSha256: string;
  /** The cleaned text, capped. Sensitive: never logged. */
  text: string;
  /** Length before the cap. */
  textLength: number;
  truncated: boolean;
  pageCount?: number;
  method: ExtractionMethod;
  detectedType: string;
  confidence: Confidence;
  /** What AI understood. Validated before it is stored. Null until the AI step has run. */
  structured: Record<string, unknown> | null;
  ai: { status: AiStatus; provider?: string; model?: string; error?: string; at?: Date };
  createdAt: Date;
  updatedAt: Date;
}

export interface ChunkRecord {
  id: string;
  documentId: string;
  userId: string;
  index: number;
  text: string;
  page?: number;
}

export const JOB_STATUSES = ['queued', 'processing', 'retrying', 'completed', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobHistoryEntry {
  at: Date;
  status: JobStatus | 'requeued';
  /** A short, safe note. Never document content. */
  note: string;
}

export interface JobRecord {
  id: string;
  documentId: string;
  userId: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  /** Not before this time. Used for retry back-off. */
  runAfter: Date;
  /** Proves which worker holds the job, and until when. A job whose lease ran out can be taken again. */
  lockToken?: string;
  lockedUntil?: Date;
  lastError?: string;
  history: JobHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}
