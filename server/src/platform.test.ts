import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { appConfigFromEnv, parseDurationMs, resolveMongoUri } from './config/env.js';
import type { Env } from './config/env.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { buildServiceDefinitions, seedServices } from './services/catalog.js';
import { createMemoryRepositories } from './repositories/memory.js';
import { agentFor, createTestApp, signUp } from './test/helpers.js';

describe('health', () => {
  it('reports the mode without touching a database or leaking settings', async () => {
    const { app } = await createTestApp();
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'tajir-ai-server', db: 'memory', ai: 'rules', storage: 'memory' });
    expect(Object.keys(res.body).sort()).toEqual(['ai', 'aiBackup', 'db', 'service', 'status', 'storage', 'time']);
  });
});

describe('services catalogue', () => {
  it('lists both services, with their own steps, marked as sample data', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const { services } = (await agent.get('/api/services').expect(200)).body;
    expect(services.map((s: { slug: string }) => s.slug).sort()).toEqual(['company_registration', 'working_capital_finance']);
    for (const service of services) expect(service.sample).toBe(true);

    const company = services.find((s: { slug: string }) => s.slug === 'company_registration');
    const finance = services.find((s: { slug: string }) => s.slug === 'working_capital_finance');
    expect(company.steps.map((s: { kind: string }) => s.kind)).toContain('submitted');
    expect(finance.steps.map((s: { kind: string }) => s.kind)).not.toContain('submitted');
    expect(company.config.jurisdictions.length).toBeGreaterThan(0);
    expect(company.config.note).toContain('Not legal advice');
    expect(finance.config.note).toContain('does not offer, price or approve');
  });

  it('finds a service by slug or by id, and says when there is none', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const bySlug = (await agent.get('/api/services/company_registration').expect(200)).body.service;
    const byId = (await agent.get(`/api/services/${bySlug.id}`).expect(200)).body.service;
    expect(byId.slug).toBe('company_registration');
    await agent.get('/api/services/unknown').expect(404);
    await agent.get(`/api/services/${'x'.repeat(65)}`).expect(400);
  });

  it('can be seeded repeatedly without creating duplicates', async () => {
    const repos = createMemoryRepositories();
    await seedServices(repos);
    await seedServices(repos);
    expect(await repos.services.list()).toHaveLength(buildServiceDefinitions().length);
  });
});

