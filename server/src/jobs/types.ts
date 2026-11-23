import type { AiStatus } from '../domain/documents.js';
import type { DocumentRecord } from '../domain/entities.js';

/** What a finished processing run reports. "completed" is only for a document whose text was really read. */
export interface ProcessResult {
  status: 'completed' | 'partially_completed';
  aiStatus: AiStatus;
  detectedType?: string;
  /** A short, safe note for the user when only part of it worked (for example the AI step was unavailable). */
  message?: string;
}

export interface ProcessContext {
  /** Aborted when the run takes longer than allowed. Long work should stop when it fires. */
  signal: AbortSignal;
  /** 1 for the first try. */
  attempt: number;
  maxAttempts: number;
}

export type DocumentProcessor = (doc: DocumentRecord, context: ProcessContext) => Promise<ProcessResult>;

/** The file can never be processed (empty, unreadable, unsupported). Trying again would not help. */
export class PermanentJobError extends Error {
  /** Safe to show to the user. Never document content. */
  readonly userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = 'PermanentJobError';
    this.userMessage = userMessage;
  }
}

/** A failure that may pass on its own (a timeout, a service that is briefly down). It is tried again with a delay. */
export class RetryableJobError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = 'RetryableJobError';
    this.userMessage = userMessage;
  }
}

/** How documents are being processed. MongoDB is the only queue: jobs are stored there and a worker in the server takes them. */
export interface QueueHealth {
  mode: 'database';
}

export interface DocumentJobs {
  /**
   * Makes sure the document has a job and a "queued" status, and starts work on it. Safe to call twice: a document
   * that is already waiting or running keeps its one job. `reset` clears the earlier result (for reprocessing).
   */
  enqueue(doc: DocumentRecord, options?: { reset?: boolean }): Promise<void>;
  /** Runs every job that is due, with the configured concurrency, and returns how many were started. */
  drain(): Promise<number>;
  /** Finds work that got stuck (uploads that were saved but never queued) and queues it. */
  recover(): Promise<number>;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): QueueHealth;
}
