import express from 'express';
import { aiHealth } from './routes/health.js';
import type { AiProvider } from './ai/types.js';

/**
 * What the server answers while it has no database. It never pretends: the health report says the
 * database is unavailable, and every other API call is refused with 503 and a message that says what to fix.
 * The real app replaces it the moment the database connects.
 */
export function waitingApp(ai: AiProvider, storageName: string, reason: () => string): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'degraded', service: 'tajir-ai-server', db: 'unavailable', ...aiHealth(ai), storage: storageName, detail: reason(), time: new Date().toISOString() });
  });
  app.use('/api', (_req, res) => {
    res.status(503).json({ error: { message: reason() } });
  });
  return app;
}