describe('security behaviour', () => {
  it('sends hardening headers and does not advertise the framework', async () => {
    const { app } = await createTestApp();
    const res = await request(app).get('/api/health').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('only ever names the configured origin as allowed to read responses with credentials', async () => {
    const { app } = await createTestApp();
    const allowed = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    // A browser compares this header with the page's own origin, so a page on another origin cannot read the response.
    const other = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    // Another origin gets no CORS permission at all, so a browser will not let that page read the answer.
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await request(app).options('/api/applications').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(preflight.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  it('refuses a state-changing request that names a different origin, even with a valid session', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    await agent.post('/api/conversations').set('Origin', 'https://evil.example').send({}).expect(403);
    await agent.post('/api/conversations').set('Origin', 'http://localhost:5173').send({}).expect(201);
    await agent.get('/api/conversations').set('Origin', 'https://evil.example').expect(200);
    expect((await agent.get('/api/conversations')).body.conversations).toHaveLength(1);
  });

  it('answers malformed JSON and oversized bodies with clean errors', async () => {
    const { app } = await createTestApp();
    const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email": ').expect(400);
    expect(bad.body.error.message).toBe('The request body is not valid JSON.');
    const big = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(200_000) })).expect(413);
    expect(big.body.error.message).toBe('The request is too large.');
  });

  it('returns JSON for unknown routes', async () => {
    const { app } = await createTestApp();
    const res = await request(app).get('/api/nope').expect(404);
    expect(res.body.error.message).toContain('Route not found');
  });

  it('does not accept operator objects where a plain value is expected (NoSQL injection)', async () => {
    const { app } = await createTestApp();
    await signUp(app, 'victim@example.com');
    const agent = agentFor(app);
    await agent.post('/api/auth/login').send({ email: { $ne: null }, password: { $ne: null } }).expect(400);
    await agent.post('/api/auth/login').send({ email: 'victim@example.com', password: { $gt: '' } }).expect(400);
    await agent.post('/api/auth/register').send({ name: 'x', email: { $ne: '' }, password: 'a long enough password' }).expect(400);
  });

  it('hides internal details of unexpected failures in every environment', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app, repos } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    repos.conversations.list = async () => {
      throw new Error('connection string mongodb+srv://user:SECRET@host leaked');
    };
    const res = await agent.get('/api/conversations');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { message: 'Internal server error' } });
    // The cause is still logged for the operator.
    expect(error.mock.calls.flat().join(' ')).toContain('SECRET');
    error.mockRestore();
  });

  it('hides the message of unexpected failures completely in production', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { app, repos } = await createTestApp();
      const agent = await signUp(app, 'a@example.com');
      repos.conversations.list = async () => {
        throw new Error('sensitive');
      };
      const res = await agent.get('/api/conversations').expect(500);
      expect(res.body.error.message).toBe('Internal server error');
    } finally {
      process.env.NODE_ENV = previous;
      error.mockRestore();
    }
  });

  it('limits the overall request rate per address', async () => {
    const { app } = await createTestApp({ limits: { api: 3 } });
    const agent = agentFor(app);
    for (let i = 0; i < 3; i += 1) await agent.get('/api/auth/me').expect(401);
    await agent.get('/api/auth/me').expect(429);
    // Health is not rate limited, so monitoring keeps working.
    await agent.get('/api/health').expect(200);
  });

  it('limits sign-ups from one address', async () => {
    const { app } = await createTestApp({ limits: { register: 2 } });
    for (const n of [1, 2]) {
      await agentFor(app).post('/api/auth/register').send({ name: 'U', email: `u${n}@example.com`, password: 'a long enough password' }).expect(201);
    }
    await agentFor(app).post('/api/auth/register').send({ name: 'U', email: 'u3@example.com', password: 'a long enough password' }).expect(429);
  });
});

describe('rate limiter', () => {
  it('starts a fresh window once the old one has passed', async () => {
    let now = 1_000;
    const limiter = createRateLimiter({ windowMs: 1000, max: 2, key: () => 'k', now: () => now });
    const res = { setHeader: vi.fn() } as never;
    const call = () => limiter({} as never, res, vi.fn());
    call();
    call();
    expect(() => call()).toThrow();
    now += 1001;
    expect(() => call()).not.toThrow();
  });
});

