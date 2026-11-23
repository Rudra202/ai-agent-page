/**
 * Where to go after signing in: back to the page the user was sent away from, if there was one.
 * Only paths inside this app are followed, so a crafted link cannot send the user somewhere else.
 */
export function safeDestination(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  if (typeof from !== 'string') return '/dashboard';
  if (!from.startsWith('/') || from.startsWith('//')) return '/dashboard';
  if (from === '/login' || from === '/register') return '/dashboard';
  return from;
}
