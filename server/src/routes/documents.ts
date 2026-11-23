import { Router } from 'express';
import type { RequestHandler, Response } from 'express';
import multer from 'multer';
import { pipeline } from 'node:stream';
import type { AppConfig } from '../config/env.js';
import { currentUser } from '../middleware/auth.js';
import { HttpError } from '../middleware/errorHandler.js';
import { parse } from '../middleware/validate.js';
import { listQuerySchema, uploadFieldsSchema } from '../services/documents.js';
import type { DocumentService } from '../services/documents.js';
import type { UploadedFile } from '../services/uploadEngine.js';

/** Ids are made by us (uuid or a database id). Anything else cannot be a document, so it is simply "not found". */
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** `Content-Disposition` with a safe ASCII fallback and the real name encoded the standard way (RFC 5987 / 6266). */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;%]/g, '_').slice(0, 100) || 'document';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function documentRoutes(
  documents: DocumentService,
  config: AppConfig,
  requireAuth: RequestHandler,
  uploadLimiter: RequestHandler,
  downloadLimiter: RequestHandler,
): Router {
  const router = Router();
  router.use(requireAuth);
  // Documents are private. Nothing here may be kept by a shared cache or shown again after sign-out.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });

  // The file is streamed straight into storage by the engine. It is never held in memory.
  const upload = multer({
    storage: documents.uploadEngine(config.maxUploadBytes),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5, fieldSize: 512, parts: 8 },
  });

  router.post('/upload', uploadLimiter, upload.single('file'), async (req, res) => {
    const file = req.file as UploadedFile | undefined;
    if (!file) throw new HttpError(400, 'No file was sent. Use the "file" field.');
    const user = currentUser(req);
    let fields;
    try {
      fields = parse(uploadFieldsSchema, req.body);
    } catch (error) {
      await documents.discardUpload(file.stored);
      throw error;
    }
    const result = await documents.completeUpload(user, file.stored, file.originalname, fields);
    res.status(201).json(result);
  });

  router.get('/', async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    res.json(await documents.list(currentUser(req), query));
  });

  const withId = (handler: (id: string, req: Parameters<RequestHandler>[0], res: Response) => Promise<void>): RequestHandler => async (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new HttpError(404, 'Document not found');
    await handler(id, req, res);
  };

  router.get(
    '/:id',
    withId(async (id, req, res) => {
      res.json({ document: await documents.get(currentUser(req), id) });
    }),
  );

  router.get(
    '/:id/status',
    withId(async (id, req, res) => {
      res.json({ status: await documents.status(currentUser(req), id) });
    }),
  );

  /** Streams the file. `inline` is for previewing in the app, `attachment` forces a download. */
  const sendFile = (kind: 'inline' | 'attachment'): RequestHandler =>
    withId(async (id, req, res) => {
      const { doc, file } = await documents.open(currentUser(req), id);
      // The type comes from the record (set from the file's real content at upload), never from anything the client sent.
      res.status(200);
      res.set({
        'Content-Type': doc.mimeType,
        'Content-Length': String(file.size),
        'Content-Disposition': contentDisposition(kind, doc.originalName),
        'X-Content-Type-Options': 'nosniff',
        // The file is shown as a document only. It can never run scripts or load anything on the page it is opened in.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      });
      await new Promise<void>((resolve) => {
        pipeline(file.stream, res, (error) => {
          // Headers are already sent, so a failure part way can only end the connection. It must not crash the server.
          if (error && !res.writableEnded) res.destroy();
          resolve();
        });
      });
    });

  router.get('/:id/view', downloadLimiter, sendFile('inline'));
  router.get('/:id/download', downloadLimiter, sendFile('attachment'));

  // "Read this document again". The work is queued, so the answer is 202 and the screen follows the status.
  router.post(
    '/:id/reprocess',
    uploadLimiter,
    withId(async (id, req, res) => {
      res.status(202).json({ status: await documents.reprocess(currentUser(req), id) });
    }),
  );

  router.delete(
    '/:id',
    withId(async (id, req, res) => {
      await documents.remove(currentUser(req), id);
      res.status(204).end();
    }),
  );

  return router;
}
