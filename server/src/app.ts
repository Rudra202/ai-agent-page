import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import type { RequestHandler } from 'express';
import helmet from 'helmet';
import type { AppConfig } from './config/env.js';
import { createRequireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { originCheck } from './middleware/originCheck.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import type { Repositories } from './repositories/types.js';
import { applicationRoutes } from './routes/applications.js';
import { authRoutes } from './routes/auth.js';
import { conversationRoutes } from './routes/conversations.js';
import { documentRoutes } from './routes/documents.js';
import { healthRoutes } from './routes/health.js';
import { serviceRoutes } from './routes/services.js';
import { createApplicationService } from './services/applications.js';
import { createAuthService } from './services/auth.js';
import { createConversationService } from './services/conversations.js';
import { createDocumentAnswers } from './documentChat/answer.js';
import { createDocumentService } from './services/documents.js';
import type { DocumentService } from './services/documents.js';
import type { DocumentRecord } from './domain/entities.js';
import type { DocumentJobs } from './jobs/types.js';
import { createOrchestrator } from './services/orchestrator.js';
import type { Orchestrator, TurnTrace } from './services/orchestrator.js';
import { rulesProvider } from './ai/types.js';
import type { AiProvider } from './ai/types.js';
import type { StorageProvider } from './storage/types.js';

export interface AppDeps {
  repos: Repositories;
  /** Where new files are stored. */
  storage: StorageProvider;
  /** Where documents uploaded earlier may still live. Read and delete only. */
  legacyStorage?: StorageProvider[];
  /** Hands a newly recorded document to processing. Overrides `documentJobs` for new uploads (tests use this). */
  onDocumentUploaded?: (doc: DocumentRecord) => Promise<void>;
  /** The document job queue: new uploads are queued on it, and "reprocess" uses it. */
  documentJobs?: Pick<DocumentJobs, 'enqueue' | 'health'>;
  /** DOCUMENT_AI_ENABLED: whether a model may write answers about documents. Off means passages are quoted instead. */
  documentAiEnabled?: boolean;
  config: AppConfig;
  /** Which store is behind the repositories. Reported by the health endpoint. */
  dbMode: 'mongodb' | 'memory';
  /** The AI provider. Without one, the deterministic rules answer. */
  ai?: AiProvider;
  /** Receives one entry per chat turn: how it was handled, with no personal data. */
  onAiTurn?: (trace: TurnTrace) => void;
  orchestrator?: Orchestrator;
  clock?: () => Date;
  /** Request budgets per window. Tests lower these to exercise the limits. */
  limits?: { api?: number; login?: number; register?: number; upload?: number; download?: number };
  logRequests?: boolean;
}

const requestLogger: RequestHandler = (req, res, next) => {
  const started = Date.now();
  // Method, path and status only. Bodies, queries and cookies can hold secrets, so they are never logged.
  res.on('finish', () => console.log(`[http] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`));
  next();
};

export function createApp(deps: AppDeps): express.Express {
  const { repos, storage, config } = deps;
  const clock = deps.clock ?? (() => new Date());
  const limits = deps.limits ?? {};

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

  app.use(helmet());
  // An exact list: a page on any other origin gets no CORS headers at all, and cookies are only allowed for the listed ones.
  app.use(cors({ origin: config.clientOrigins, credentials: true }));
  if (deps.logRequests) app.use(requestLogger);
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(originCheck(config.clientOrigins, config.nodeEnv !== 'production'));

  const auth = createAuthService(repos, config);
  const requireAuth = createRequireAuth(auth, repos);

  const apiLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: limits.api ?? 1000, key: (req) => req.ip ?? 'unknown' });
  const loginLimiter = createRateLimiter({
    windowMs: 15 * 60_000,
    max: limits.login ?? 10,
    key: (req) => `${req.ip ?? 'unknown'}|${typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''}`,
    message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
  });
  const registerLimiter = createRateLimiter({
    windowMs: 60 * 60_000,
    max: limits.register ?? 10,
    key: (req) => req.ip ?? 'unknown',
    message: 'Too many sign-ups from this address. Please try again later.',
  });
  const uploadLimiter = createRateLimiter({
    windowMs: 60 * 60_000,
    max: limits.upload ?? 60,
    key: (req) => req.user?.id ?? req.ip ?? 'unknown',
    message: 'Too many uploads. Please try again later.',
  });

  const downloadLimiter = createRateLimiter({
    windowMs: 15 * 60_000,
    max: limits.download ?? 300,
    key: (req) => req.user?.id ?? req.ip ?? 'unknown',
    message: 'Too many downloads. Please try again in a few minutes.',
  });

  const applications = createApplicationService({ repos, config, clock });
  const documents = createDocumentService({ repos, storage, legacyStorage: deps.legacyStorage,
    applications,
    onUploaded: deps.onDocumentUploaded ?? (deps.documentJobs ? (doc) => deps.documentJobs!.enqueue(doc) : undefined),
    reprocess: deps.documentJobs ? (doc) => deps.documentJobs!.enqueue(doc, { reset: true }) : undefined,
  });
  app.locals.documents = documents;
  const ai = deps.ai ?? rulesProvider;
  const documentAnswers = createDocumentAnswers({ repos, ai, aiEnabled: deps.documentAiEnabled ?? true });
  const orchestrator = deps.orchestrator ?? createOrchestrator({ ai, applications, repos, clock, log: deps.onAiTurn, documentAnswers });
  const conversations = createConversationService({ repos, orchestrator, clock });

  app.use('/api/health', healthRoutes({ db: deps.dbMode, ai, storage: storage.name, queue: deps.documentJobs ? () => deps.documentJobs!.health() : undefined }));
  app.use('/api', apiLimiter);
  app.use('/api/auth', authRoutes({ auth, repos, config, requireAuth, loginLimiter, registerLimiter }));
  app.use('/api/services', serviceRoutes(repos, requireAuth));
  app.use('/api/applications', applicationRoutes(applications, documents, requireAuth));
  app.use('/api/documents', documentRoutes(documents, config, requireAuth, uploadLimiter, downloadLimiter));
  app.use('/api/conversations', conversationRoutes(conversations, requireAuth));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** The document service of an app made by `createApp`, for background work such as the cleanup sweep. */
export function documentServiceOf(app: express.Express): DocumentService {
  return app.locals.documents as DocumentService;
}
