import type { Request, RequestHandler } from 'express';
import { HttpError } from './errorHandler.js';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  key: (req: Request) => string;
  message?: string;
  now?: () => number;
}

/** Small fixed-window limiter, kept in memory. Good enough for one server process. */
export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const now = options.now ?? Date.now;

  return (req, res, next) => {
    const time = now();
    if (hits.size > 10_000) {
      for (const [key, entry] of hits) if (entry.resetAt <= time) hits.delete(key);
    }
    const key = options.key(req);
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= time) {
      entry = { count: 0, resetAt: time + options.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > options.max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - time) / 1000))));
      throw new HttpError(429, options.message ?? 'Too many requests. Please try again later.');
    }
    next();
  };
}
