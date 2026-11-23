import { WorkflowError } from '@tajir/shared';
import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { DuplicateError } from '../repositories/errors.js';

/** An error with an HTTP status and a message that is safe to show to the caller. */
export class HttpError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { message: `Route not found: ${req.method} ${req.path}` } });
}

interface BodyParserError {
  type: string;
  status?: number;
}
const isBodyParserError = (err: unknown): err is BodyParserError =>
  typeof err === 'object' && err !== null && typeof (err as { type?: unknown }).type === 'string' && typeof (err as { status?: unknown }).status === 'number';

/**
 * Turns every failure into a consistent JSON body. Internal details (stack
 * traces, database messages, request bodies) are never sent, in any environment.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        message: 'Validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  if (err instanceof WorkflowError) {
    res.status(409).json({ error: { message: err.message } });
    return;
  }
  if (err instanceof DuplicateError) {
    res.status(409).json({ error: { message: 'That already exists or was already recorded.' } });
    return;
  }
  if (err instanceof MulterError) {
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      error: { message: tooLarge ? 'The file is too large.' : 'The upload could not be read.' },
    });
    return;
  }
  if (isBodyParserError(err)) {
    const tooLarge = err.type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({
      error: { message: tooLarge ? 'The request is too large.' : 'The request body is not valid JSON.' },
    });
    return;
  }

  // The real cause goes to the server log only. It can name hosts or settings, so it is never sent to the caller.
  console.error('[error]', err instanceof Error ? (err.stack ?? err.message) : String(err));
  res.status(500).json({ error: { message: 'Internal server error' } });
}
