import type { RequestHandler } from 'express';
import { HttpError } from './errorHandler.js';
import { isAllowedOrigin } from './origins.js';

/**
 * Defence in depth against cross-site request forgery, next to the SameSite
 * cookie. A browser always sends Origin on a cross-site write, so a write that
 * names any origin other than ours is refused. Requests with no Origin header
 * (scripts, tests, server-to-server) cannot be a cross-site browser request.
 *
 * `explain` is for development: the refusal then says which address the page is on and which are accepted, because
 * the usual cause is simply opening the site at an address the server was not told about. In production the answer
 * stays short and gives nothing away.
 */
export function originCheck(allowed: readonly string[], explain = false): RequestHandler {
  return (req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.get('origin');
    if (origin && !isAllowedOrigin(origin, allowed)) {
      throw new HttpError(
        403,
        explain
          ? `Origin not allowed. This page is open at ${origin}, but the server only accepts ${allowed.join(' or ')}. Open the site at one of those addresses, or add this one to CLIENT_ORIGIN in server/.env and restart the server.`
          : 'Origin not allowed',
      );
    }
    next();
  };
}
