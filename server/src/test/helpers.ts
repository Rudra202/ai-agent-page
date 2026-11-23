import type express from 'express';
import request from 'supertest';
import { createApp } from '../app.js';
import type { AppConfig } from '../config/env.js';
import { createMemoryRepositories } from '../repositories/memory.js';
import type { Repositories } from '../repositories/types.js';
import { seedServices } from '../services/catalog.js';
import type { AiProvider } from '../ai/types.js';
import type { Orchestrator, TurnTrace } from '../services/orchestrator.js';
import type { DocumentRecord } from '../domain/entities.js';
import type { DocumentJobs } from '../jobs/types.js';
import { createMemoryStorage } from '../storage/memory.js';
import type { MemoryStorage } from '../storage/memory.js';
import type { StorageProvider } from '../storage/types.js';

export const PASSWORD = 'correct horse battery';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    clientOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    jwtSecret: 'test-secret-test-secret-test-secret-12345',
    jwtExpiresIn: '7d',
    cookieSecure: false,
    bcryptRounds: 4,
    maxUploadBytes: 1024 * 1024,
    simulationEnabled: true,
    trustProxy: 0,
    uploadDir: 'uploads',
    ...overrides,
  };
}

export interface TestAppOptions {
  /** Use these repositories instead of the in-memory ones, for example the MongoDB ones in integration tests. */
  repos?: Repositories;
  config?: Partial<AppConfig>;
  limits?: { api?: number; login?: number; register?: number; upload?: number; download?: number };
  orchestrator?: Orchestrator;
  /** The AI provider. Leave out for the deterministic rules. */
  ai?: AiProvider;
  onAiTurn?: (trace: TurnTrace) => void;
  clock?: () => Date;
  /** Other storage that existing documents may still be on. */
  legacyStorage?: StorageProvider[];
  /** Called with every newly recorded document, as processing will be. */
  onDocumentUploaded?: (doc: DocumentRecord) => Promise<void>;
  /** The document job queue, as the real server wires it. */
  documentJobs?: Pick<DocumentJobs, 'enqueue' | 'health'>;
  /** Use this instead of the default in-memory storage. */
  storage?: MemoryStorage;
}

/** The whole API on in-memory repositories and storage. No database, no secrets, no network. */
export async function createTestApp(options: TestAppOptions = {}) {
  const repos = options.repos ?? createMemoryRepositories(options.clock);
  await seedServices(repos);
  const storage = options.storage ?? createMemoryStorage();
  const config = testConfig(options.config);
  const app = createApp({
    repos,
    storage,
    legacyStorage: options.legacyStorage,
    onDocumentUploaded: options.onDocumentUploaded,
    documentJobs: options.documentJobs,
    config,
    dbMode: options.repos ? 'mongodb' : 'memory',
    clock: options.clock,
    orchestrator: options.orchestrator,
    ai: options.ai,
    onAiTurn: options.onAiTurn,
    // High by default so ordinary tests never hit a limit. Tests that exercise a limit lower it.
    limits: { api: 100_000, login: 100_000, register: 100_000, upload: 100_000, download: 100_000, ...options.limits },
  });
  return { app, repos, storage, config };
}

export type TestAgent = ReturnType<typeof request.agent>;

export function agentFor(app: express.Express): TestAgent {
  return request.agent(app);
}

/** Registers a user and returns an agent holding that user's session cookie. */
export async function signUp(app: express.Express, email: string, extra: Record<string, unknown> = {}): Promise<TestAgent> {
  const agent = agentFor(app);
  await agent
    .post('/api/auth/register')
    .send({ name: 'Test User', email, password: PASSWORD, company: 'ABC Trading LLC', ...extra })
    .expect(201);
  return agent;
}

// ------------------------------------------------------------ file fixtures

export const pdf = (extra = '') => Buffer.from(`%PDF-1.4\n${extra}\n%%EOF`);
/** A real 1x1 PNG, so it passes the end-of-file check and can be decoded. */
export const png = () =>
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
export const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-body')]);
export const windowsProgram = () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 1)]);

export function upload(
  agent: TestAgent,
  file: { buffer: Buffer; filename: string } | null,
  fields: Record<string, string> = {},
) {
  const req = agent.post('/api/documents/upload');
  for (const [key, value] of Object.entries(fields)) req.field(key, value);
  if (file) req.attach('file', file.buffer, file.filename);
  return req;
}

// ------------------------------------------------------------ request bodies

export const companyBody = (overrides: Record<string, unknown> = {}) => ({
  service: 'company_registration',
  company: {
    registrationType: 'free_zone',
    jurisdictionId: 'shams',
    packageId: 'shams-starter',
    companyName: 'Vinith Media',
    activity: 'Media & Marketing',
    category: 'Media & Advertising',
    shareholders: 1,
    ...overrides,
  },
});

export const financeBody = (overrides: Record<string, unknown> = {}) => ({
  service: 'working_capital_finance',
  finance: { amount: 350000, purpose: 'Inventory', ...overrides },
});

/** Uploads the three documents a free zone registration needs, so the application can be submitted straight away. */
export async function uploadRequiredCompanyDocuments(agent: TestAgent): Promise<void> {
  for (const typeId of ['passport', 'emirates_id', 'proof_of_address']) {
    await upload(agent, { buffer: pdf(typeId), filename: `${typeId}.pdf` }, { typeId }).expect(201);
  }
}
