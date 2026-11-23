import type { Request, RequestHandler } from 'express';
import type { User } from '../domain/entities.js';
import type { Repositories } from '../repositories/types.js';
import type { AuthService } from '../services/auth.js';
import { HttpError } from './errorHandler.js';

export const AUTH_COOKIE = 'tajir_token';

function tokenFrom(req: Request): string | undefined {
  const cookie = req.cookies?.[AUTH_COOKIE];
  if (typeof cookie === 'string' && cookie) return cookie;
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || undefined;
  return undefined;
}

/**
 * Protects a route. The token must be valid AND the account must still exist,
 * so deleting a user takes effect immediately.
 */
export function createRequireAuth(auth: AuthService, repos: Repositories): RequestHandler {
  return async (req, _res, next) => {
    const token = tokenFrom(req);
    const userId = token ? auth.verifyToken(token) : null;
    if (!userId) throw new HttpError(401, 'Sign in required');
    const user = await repos.users.findById(userId);
    if (!user) throw new HttpError(401, 'Sign in required');
    req.user = user;
    next();
  };
}

/** The signed-in user. Only call this behind requireAuth. */
export function currentUser(req: Request): User {
  if (!req.user) throw new HttpError(401, 'Sign in required');
  return req.user;
}
