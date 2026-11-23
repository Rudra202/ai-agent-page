import { describe, expect, it } from 'vitest';
import type { DocumentRecord } from '../domain/entities.js';
import { createMemoryRepositories } from '../repositories/memory.js';
import type { Repositories } from '../repositories/types.js';
import { createDocumentJobs } from './documentJobs.js';
import type { DocumentJobsDeps } from './documentJobs.js';
import { PermanentJobError, RetryableJobError } from './types.js';
import type { DocumentProcessor } from './types.js';

const SECRET = 'PASSPORT-NUMBER-X1234567';

interface Harness {
  repos: Repositories;
  jobs: ReturnType<typeof createDocumentJobs>;
  logs: string[];
  now: () => Date;
  advance: (ms: number) => void;
  userId: string;
  upload: (name?: string) => Promise<DocumentRecord>;
}

async function setup(processor: DocumentProcessor, options: Partial<DocumentJobsDeps> = {}): Promise<Harness> {
  let current = new Date('2026-11-22T10:00:00Z');
  const now = () => new Date(current);
  const repos = createMemoryRepositories(now);
  const user = await repos.users.create({ name: 'A', email: 'a@example.com', passwordHash: 'x' });
  const logs: string[] = [];

  const jobs = createDocumentJobs({ repos, processor, clock: now, log: (m) => logs.push(m), backoffMs: 1_000, ...options });
  const upload = (name = 'passport.pdf') =>
    repos.documents.create({ userId: user.id, typeId: 'passport', originalName: name, mimeType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64), storageKey: `k-${name}-${Math.random()}`, storageProvider: 'gridfs' });
  return { repos, jobs, logs, now, advance: (ms) => (current = new Date(current.getTime() + ms)), userId: user.id, upload };
}

const ok: DocumentProcessor = async () => ({ status: 'completed', aiStatus: 'skipped', detectedType: 'passport' });

describe('queueing a document', () => {
  it('records a job and marks the document queued', async () => {
    const h = await setup(ok);
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    expect((await h.repos.documents.findByIdForSystem(doc.id))?.processingStatus).toBe('queued');
    expect(await h.repos.jobs.findByDocument(doc.id)).toMatchObject({ status: 'queued', attempts: 0, maxAttempts: 3 });
  });

  it('queues a document once, however many times it is asked for', async () => {
    let calls = 0;
    const h = await setup(async () => {
      calls += 1;
      return { status: 'completed', aiStatus: 'skipped' };
    });
    const doc = await h.upload();
    await Promise.all([h.jobs.enqueue(doc), h.jobs.enqueue(doc), h.jobs.enqueue(doc)]);
    await h.jobs.drain();
    await h.jobs.drain();
    expect(calls).toBe(1);
  });

  it('starts work at once when it is running, without waiting for the next check of the database', async () => {
    const h = await setup(ok, { pollMs: 1_000_000, recoverMs: 1_000_000 });
    await h.jobs.start();
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    for (let i = 0; i < 100 && (await h.repos.documents.findByIdForSystem(doc.id))?.processingStatus !== 'completed'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await h.repos.documents.findByIdForSystem(doc.id))?.processingStatus).toBe('completed');
    await h.jobs.stop();
  });

  it('does not start work on its own when it is not running (the database check does that later)', async () => {
    const h = await setup(ok);
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await h.repos.documents.findByIdForSystem(doc.id))?.processingStatus).toBe('queued');
  });

  it('says that MongoDB is the queue', async () => {
    expect((await setup(ok)).jobs.health()).toEqual({ mode: 'database' });
  });
});

