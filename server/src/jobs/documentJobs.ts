import { randomUUID } from 'node:crypto';
import type { JobRecord } from '../domain/documents.js';
import type { DocumentRecord } from '../domain/entities.js';
import type { Repositories } from '../repositories/types.js';
import { createSemaphore } from './semaphore.js';
import { PermanentJobError, RetryableJobError } from './types.js';
import type { DocumentJobs, DocumentProcessor, QueueHealth } from './types.js';

export interface DocumentJobsDeps {
  repos: Repositories;
  processor: DocumentProcessor;
  clock?: () => Date;
  newToken?: () => string;
  /** How many documents are processed at the same time in this process. */
  concurrency?: number;
  maxAttempts?: number;
  /** First retry delay. It doubles each time, up to five minutes. */
  backoffMs?: number;
  /** How long a worker may hold a job before another may take it (the worker died). Must be longer than `jobTimeoutMs`. */
  leaseMs?: number;
  /** The longest one run may take. */
  jobTimeoutMs?: number;
  /** How often MongoDB is checked for jobs that are due (retries, and anything not started at once). */
  pollMs?: number;
  /** How often stuck work is looked for. */
  recoverMs?: number;
  /** An upload that has been "uploaded" for this long without a job is queued by the recovery sweep. */
  stuckAfterMs?: number;
  /** Receives short operational messages. They never contain document content, names, text or keys. */
  log?: (message: string) => void;
}

const GENERIC_FAILURE = 'Processing failed. You can try again.';
const MAX_BACKOFF_MS = 5 * 60_000;

