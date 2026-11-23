import { Router } from 'express';
import type { AiProvider } from '../ai/types.js';
import type { QueueHealth } from '../jobs/types.js';

export type AiName = 'gemini' | 'openai' | 'rules';

/** Which assistant answers first, and which one is the backup. No keys, no models, nothing secret. */
export function aiHealth(ai: AiProvider): { ai: AiName; aiBackup: AiName | null } {
  const known = (name: string | undefined): AiName | null => (name === 'gemini' || name === 'openai' ? name : null);
  const backups = (ai as { backups?: string[] }).backups ?? [];
  const primary = known(ai.name) ?? 'rules';
  // A second model from the same vendor is not a different backup, so the first different vendor is named.
  return { ai: primary, aiBackup: backups.map(known).find((name) => name !== null && name !== primary) ?? null };
}

export function healthRoutes(info: { db: 'mongodb' | 'memory'; ai: AiProvider; storage: string; queue?: () => QueueHealth }): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json({ status: 'ok', service: 'tajir-ai-server', db: info.db, ...aiHealth(info.ai), storage: info.storage, ...(info.queue ? { queue: info.queue() } : {}), time: new Date().toISOString() });
  });
  return router;
}
