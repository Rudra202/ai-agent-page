import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ServiceRecord } from '../domain/entities.js';
import { HttpError } from '../middleware/errorHandler.js';
import { parse } from '../middleware/validate.js';
import type { Repositories } from '../repositories/types.js';

const idSchema = z.string().min(1).max(64);

const view = (s: ServiceRecord) => ({
  id: s.id,
  slug: s.slug,
  type: s.type,
  name: s.name,
  description: s.description,
  steps: s.steps,
  config: s.config,
  /** True while the configuration is sample data. Never present it as verified fees or rules. */
  sample: s.sample,
});

export function serviceRoutes(repos: Repositories, requireAuth: RequestHandler): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (_req, res) => {
    res.json({ services: (await repos.services.list()).map(view) });
  });

  router.get('/:id', async (req, res) => {
    const found = await repos.services.findByIdOrSlug(parse(idSchema, req.params.id));
    if (!found) throw new HttpError(404, 'Service not found');
    res.json({ service: view(found) });
  });

  return router;
}