export function createDocumentJobs(deps: DocumentJobsDeps): DocumentJobs {
  const { repos, processor } = deps;
  const clock = deps.clock ?? (() => new Date());
  const newToken = deps.newToken ?? randomUUID;
  const concurrency = deps.concurrency ?? 2;
  const maxAttempts = deps.maxAttempts ?? 3;
  const backoffMs = deps.backoffMs ?? 5_000;
  const jobTimeoutMs = deps.jobTimeoutMs ?? 4 * 60_000;
  const leaseMs = Math.max(deps.leaseMs ?? 10 * 60_000, jobTimeoutMs + 30_000);
  const pollMs = deps.pollMs ?? 3_000;
  const recoverMs = deps.recoverMs ?? 60_000;
  const stuckAfterMs = deps.stuckAfterMs ?? 30_000;
  const log = deps.log ?? ((message: string) => console.warn(message));

  const slots = createSemaphore(concurrency);
  let stopped = true;
  let pollTimer: NodeJS.Timeout | undefined;
  let recoverTimer: NodeJS.Timeout | undefined;
  const running = new Set<Promise<void>>();

  const backoffFor = (attempt: number): number => Math.min(backoffMs * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);

  /**
   * Starts work on a new job straight away instead of waiting for the next check of MongoDB. Not needed for
   * correctness: the job is already in MongoDB and the poller would find it.
   */
  function kick(): void {
    if (stopped) return;
    setImmediate(() => {
      drain().catch((error: unknown) => log(`[queue] starting a job failed (${kindOf(error)})`));
    });
  }

  const safeMessage = (error: unknown): string =>
    error instanceof PermanentJobError || error instanceof RetryableJobError ? error.userMessage : GENERIC_FAILURE;

  /** Never the message itself: that can hold content or paths. The kind of failure is enough. */
  const kindOf = (error: unknown): string => (error instanceof Error ? error.name : 'Error');

  async function finishDeleted(job: JobRecord, token: string): Promise<void> {
    // The user deleted the document while it was being processed. Whatever was read from it must go too.
    await repos.extractions.deleteByDocument(job.documentId);
    await repos.jobs.complete(job.id, token, clock(), 'Document was deleted');
  }

  async function fail(job: JobRecord, token: string, error: unknown): Promise<void> {
    const permanent = error instanceof PermanentJobError;
    const message = safeMessage(error);
    const now = clock();
    const retryAt = permanent ? undefined : new Date(now.getTime() + backoffFor(job.attempts));
    const result = await repos.jobs.fail(job.id, token, now, message, retryAt);
    // null: this worker no longer holds the job (it was taken over), so it is not this worker's to report.
    if (!result) return;
    if (result.status === 'retrying') {
      await repos.documents.update(job.documentId, { processingStatus: 'retrying', errorMessage: `${message} Trying again shortly.`, retryCount: job.attempts });
      log(`[queue] job ${job.id} will retry (attempt ${job.attempts} of ${job.maxAttempts}, ${kindOf(error)})`);
    } else {
      await repos.documents.update(job.documentId, { processingStatus: 'failed', errorMessage: message, retryCount: job.attempts, processedAt: null });
      log(`[queue] job ${job.id} failed (${kindOf(error)})`);
    }
  }

  /** Runs one claimed job. Never throws: every outcome is recorded. */
  async function execute(job: JobRecord, token: string): Promise<void> {
    const controller = new AbortController();
    try {
      const doc = await repos.documents.findByIdForSystem(job.documentId);
      if (!doc) return await finishDeleted(job, token);

      // A job whose workers keep dying (for example a file that crashes the process) must not be retried for ever.
      if (job.attempts > job.maxAttempts) {
        return await fail(job, token, new PermanentJobError('Processing was interrupted too many times. Please upload the file again or contact support.'));
      }

      await repos.documents.update(doc.id, { processingStatus: 'processing', retryCount: job.attempts - 1, errorMessage: null });

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new RetryableJobError('Processing took too long.'));
        }, jobTimeoutMs);
      });
      let result;
      try {
        result = await Promise.race([processor(doc, { signal: controller.signal, attempt: job.attempts, maxAttempts: job.maxAttempts }), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      // Deleted while it was being read: do not bring it back to life, and do not keep what was read.
      if (!(await repos.documents.findByIdForSystem(doc.id))) return await finishDeleted(job, token);

      await repos.documents.update(doc.id, {
        processingStatus: result.status,
        aiStatus: result.aiStatus,
        ...(result.detectedType ? { detectedType: result.detectedType } : {}),
        errorMessage: result.message ?? null,
        retryCount: job.attempts - 1,
        processedAt: clock(),
      });
      await repos.jobs.complete(job.id, token, clock(), result.status);
    } catch (error) {
      // A run that stopped because the time was up is a timeout, whatever the processor threw when it was told to stop.
      const cause = controller.signal.aborted ? new RetryableJobError('Processing took too long.') : error;
      try {
        await fail(job, token, cause);
      } catch (recordingError) {
        // Even recording the failure failed (the database is unreachable). The lease will run out and the job is taken again.
        log(`[queue] job ${job.id} could not be updated (${kindOf(recordingError)}); it will be retried when its lease ends`);
      }
    }
  }

  async function drain(): Promise<number> {
    let started = 0;
    const batch: Promise<void>[] = [];
    // Keep taking due jobs, a few at a time, until none is due. A place is waited for, never exceeded.
    for (;;) {
      await slots.acquire();
      let job: JobRecord | null;
      const token = newToken();
      try {
        job = await repos.jobs.claim(token, leaseMs, clock());
      } catch (error) {
        slots.release();
        await Promise.allSettled(batch);
        throw error;
      }
      if (!job) {
        slots.release();
        break;
      }
      started += 1;
      const run = execute(job, token).finally(() => {
        slots.release();
        running.delete(run);
      });
      running.add(run);
      batch.push(run);
    }
    await Promise.all(batch);
    return started;
  }

  async function enqueue(doc: DocumentRecord, options: { reset?: boolean } = {}): Promise<void> {
    const now = clock();
    await repos.jobs.enqueue(doc.id, doc.userId, { maxAttempts, now });
    // A document that is already being worked on keeps its state; only an idle one goes (back) to "queued".
    const current = await repos.documents.findByIdForSystem(doc.id);
    if (current && current.processingStatus !== 'processing' && current.processingStatus !== 'retrying' && current.processingStatus !== 'queued') {
      await repos.documents.update(doc.id, {
        processingStatus: 'queued',
        errorMessage: null,
        ...(options.reset ? { retryCount: 0, aiStatus: 'not_requested', processedAt: null } : {}),
      });
    }
    kick();
  }

  async function recover(): Promise<number> {
    const recovered = new Set<string>();
    const now = clock();
    // 1. Uploads that were saved but never got a job (the process stopped right after saving).
    for (const doc of await repos.documents.listByStatus('uploaded', new Date(now.getTime() - stuckAfterMs), 100)) {
      await enqueue(doc);
      recovered.add(doc.id);
    }
    return recovered.size;
  }

  const health = (): QueueHealth => ({ mode: 'database' });

  function schedulePoll(): void {
    if (stopped) return;
    pollTimer = setTimeout(() => {
      drain()
        .catch((error: unknown) => log(`[queue] polling the database failed (${kindOf(error)})`))
        .finally(schedulePoll);
    }, pollMs);
    pollTimer.unref();
  }

  return {
    enqueue,
    drain,
    recover,
    health,

    async start() {
      if (!stopped) return;
      stopped = false;
      schedulePoll();
      const sweep = () => recover().catch((error: unknown) => log(`[queue] recovery sweep failed (${kindOf(error)})`));
      void sweep();
      recoverTimer = setInterval(sweep, recoverMs);
      recoverTimer.unref();
    },

    async stop() {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (recoverTimer) clearInterval(recoverTimer);
      // Let what is running finish (its lease protects it if the process is killed first).
      await Promise.allSettled(running);
    },
  };
}