describe('processing', () => {
  it('records a completed result with what was found', async () => {
    const h = await setup(ok);
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    expect(await h.jobs.drain()).toBe(1);
    const after = await h.repos.documents.findByIdForSystem(doc.id);
    expect(after).toMatchObject({ processingStatus: 'completed', aiStatus: 'skipped', detectedType: 'passport', retryCount: 0 });
    expect(after?.processedAt).toBeInstanceOf(Date);
    expect(after?.errorMessage).toBeUndefined();
    expect(await h.repos.jobs.findByDocument(doc.id)).toMatchObject({ status: 'completed', attempts: 1 });
  });

  it('records a partial result with its note', async () => {
    const h = await setup(async () => ({ status: 'partially_completed', aiStatus: 'unavailable', message: 'Text was read, but AI analysis was not available.' }));
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    await h.jobs.drain();
    expect(await h.repos.documents.findByIdForSystem(doc.id)).toMatchObject({ processingStatus: 'partially_completed', aiStatus: 'unavailable', errorMessage: 'Text was read, but AI analysis was not available.' });
  });

  it('shows "processing" while it works', async () => {
    let seen: string | undefined;
    const h = await setup(async (doc) => {
      seen = (await h.repos.documents.findByIdForSystem(doc.id))?.processingStatus;
      return { status: 'completed', aiStatus: 'skipped' };
    });
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    await h.jobs.drain();
    expect(seen).toBe('processing');
  });

  it('fails at once, without retrying, for a file that can never be read', async () => {
    let calls = 0;
    const h = await setup(async () => {
      calls += 1;
      throw new PermanentJobError('The file is empty or has no readable text.');
    });
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    await h.jobs.drain();
    h.advance(10 * 60_000);
    await h.jobs.drain();
    expect(calls).toBe(1);
    expect(await h.repos.documents.findByIdForSystem(doc.id)).toMatchObject({ processingStatus: 'failed', errorMessage: 'The file is empty or has no readable text.' });
    expect(await h.repos.jobs.findByDocument(doc.id)).toMatchObject({ status: 'failed' });
  });

  it('never stores or logs an unexpected error’s text, which could contain document content', async () => {
    const h = await setup(async () => {
      throw new Error(`could not parse: ${SECRET}`);
    });
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    await h.jobs.drain();
    const after = await h.repos.documents.findByIdForSystem(doc.id);
    const job = await h.repos.jobs.findByDocument(doc.id);
    expect(JSON.stringify([after, job, h.logs])).not.toContain(SECRET);
    expect(after?.errorMessage).toContain('Processing failed');
  });

  it('retries with a growing delay, then succeeds', async () => {
    let calls = 0;
    const h = await setup(async () => {
      calls += 1;
      if (calls < 3) throw new RetryableJobError('The text reader is busy.');
      return { status: 'completed', aiStatus: 'skipped' };
    });
    const doc = await h.upload();
    await h.jobs.enqueue(doc);

    await h.jobs.drain();
    expect(await h.repos.documents.findByIdForSystem(doc.id)).toMatchObject({ processingStatus: 'retrying', retryCount: 1 });
    expect((await h.repos.documents.findByIdForSystem(doc.id))?.errorMessage).toContain('The text reader is busy.');
    // Not before the delay (1 s for the first retry).
    expect(await h.jobs.drain()).toBe(0);
    h.advance(999);
    expect(await h.jobs.drain()).toBe(0);
    h.advance(1);
    await h.jobs.drain();
    expect(await h.repos.documents.findByIdForSystem(doc.id)).toMatchObject({ processingStatus: 'retrying', retryCount: 2 });
    // The second delay is twice as long.
    h.advance(1_999);
    expect(await h.jobs.drain()).toBe(0);
    h.advance(1);
    await h.jobs.drain();

    expect(calls).toBe(3);
    expect(await h.repos.documents.findByIdForSystem(doc.id)).toMatchObject({ processingStatus: 'completed', retryCount: 2 });
    expect((await h.repos.documents.findByIdForSystem(doc.id))?.errorMessage).toBeUndefined();
  });

  it('gives up after the allowed attempts and says so', async () => {
    let calls = 0;
    const h = await setup(async () => {
      calls += 1;
      throw new RetryableJobError('The text reader is busy.');
    }, { maxAttempts: 3 });
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    for (let i = 0; i < 6; i += 1) {
      await h.jobs.drain();
      h.advance(60_000);
    }
    expect(calls).toBe(3);
    expect(await h.repos.documents.findByIdForSystem(doc.id)).toMatchObject({ processingStatus: 'failed', errorMessage: 'The text reader is busy.', retryCount: 3 });
    expect((await h.repos.jobs.findByDocument(doc.id))?.history.map((x) => x.status)).toEqual(['queued', 'processing', 'retrying', 'processing', 'retrying', 'processing', 'failed']);
  });

  it('stops a run that takes too long, signals it, and retries', async () => {
    let aborted = false;
    const h = await setup(
      (_doc, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
      { jobTimeoutMs: 40 },
    );
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    await h.jobs.drain();
    expect(aborted).toBe(true);
    expect(await h.repos.documents.findByIdForSystem(doc.id)).toMatchObject({ processingStatus: 'retrying' });
    expect((await h.repos.documents.findByIdForSystem(doc.id))?.errorMessage).toContain('took too long');
  });
});

describe('workers that die', () => {
  it('lets another worker take over a job whose lease ran out', async () => {
    let calls = 0;
    const h = await setup(async () => {
      calls += 1;
      return { status: 'completed', aiStatus: 'skipped' };
    }, { leaseMs: 60_000, jobTimeoutMs: 1_000 });
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    // A worker takes the job and then dies without a word.
    expect(await h.repos.jobs.claim('dead-worker', 90_000, h.now())).not.toBeNull();
    await h.repos.documents.update(doc.id, { processingStatus: 'processing' });

    expect(await h.jobs.drain()).toBe(0);
    h.advance(91_000);
    expect(await h.jobs.drain()).toBe(1);
    expect(calls).toBe(1);
    expect((await h.repos.documents.findByIdForSystem(doc.id))?.processingStatus).toBe('completed');
    expect(await h.repos.jobs.findByDocument(doc.id)).toMatchObject({ status: 'completed', attempts: 2 });
  });

  it('stops retrying a file that keeps killing its worker', async () => {
    let calls = 0;
    const h = await setup(async () => {
      calls += 1;
      return { status: 'completed', aiStatus: 'skipped' };
    }, { maxAttempts: 2, leaseMs: 60_000, jobTimeoutMs: 1_000 });
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    for (let i = 0; i < 2; i += 1) {
      await h.repos.jobs.claim(`dead-${i}`, 60_000, h.now());
      h.advance(61_000);
    }
    await h.jobs.drain();
    expect(calls).toBe(0);
    expect(await h.repos.documents.findByIdForSystem(doc.id)).toMatchObject({ processingStatus: 'failed' });
    expect((await h.repos.documents.findByIdForSystem(doc.id))?.errorMessage).toContain('interrupted too many times');
  });
});

describe('running several at once', () => {
  it('never runs more than the allowed number at the same time, and finishes all', async () => {
    let active = 0;
    let peak = 0;
    const h = await setup(
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return { status: 'completed', aiStatus: 'skipped' };
      },
      { concurrency: 2 },
    );
    const docs = await Promise.all([1, 2, 3, 4, 5].map((n) => h.upload(`d${n}.pdf`)));
    for (const doc of docs) await h.jobs.enqueue(doc);
    await h.jobs.drain();
    expect(peak).toBe(2);
    for (const doc of docs) expect((await h.repos.documents.findByIdForSystem(doc.id))?.processingStatus).toBe('completed');
  });

  it('processes each document exactly once even when several workers look at the same time', async () => {
    const processed: string[] = [];
    const h = await setup(async (doc) => {
      processed.push(doc.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { status: 'completed', aiStatus: 'skipped' };
    }, { concurrency: 4 });
    const docs = await Promise.all([1, 2, 3, 4].map((n) => h.upload(`d${n}.pdf`)));
    for (const doc of docs) await h.jobs.enqueue(doc);
    await Promise.all([h.jobs.drain(), h.jobs.drain(), h.jobs.drain()]);
    expect(processed.sort()).toEqual(docs.map((d) => d.id).sort());
  });

  it('shares the same limit between the instant start and the database check', async () => {
    let active = 0;
    let peak = 0;
    const h = await setup(
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return { status: 'completed', aiStatus: 'skipped' };
      },
      { concurrency: 2, pollMs: 20, recoverMs: 1_000_000 },
    );
    await h.jobs.start();
    const docs = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => h.upload(`d${n}.pdf`)));
    for (const doc of docs) await h.jobs.enqueue(doc);
    await Promise.all([h.jobs.drain(), h.jobs.drain()]);
    for (let i = 0; i < 100; i += 1) {
      const states = await Promise.all(docs.map((d) => h.repos.documents.findByIdForSystem(d.id)));
      if (states.every((d) => d?.processingStatus === 'completed')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await h.jobs.stop();
    expect(peak).toBeLessThanOrEqual(2);
    for (const doc of docs) expect((await h.repos.documents.findByIdForSystem(doc.id))?.processingStatus).toBe('completed');
  });
});

