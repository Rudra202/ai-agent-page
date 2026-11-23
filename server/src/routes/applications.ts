import { Router } from 'express';
import type { RequestHandler } from 'express';
import { currentUser } from '../middleware/auth.js';
import { HttpError } from '../middleware/errorHandler.js';
import { parse } from '../middleware/validate.js';
import {
  APPLICATION_REFERENCE,
  createApplicationSchema,
  listApplicationsQuerySchema,
  patchApplicationSchema,
} from '../services/applications.js';
import type { ApplicationService } from '../services/applications.js';
import type { DocumentService } from '../services/documents.js';

/** A malformed reference cannot match anything, so it is "not found" rather than a validation error. */
function reference(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !APPLICATION_REFERENCE.test(value)) throw new HttpError(404, 'Application not found');
  return value;
}

export function applicationRoutes(applications: ApplicationService, documents: DocumentService, requireAuth: RequestHandler): Router {
  const router = Router();
  router.use(requireAuth);

  router.post('/', async (req, res) => {
    const application = await applications.create(currentUser(req), parse(createApplicationSchema, req.body));
    res.status(201).json({ application });
  });

  router.get('/', async (req, res) => {
    const { filter } = parse(listApplicationsQuerySchema, req.query);
    res.json({ applications: await applications.list(currentUser(req), filter) });
  });

  router.get('/:id', async (req, res) => {
    res.json({ application: await applications.get(currentUser(req), reference(req.params.id)) });
  });

  router.patch('/:id', async (req, res) => {
    const application = await applications.patch(currentUser(req), reference(req.params.id), parse(patchApplicationSchema, req.body));
    res.json({ application });
  });

  router.get('/:id/documents', async (req, res) => {
    res.json({ documents: await documents.listForApplication(currentUser(req), reference(req.params.id)) });
  });

  return router;
}
