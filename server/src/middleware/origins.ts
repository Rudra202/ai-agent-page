/**
 * Which web pages may talk to this API with the user's cookie.
 *
 * The browser sends an Origin header (scheme, host and port of the page) with every write. It must match one of
 * the origins listed here exactly. There are no wildcards and no "any port".
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/** "http://localhost:5173/" and "http://localhost:5173" are the same origin. Anything that is not a plain origin is refused. */
export function normaliseOrigin(value: string): string | null {
  // The URL parser accepts "*" in a host name, so wildcards are ruled out here, before anything else.
  if (value.includes('*')) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // An origin has no path, query or login in it.
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Turns the CLIENT_ORIGIN setting (one origin, or several separated by commas) into the exact list that is allowed.
 *
 * Outside production, the other spelling of a local address is added too: a page opened as 127.0.0.1 and one opened
 * as localhost are the same site to a developer, and mixing them is a common cause of "Origin not allowed". The port
 * is never widened. In production the list is exactly what was configured.
 */
export function parseClientOrigins(setting: string, nodeEnv: 'development' | 'test' | 'production'): string[] {
  const origins = new Set<string>();
  for (const part of setting.split(',')) {
    if (!part.trim()) continue;
    const origin = normaliseOrigin(part);
    if (!origin) throw new Error(`CLIENT_ORIGIN contains something that is not an origin: "${part.trim()}". Use for example http://localhost:5173`);
    origins.add(origin);
    if (nodeEnv !== 'production') {
      const url = new URL(origin);
      if (LOOPBACK_HOSTS.has(url.hostname)) {
        const twin = new URL(origin);
        twin.hostname = url.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
        origins.add(twin.origin);
      }
    }
  }
  if (origins.size === 0) throw new Error('CLIENT_ORIGIN must name at least one origin');
  return [...origins];
}

export function isAllowedOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  return origin !== undefined && allowed.includes(origin);
}
