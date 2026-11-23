import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { parseDurationMs } from '../config/env.js';
import type { AppConfig } from '../config/env.js';
import type { User } from '../domain/entities.js';
import { HttpError } from '../middleware/errorHandler.js';
import { DuplicateError } from '../repositories/errors.js';
import type { Repositories } from '../repositories/types.js';

const COMMON_PASSWORDS = new Set(['password', 'password1', '12345678', '123456789', '1234567890', 'qwertyuiop', 'iloveyou1']);

export const registerSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter your name').max(100),
    email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address').max(254)),
    // 72 is the most bcrypt will use. Longer passwords would be silently truncated.
    password: z.string().min(8, 'Use at least 8 characters').max(72, 'Use at most 72 characters'),
    company: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((v) => v.password.toLowerCase() !== v.email, { path: ['password'], message: 'Your password must not be your email address' })
  .refine((v) => !COMMON_PASSWORDS.has(v.password.toLowerCase()), { path: ['password'], message: 'That password is too common' });

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    password: z.string().min(1).max(72),
  })
  .strict();

export interface AuthService {
  register(input: z.output<typeof registerSchema>): Promise<{ user: User; company?: string }>;
  login(input: z.output<typeof loginSchema>): Promise<User>;
  issueToken(userId: string): string;
  /** Returns the user id for a valid token, or null for anything else. */
  verifyToken(token: string): string | null;
  cookieMaxAgeMs: number;
}

export function createAuthService(repos: Repositories, config: AppConfig): AuthService {
  const maxAgeMs = parseDurationMs(config.jwtExpiresIn);
  // Compared against when the email is unknown, so a missing account takes as long to reject as a wrong password.
  const dummyHash = bcrypt.hashSync(randomBytes(16).toString('hex'), config.bcryptRounds);

  return {
    cookieMaxAgeMs: maxAgeMs,

    async register({ name, email, password, company }) {
      const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
      let user: User;
      try {
        user = await repos.users.create({ name, email, passwordHash });
      } catch (error) {
        if (error instanceof DuplicateError) throw new HttpError(409, 'An account with this email already exists');
        throw error;
      }
      if (company) await repos.businessProfiles.create({ userId: user.id, kind: 'existing_company', name: company });
      return { user, company };
    },

    async login({ email, password }) {
      const found = await repos.users.findByEmail(email);
      const matches = await bcrypt.compare(password, found?.passwordHash ?? dummyHash);
      if (!found || !matches) throw new HttpError(401, 'Invalid email or password');
      const { passwordHash: _passwordHash, ...user } = found;
      return user;
    },

    issueToken(userId) {
      return jwt.sign({}, config.jwtSecret, { subject: userId, expiresIn: Math.floor(maxAgeMs / 1000), algorithm: 'HS256' });
    },

    verifyToken(token) {
      try {
        // Only HS256 is accepted, which rules out "alg: none" and algorithm-swap tricks.
        const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
        return typeof payload === 'object' && typeof payload.sub === 'string' ? payload.sub : null;
      } catch {
        return null;
      }
    },
  };
}