describe('documents that are deleted', () => {
  it('does not process a document deleted before its turn', async () => {
    let calls = 0;
    const h = await setup(async () => {
      calls += 1;
      return { status: 'completed', aiStatus: 'skipped' };
    });
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    await h.repos.documents.markDeleted(h.userId, doc.id);
    await h.jobs.drain();
    expect(calls).toBe(0);
    expect(await h.repos.jobs.findByDocument(doc.id)).toMatchObject({ status: 'completed' });
  });

  it('does not bring back, or keep what was read from, a document deleted while it was being read', async () => {
    const h = await setup(async (doc) => {
      await h.repos.extractions.save({ documentId: doc.id, userId: doc.userId, sourceSha256: doc.sha256, text: SECRET, textLength: SECRET.length, truncated: false, method: 'pdf_text', detectedType: 'passport', confidence: 'high', structured: null, ai: { status: 'not_requested' } });
      await h.repos.extractions.saveChunks(doc.id, doc.userId, [{ text: SECRET }]);
      await h.repos.documents.markDeleted(doc.userId, doc.id);
      return { status: 'completed', aiStatus: 'skipped' };
    });
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    await h.jobs.drain();
    expect(await h.repos.documents.findByIdForSystem(doc.id)).toBeNull();
    expect(await h.repos.extractions.findByDocumentForSystem(doc.id)).toBeNull();
    expect(await h.repos.extractions.listChunks(h.userId, { limit: 10 })).toEqual([]);
    expect(await h.repos.jobs.findByDocument(doc.id)).toMatchObject({ status: 'completed' });
  });
});