describe('configuration', () => {
  const base = { MONGODB_URI: '', MONGODB_USER: '', MONGODB_PASSWORD: '', MONGODB_HOST: '', MONGODB_APP_NAME: 'tajir-ai' };

  it('builds the Atlas URI from its parts and encodes characters that would break it', () => {
    const uri = resolveMongoUri({ ...base, MONGODB_USER: 'app user', MONGODB_PASSWORD: 'p@ss:w/rd#1', MONGODB_HOST: 'cluster0.abc.mongodb.net' });
    expect(uri).toBe('mongodb+srv://app%20user:p%40ss%3Aw%2Frd%231@cluster0.abc.mongodb.net/?retryWrites=true&w=majority&appName=tajir-ai');
    expect(new URL(uri).password).toBe('p%40ss%3Aw%2Frd%231');
  });

  it('prefers a full URI, and returns nothing when the settings are incomplete', () => {
    expect(resolveMongoUri({ ...base, MONGODB_URI: 'mongodb://localhost:27017', MONGODB_USER: 'u', MONGODB_PASSWORD: 'p', MONGODB_HOST: 'h' })).toBe('mongodb://localhost:27017');
    expect(resolveMongoUri(base)).toBe('');
    expect(resolveMongoUri({ ...base, MONGODB_USER: 'u', MONGODB_PASSWORD: 'p' })).toBe('');
    expect(resolveMongoUri({ ...base, MONGODB_HOST: 'h', MONGODB_PASSWORD: 'p' })).toBe('');
  });

  it('parses durations and falls back safely', () => {
    expect(parseDurationMs('7d')).toBe(7 * 86_400_000);
    expect(parseDurationMs('12h')).toBe(12 * 3_600_000);
    expect(parseDurationMs('30m')).toBe(30 * 60_000);
    expect(parseDurationMs('45s')).toBe(45_000);
    expect(parseDurationMs('forever')).toBe(7 * 86_400_000);
  });

  const envFor = (nodeEnv: Env['NODE_ENV'], overrides: Partial<Env> = {}): Env =>
    ({
      PORT: 4000,
      NODE_ENV: nodeEnv,
      CLIENT_ORIGIN: 'http://localhost:5173',
      JWT_SECRET: 'x'.repeat(40),
      JWT_EXPIRES_IN: '7d',
      BCRYPT_ROUNDS: 12,
      MAX_UPLOAD_MB: 10,
      UPLOAD_DIR: 'uploads',
      TRUST_PROXY: 0,
      COOKIE_SECURE: undefined,
      SIMULATION_ENABLED: undefined,
      ...overrides,
    }) as Env;

  it('is strict by default in production: secure cookies, no simulation', () => {
    expect(appConfigFromEnv(envFor('production'))).toMatchObject({ cookieSecure: true, simulationEnabled: false });
    expect(appConfigFromEnv(envFor('development'))).toMatchObject({ cookieSecure: false, simulationEnabled: true });
  });

  it('honours explicit overrides and converts the upload limit to bytes', () => {
    expect(appConfigFromEnv(envFor('production', { COOKIE_SECURE: false, SIMULATION_ENABLED: true }))).toMatchObject({ cookieSecure: false, simulationEnabled: true });
    expect(appConfigFromEnv(envFor('development', { MAX_UPLOAD_MB: 2.5 })).maxUploadBytes).toBe(2_621_440);
  });
});

describe('document and server settings', () => {
  it('has no Redis setting: MongoDB is the only queue', async () => {
    const { envSchema } = await import('./config/env.js');
    expect(Object.keys(envSchema.shape)).not.toContain('REDIS_URL');
    expect(envSchema.parse({ REDIS_URL: 'redis://default:pw@host.example.com:12345' })).not.toHaveProperty('REDIS_URL');
  });

  it('keeps the worker settings in safe ranges', async () => {
    const { envSchema } = await import('./config/env.js');
    expect(envSchema.parse({})).toMatchObject({ DOCUMENT_WORKER_CONCURRENCY: 2, DOCUMENT_JOB_ATTEMPTS: 3, DOCUMENT_JOB_BACKOFF_MS: 5_000 });
    expect(envSchema.safeParse({ DOCUMENT_WORKER_CONCURRENCY: '0' }).success).toBe(false);
    expect(envSchema.safeParse({ DOCUMENT_WORKER_CONCURRENCY: '50' }).success).toBe(false);
    expect(envSchema.safeParse({ DOCUMENT_JOB_ATTEMPTS: '0' }).success).toBe(false);
  });

  it('keeps the API request limit at its default unless a higher one is asked for, and refuses silly values', async () => {
    const { envSchema } = await import('./config/env.js');
    expect(envSchema.parse({}).API_RATE_LIMIT_MAX).toBeUndefined();
    expect(envSchema.parse({ API_RATE_LIMIT_MAX: '50000' }).API_RATE_LIMIT_MAX).toBe(50_000);
    for (const value of ['0', '5', '-1', 'lots', '10000000']) expect(envSchema.safeParse({ API_RATE_LIMIT_MAX: value }).success).toBe(false);
  });

  it('uses GridFS for storage unless told otherwise, and no longer offers s3', async () => {
    const { envSchema } = await import('./config/env.js');
    expect(envSchema.parse({}).STORAGE_PROVIDER).toBe('gridfs');
    expect(envSchema.parse({ STORAGE_PROVIDER: 'local' }).STORAGE_PROVIDER).toBe('local');
    expect(envSchema.safeParse({ STORAGE_PROVIDER: 's3' }).success).toBe(false);
  });
});
