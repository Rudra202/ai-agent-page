import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from '../api/http';
import type { ApiClient, UserView } from '../api/types';
import { onSessionExpired } from '../lib/authEvents';
import { AuthContext } from './authContext';
import type { AuthApi, AuthStatus } from './authContext';

/**
 * Knows who is signed in. The session itself is an httpOnly cookie that the browser
 * keeps and this code never sees; the only thing asked of the server is "who am I".
 */
export function AuthProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<UserView | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [unavailableMessage, setUnavailableMessage] = useState('');
  const checking = useRef(false);

  const apply = useCallback((me: UserView | null) => {
    setUser(me);
    setUnavailableMessage('');
    setStatus(me ? 'authenticated' : 'anonymous');
  }, []);
  // The server could not be used, which is different from "not signed in". If it said why, that is kept.
  const unreachable = useCallback((error?: unknown) => {
    setUser(null);
    setUnavailableMessage(error instanceof ApiError && error.status >= 500 ? error.message : '');
    setStatus('unavailable');
  }, []);

  // The first check, when the app opens. The status is "loading" until the server has answered.
  useEffect(() => {
    let cancelled = false;
    api.auth
      .me()
      .then((me) => !cancelled && apply(me))
      .catch((error: unknown) => !cancelled && unreachable(error));
    return () => {
      cancelled = true;
    };
  }, [api, apply, unreachable]);

  /** Asks again after the server could not be reached. */
  const check = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    setStatus('loading');
    try {
      apply(await api.auth.me());
    } catch (error) {
      unreachable(error);
    } finally {
      checking.current = false;
    }
  }, [api, apply, unreachable]);

  // While the server is not usable (for example its database is still connecting), ask again every few
  // seconds, so the page opens by itself as soon as it is.
  useEffect(() => {
    if (status !== 'unavailable') return;
    const timer = setTimeout(() => void check(), 5_000);
    return () => clearTimeout(timer);
  }, [status, check]);

  // Any request the server refuses with 401 means the session ended, for example after the cookie expired.
  useEffect(
    () =>
      onSessionExpired(() => {
        setUser(null);
        setSessionExpired(true);
        setStatus('anonymous');
      }),
    [],
  );

  const login = useCallback<AuthApi['login']>(
    async (input) => {
      const signedIn = await api.auth.login(input);
      setSessionExpired(false);
      setUser(signedIn);
      setStatus('authenticated');
    },
    [api],
  );

  const register = useCallback<AuthApi['register']>(
    async (input) => {
      const created = await api.auth.register(input);
      setSessionExpired(false);
      setUser(created);
      setStatus('authenticated');
    },
    [api],
  );

  const logout = useCallback<AuthApi['logout']>(async () => {
    try {
      await api.auth.logout();
    } finally {
      // Even if the call fails, this browser stops acting as the user.
      setUser(null);
      setSessionExpired(false);
      setStatus('anonymous');
    }
  }, [api]);

  const value = useMemo<AuthApi>(
    () => ({ status, user, unavailableMessage, sessionExpired, login, register, logout, retry: check }),
    [status, user, unavailableMessage, sessionExpired, login, register, logout, check],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
