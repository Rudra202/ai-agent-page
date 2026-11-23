import type { User } from '../domain/entities.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by the authentication middleware on protected routes. */
      user?: User;
    }
  }
}

export {};
