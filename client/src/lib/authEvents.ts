/**
 * The HTTP layer is created before the screens, so it cannot call into them directly.
 * When the server says the session has ended, it announces it here and the sign-in
 * state listens.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export function onSessionExpired(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifySessionExpired(): void {
  listeners.forEach((listener) => listener());
}