describe('reprocessing', () => {
  it('queues a finished document again, as the same job, clearing the earlier result', async () => {
    let calls = 0;
    const h = await setup(async () => {
      calls += 1;
      return calls === 1 ? { status: 'partially_completed', aiStatus: 'failed', message: 'AI failed.' } : { status: 'completed', aiStatus: 'completed' };
    });
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    await h.jobs.drain();
    const firstJob = await h.repos.jobs.findByDocument(doc.id);

    await h.jobs.enqueue(doc, { reset: true });
    expect(await h.repos.documents.findByIdForSystem(doc.id)).toMatchObject({ processingStatus: 'queued', aiStatus: 'not_requested', retryCount: 0, processedAt: undefined, errorMessage: undefined });
    expect((await h.repos.jobs.findByDocument(doc.id))?.id).toBe(firstJob?.id);

    await h.jobs.drain();
    expect(calls).toBe(2);
    expect(await h.repos.documents.findByIdForSystem(doc.id)).toMatchObject({ processingStatus: 'completed', aiStatus: 'completed' });
  });

  it('leaves a document that is being processed alone', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const h = await setup(async () => {
      calls += 1;
      await gate;
      return { status: 'completed', aiStatus: 'skipped' };
    });
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    const running = h.jobs.drain();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await h.jobs.enqueue(doc, { reset: true });
    expect((await h.repos.documents.findByIdForSystem(doc.id))?.processingStatus).toBe('processing');
    release();
    await running;
    await h.jobs.drain();
    expect(calls).toBe(1);
  });
});

describe('recovering stuck work', () => {
  it('queues an upload that was saved but never got a job', async () => {
    const h = await setup(ok, { stuckAfterMs: 30_000 });
    const doc = await h.upload();
    expect(await h.jobs.recover()).toBe(0);
    h.advance(31_000);
    expect(await h.jobs.recover()).toBe(1);
    expect(await h.repos.jobs.findByDocument(doc.id)).toMatchObject({ status: 'queued' });
    await h.jobs.drain();
    expect((await h.repos.documents.findByIdForSystem(doc.id))?.processingStatus).toBe('completed');
  });

  it('picks up jobs by itself once started, and stops cleanly', async () => {
    const h = await setup(ok, { pollMs: 15, recoverMs: 1_000_000 });
    await h.jobs.start();
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    for (let i = 0; i < 100 && (await h.repos.documents.findByIdForSystem(doc.id))?.processingStatus !== 'completed'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await h.repos.documents.findByIdForSystem(doc.id))?.processingStatus).toBe('completed');
    await h.jobs.stop();
    const later = await h.upload('later.pdf');
    await h.jobs.enqueue(later);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await h.repos.documents.findByIdForSystem(later.id))?.processingStatus).toBe('queued');
  });

  it('survives a database error while polling and carries on', async () => {
    const h = await setup(ok, { pollMs: 15, recoverMs: 1_000_000 });
    const realClaim = h.repos.jobs.claim.bind(h.repos.jobs);
    let failures = 2;
    h.repos.jobs.claim = async (...args) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('connection lost');
      }
      return realClaim(...args);
    };
    await h.jobs.start();
    const doc = await h.upload();
    await h.jobs.enqueue(doc);
    for (let i = 0; i < 150 && (await h.repos.documents.findByIdForSystem(doc.id))?.processingStatus !== 'completed'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await h.jobs.stop();
    expect((await h.repos.documents.findByIdForSystem(doc.id))?.processingStatus).toBe('completed');
    expect(h.logs.some((l) => l.includes('polling the database failed'))).toBe(true);
  });
});
