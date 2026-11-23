import { Router } from 'express';
import type { RequestHandler, Response } from 'express';
import type { AppConfig } from '../config/env.js';
import type { User } from '../domain/entities.js';
import { AUTH_COOKIE, currentUser } from '../middleware/auth.js';
import { parse } from '../middleware/validate.js';
import type { Repositories } from '../repositories/types.js';
import { loginSchema, registerSchema } from '../services/auth.js';
import type { AuthService } from '../services/auth.js';

interface Deps {
  auth: AuthService;
  repos: Repositories;
  config: AppConfig;
  requireAuth: RequestHandler;
  loginLimiter: RequestHandler;
  registerLimiter: RequestHandler;
}

const userView = (user: User, company: string | null) => ({ id: user.id, name: user.name, email: user.email, company });

export function authRoutes({ auth, repos, config, requireAuth, loginLimiter, registerLimiter }: Deps): Router {
  const router = Router();

  // httpOnly keeps the token away from page scripts. SameSite=Lax stops it being sent on cross-site writes.
  const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure: config.cookieSecure, path: '/' };
  const setSession = (res: Response, userId: string) =>
    res.cookie(AUTH_COOKIE, auth.issueToken(userId), { ...cookieOptions, maxAge: auth.cookieMaxAgeMs });

  router.post('/register', registerLimiter, async (req, res) => {
    const { user, company } = await auth.register(parse(registerSchema, req.body));
    setSession(res, user.id);
    res.status(201).json({ user: userView(user, company ?? null) });
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const user = await auth.login(parse(loginSchema, req.body));
    setSession(res, user.id);
    const company = (await repos.businessProfiles.findPrimaryCompany(user.id))?.name ?? null;
    res.json({ user: userView(user, company) });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(AUTH_COOKIE, cookieOptions);
    res.status(204).end();
  });

  router.get('/me', requireAuth, async (req, res) => {
    const user = currentUser(req);
    const company = (await repos.businessProfiles.findPrimaryCompany(user.id))?.name ?? null;
    res.json({ user: userView(user, company) });
  });

  return router;
}
