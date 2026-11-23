import { Router } from 'express';
import type { RequestHandler } from 'express';
import { currentUser } from '../middleware/auth.js';
import { parse } from '../middleware/validate.js';
import { createConversationSchema, postMessageSchema, toTurnRequest, updateDraftSchema } from '../services/conversations.js';
import type { ConversationService } from '../services/conversations.js';

export function conversationRoutes(conversations: ConversationService, requireAuth: RequestHandler): Router {
  const router = Router();
  router.use(requireAuth);

  router.post('/', async (req, res) => {
    const { title } = parse(createConversationSchema, req.body ?? {});
    res.status(201).json(await conversations.create(currentUser(req), title));
  });

  router.get('/', async (req, res) => {
    res.json({ conversations: await conversations.list(currentUser(req)) });
  });

  router.get('/:id', async (req, res) => {
    res.json(await conversations.get(currentUser(req), String(req.params.id)));
  });

  router.patch('/:id/draft', async (req, res) => {
    const input = parse(updateDraftSchema, req.body ?? {});
    res.json(await conversations.updateDraft(currentUser(req), String(req.params.id), input));
  });

  router.post('/:id/messages', async (req, res) => {
    const request = toTurnRequest(parse(postMessageSchema, req.body ?? {}));
    res.status(201).json(await conversations.postMessage(currentUser(req), String(req.params.id), request));
  });

  return router;
}
