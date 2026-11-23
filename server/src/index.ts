import http from 'node:http';
import path from 'node:path';
import { createApp, documentServiceOf } from './app.js';
import { createDocumentJobs } from './jobs/documentJobs.js';
import type { DocumentJobs } from './jobs/types.js';
import { createOcrEngine } from './extraction/ocr.js';
import type { OcrEngine } from './extraction/ocr.js';
import { createExtractionProcessor } from './extraction/pipeline.js';
import { createUnderstandingStep } from './understanding/understand.js';
import { createAiProvider } from './ai/factory.js';
import { connectMongo } from './config/db.js';
import { appConfigFromEnv, effectiveAiProviders, env, resolveMongoUri } from './config/env.js';
import { createMemoryRepositories } from './repositories/memory.js';
import { createMongoRepositories } from './repositories/mongo/index.js';
import type { Repositories } from './repositories/types.js';
import { seedServices } from './services/catalog.js';
import type { Connection } from 'mongoose';
import { createGridFsStorage } from './storage/gridfs.js';
import { createLocalStorage } from './storage/local.js';
import { createMemoryStorage } from './storage/memory.js';
import { waitingApp } from './waitingApp.js';
import type { StorageProvider } from './storage/types.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const config = appConfigFromEnv();
  const uri = resolveMongoUri(env);

  // Documents uploaded before GridFS are on local disk. They stay readable (and deletable) from there, whichever
  // storage new files go to. Nothing is ever moved or removed automatically; see scripts/migrate-documents-to-gridfs.
  const localStorage = createLocalStorage(path.resolve(process.cwd(), env.UPLOAD_DIR));

  if (!uri && env.NODE_ENV === 'production') {
    console.error('[db] MONGODB_URI (or user, password and host) is required in production.');
    process.exit(1);
  }

  const ai = createAiProvider(
    {
      providers: effectiveAiProviders(),
      geminiApiKey: env.GEMINI_API_KEY,
      geminiModel: env.GEMINI_MODEL,
      geminiFallbackModel: env.GEMINI_FALLBACK_MODEL,
      openaiApiKey: env.OPENAI_API_KEY,
      openaiModel: env.OPENAI_MODEL,
      timeoutMs: env.AI_TIMEOUT_MS,
      maxRetries: env.AI_MAX_RETRIES,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
    },
    // Provider events only: a code and an attempt number. No messages, no keys.
    (event) => console.warn('[ai]', JSON.stringify(event)),
  );
  if (ai.kind === 'llm') {
    const labels = (ai as { labels?: string[] }).labels ?? [ai.label ?? ai.name];
    console.log(`[ai] assistant: ${labels.map((label, i) => `${i === 0 ? 'first' : 'then'} ${label}`).join(', ')}; built-in rules if none can answer`);
  } else {
    // Say it loudly: without a key the chat can only follow the two guided flows and cannot answer general questions.
    console.warn('[ai] No AI key is configured, so the chat uses the built-in rules and cannot answer general questions.');
    console.warn('[ai] Set GEMINI_API_KEY (tried first) and/or OPENAI_API_KEY in server/.env to turn on the full assistant.');
  }

  // The server listens at once, so the website can always say what is wrong instead of just failing to load.
  let waitingReason = 'The server is starting and has not connected to its database yet. Please try again in a moment.';
  let handler: http.RequestListener = waitingApp(ai, env.STORAGE_PROVIDER, () => waitingReason);
  const server = http.createServer((req, res) => handler(req, res));
  server.listen(env.PORT, () => {
    console.log(`[server] listening on http://localhost:${env.PORT} (${env.NODE_ENV}, storage: ${env.STORAGE_PROVIDER})`);
  });

  let closeDb: () => Promise<void> = async () => undefined;
  let stopping = false;

  let sweepTimer: NodeJS.Timeout | undefined;
  let documentJobs: DocumentJobs | undefined;
  let ocr: OcrEngine | null = null;

  const goLive = async (repos: Repositories, dbMode: 'mongodb' | 'memory', connection?: Connection): Promise<void> => {
    await seedServices(repos);
    let storage: StorageProvider;
    let legacyStorage: StorageProvider[] = [];
    if (env.STORAGE_PROVIDER === 'gridfs' && connection) {
      storage = createGridFsStorage(connection);
      legacyStorage = [localStorage];
    } else if (env.STORAGE_PROVIDER === 'gridfs') {
      // No database means no GridFS, and the records are only in memory too, so the files are kept in memory as well:
      // nothing is left on disk that no record points to.
      storage = createMemoryStorage();
    } else {
      storage = localStorage;
    }
    console.log(`[storage] new files go to ${storage.name}${legacyStorage.length ? '; older files are read from local disk' : ''}`);

    // Reading documents: OCR is local (Tesseract), the queue is MongoDB.
    const ocrEnabled = env.DOCUMENT_OCR_ENABLED ?? true;
    ocr = ocrEnabled ? createOcrEngine({ size: env.DOCUMENT_WORKER_CONCURRENCY }) : null;
    console.log(`[documents] text recognition (OCR): ${ocrEnabled ? 'on (local)' : 'off'}`);
    const aiEnabled = env.DOCUMENT_AI_ENABLED ?? true;
    console.log(`[documents] AI reading: ${!aiEnabled ? 'off' : ai.kind === 'llm' ? 'on (document text, with ID and account numbers removed, is sent to the configured AI model)' : 'on, but no AI model is configured, so it is skipped'}`);
    const providers = [storage, ...legacyStorage];
    console.log('[queue] documents are queued in MongoDB and read by a worker in this server.');
    documentJobs = createDocumentJobs({
      repos,
      processor: createExtractionProcessor({
        repos,
        storageFor: (name) => providers.find((p) => p.name === name),
        ocr,
        maxBytes: config.maxUploadBytes,
        understand: createUnderstandingStep({ ai, repos, enabled: aiEnabled, log: (message) => console.warn(message) }),
        log: (message) => console.warn(message),
      }),
      concurrency: env.DOCUMENT_WORKER_CONCURRENCY,
      maxAttempts: env.DOCUMENT_JOB_ATTEMPTS,
      backoffMs: env.DOCUMENT_JOB_BACKOFF_MS,
      log: (message) => console.warn(message),
    });
    const app = createApp({
      repos,
      storage,
      legacyStorage,
      documentJobs,
      documentAiEnabled: env.DOCUMENT_AI_ENABLED ?? true,
      limits: env.API_RATE_LIMIT_MAX ? { api: env.API_RATE_LIMIT_MAX } : undefined,
      config,
      dbMode,
      ai,
      onAiTurn: (trace) => console.log('[ai-turn]', JSON.stringify({ mode: trace.mode, provider: trace.provider, skipped: trace.skipped, guard: trace.guard, restricted: trace.restricted, intent: trace.intent, fallback: trace.fallbackReason, effects: trace.effects, ms: trace.latencyMs })),
      logRequests: env.NODE_ENV !== 'test',
    });
    handler = app;

    // Finishes the removal of documents whose cleanup was interrupted (a crash, or storage that was briefly unreachable).
    const sweep = () =>
      documentServiceOf(app)
        .sweepDeleted()
        .then((done) => done > 0 && console.log(`[documents] finished removing ${done} deleted document(s)`))
        .catch((error: unknown) => console.warn('[documents] cleanup sweep failed:', error instanceof Error ? error.message : String(error)));
    void sweep();
    sweepTimer = setInterval(sweep, 10 * 60_000);
    sweepTimer.unref();
    await documentJobs.start();
    console.log(`[server] ready (db: ${dbMode})`);
  };

  if (!uri) {
    // Only when no database is configured at all, never as a fallback for a database that cannot be reached.
    console.warn('[db] No MongoDB settings found. Using an in-memory store: all data is lost when the server stops.');
    await goLive(createMemoryRepositories(), 'memory');
  } else {
    // Keep trying. The cause is usually this computer's IP address missing from Atlas Network Access,
    // which the user fixes in the Atlas console, and the server recovers on its own once that is done.
    const connectWithRetry = async (): Promise<void> => {
      for (let attempt = 1; !stopping; attempt += 1) {
        try {
          const connection = await connectMongo(uri, env.MONGODB_DB_NAME);
          const mongo = createMongoRepositories(connection);
          await mongo.ensureIndexes();
          closeDb = () => connection.close();
          console.log(`[db] connected to MongoDB database "${env.MONGODB_DB_NAME}"`);
          await goLive(mongo.repositories, 'mongodb', connection);
          return;
        } catch (error) {
          // The driver's message names hosts, never the password.
          console.error(`[db] could not connect to MongoDB (attempt ${attempt}):`, error instanceof Error ? error.message.split('\n')[0] : String(error));
          console.error('[db] Check the credentials in server/.env, and that this computer is allowed in Atlas > Network Access. Retrying.');
          waitingReason =
            env.NODE_ENV === 'production'
              ? 'The service is temporarily unavailable. Please try again shortly.'
              : 'The database is not connected. MongoDB Atlas is refusing this computer, so its IP address probably has to be added under Atlas > Network Access (or the database password in server/.env is out of date). The server keeps trying and will recover by itself.';
          await sleep(Math.min(3_000 * attempt, 20_000));
        }
      }
    };
    void connectWithRetry();
  }

  const shutdown = async (): Promise<void> => {
    stopping = true;
    if (sweepTimer) clearInterval(sweepTimer);
    server.close();
    await documentJobs?.stop().catch(() => undefined);
    await ocr?.close().catch(() => undefined);
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
