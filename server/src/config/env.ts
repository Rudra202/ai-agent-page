import 'dotenv/config';
import { z } from 'zod';
import { parseClientOrigins } from '../middleware/origins.js';

const DEV_SECRET = 'dev-only-secret-change-me';

const optionalBoolean = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // The website's address, exactly as the browser shows it. Several can be listed, separated by commas.
  CLIENT_ORIGIN: z.string().min(1).default('http://localhost:5173'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters').default(DEV_SECRET),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // MongoDB Atlas: either a full URI, or user + password + host (the URI is built and the password is encoded).
  MONGODB_URI: z.string().default(''),
  MONGODB_USER: z.string().default(''),
  MONGODB_PASSWORD: z.string().default(''),
  MONGODB_HOST: z.string().default(''),
  MONGODB_DB_NAME: z.string().min(1).default('tajir'),
  MONGODB_APP_NAME: z.string().default('tajir-ai'),

  // "auto" tries Gemini first (if GEMINI_API_KEY is set), then OpenAI (if OPENAI_API_KEY is set), then the built-in rules.
  // "gemini" or "openai" use only that one. "rules" never uses a model. "mock" is the old name for "rules".
  AI_PROVIDER: z
    .enum(['auto', 'gemini', 'openai', 'rules', 'mock'])
    .default('auto')
    .transform((value) => (value === 'mock' ? 'rules' : value)),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),
  // Tried after GEMINI_MODEL if that one is overloaded or down, before OpenAI. Leave empty to turn it off.
  GEMINI_FALLBACK_MODEL: z.string().default('gemini-3.1-flash-lite'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(500).max(120000).default(10000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(100).max(8000).default(1500),

  // "gridfs" keeps uploaded files in MongoDB (GridFS, in the same Atlas database). "local" keeps them on this server's disk.
  // Documents already on local disk stay readable whichever is chosen.
  STORAGE_PROVIDER: z.enum(['gridfs', 'local']).default('gridfs'),
  UPLOAD_DIR: z.string().default('uploads'),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(50).default(10),

  // Reading scanned PDFs and photos of documents (local Tesseract OCR, no AI, no cloud). Text PDFs work with it off.
  DOCUMENT_OCR_ENABLED: optionalBoolean,
  // Asking an AI model to pull structured details out of the text. Reading and OCR work without it.
  DOCUMENT_AI_ENABLED: optionalBoolean,
  // The most API requests one address may make in 15 minutes. The default (1000) is what production uses. It is only
  // raised for the browser-test server, where one address runs a whole test suite.
  API_RATE_LIMIT_MAX: z.coerce.number().int().min(100).max(1_000_000).optional(),
  DOCUMENT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  DOCUMENT_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  DOCUMENT_JOB_BACKOFF_MS: z.coerce.number().int().min(100).max(600_000).default(5_000),

  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  COOKIE_SECURE: optionalBoolean,
  SIMULATION_ENABLED: optionalBoolean,
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (env.JWT_SECRET === DEV_SECRET || env.JWT_SECRET.length < 32) {
      throw new Error('JWT_SECRET must be set to a random value of at least 32 characters in production');
    }
  }
  return env;
}

export const env = loadEnv();

/** Builds the Atlas connection string from either MONGODB_URI or the separate parts. Returns '' when unset. */
export function resolveMongoUri(source: Pick<Env, 'MONGODB_URI' | 'MONGODB_USER' | 'MONGODB_PASSWORD' | 'MONGODB_HOST' | 'MONGODB_APP_NAME'>): string {
  if (source.MONGODB_URI) return source.MONGODB_URI;
  if (source.MONGODB_USER && source.MONGODB_PASSWORD && source.MONGODB_HOST) {
    const user = encodeURIComponent(source.MONGODB_USER);
    const password = encodeURIComponent(source.MONGODB_PASSWORD);
    const app = encodeURIComponent(source.MONGODB_APP_NAME);
    return `mongodb+srv://${user}:${password}@${source.MONGODB_HOST}/?retryWrites=true&w=majority&appName=${app}`;
  }
  return '';
}

export type AiModelName = 'gemini' | 'openai';

/**
 * The AI models to use, in the order they are tried. A model is never listed without its key.
 * "auto" puts Gemini first and OpenAI second. An empty list means the built-in rules answer.
 */
export function effectiveAiProviders(source: Pick<Env, 'AI_PROVIDER' | 'GEMINI_API_KEY' | 'OPENAI_API_KEY'> = env): AiModelName[] {
  const wanted = source.AI_PROVIDER;
  const order: AiModelName[] = [];
  if ((wanted === 'auto' || wanted === 'gemini') && source.GEMINI_API_KEY) order.push('gemini');
  if ((wanted === 'auto' || wanted === 'openai') && source.OPENAI_API_KEY) order.push('openai');
  return order;
}

/** "7d", "12h", "30m", "45s" to milliseconds. Defaults to 7 days if the value is not understood. */
export function parseDurationMs(value: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(value.trim());
  if (!match) return 7 * 86_400_000;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return Number(match[1]) * unit;
}

/** The settings the application actually needs. Passing this in keeps the app easy to test. */
export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  /** The exact web page origins allowed to use the API with a session. See middleware/origins.ts. */
  clientOrigins: string[];
  jwtSecret: string;
  jwtExpiresIn: string;
  cookieSecure: boolean;
  bcryptRounds: number;
  maxUploadBytes: number;
  simulationEnabled: boolean;
  trustProxy: number;
  uploadDir: string;
}

export function appConfigFromEnv(source: Env = env): AppConfig {
  return {
    nodeEnv: source.NODE_ENV,
    clientOrigins: parseClientOrigins(source.CLIENT_ORIGIN, source.NODE_ENV),
    jwtSecret: source.JWT_SECRET,
    jwtExpiresIn: source.JWT_EXPIRES_IN,
    cookieSecure: source.COOKIE_SECURE ?? source.NODE_ENV === 'production',
    bcryptRounds: source.BCRYPT_ROUNDS,
    maxUploadBytes: Math.round(source.MAX_UPLOAD_MB * 1024 * 1024),
    simulationEnabled: source.SIMULATION_ENABLED ?? source.NODE_ENV !== 'production',
    trustProxy: source.TRUST_PROXY,
    uploadDir: source.UPLOAD_DIR,
  };
}
