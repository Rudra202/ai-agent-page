import { createContext, useContext } from 'react';
import type { UserView } from '../api/types';

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated' | 'unavailable';

export interface AuthApi {
  status: AuthStatus;
  user: UserView | null;
  /** What the server said when it could not be used (for example that its database is not connected). Empty if it simply did not answer. */
  unavailableMessage: string;
  /** True after a signed-in session ended on the server, so the sign-in page can say so. */
  sessionExpired: boolean;
  login: (input: { email: string; password: string }) => Promise<void>;
  register: (input: { name: string; email: string; password: string; company?: string }) => Promise<void>;
  logout: () => Promise<void>;
  /** Asks the server who is signed in again, after it could not be reached. */
  retry: () => Promise<void>;
}

export const AuthContext = createContext<AuthApi | null>(null);

export function useAuth(): AuthApi {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth must be used inside <AuthProvider>');
  return auth;
}
