/**
 * Thin wrapper around fetch for the Tajir API.
 *
 * - Requests go to the same origin (the Vite dev server proxies /api), so the
 *   httpOnly session cookie is sent automatically and never touched by this code.
 * - Every failure becomes an ApiError with a message that is safe to show.
 * - A 401 on a normal request means the session ended: the app is told, so it
 *   can send the user back to sign in.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export interface HttpOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Called when a request that needs a session is refused with 401. */
  onUnauthorized?: () => void;
}

export interface RequestOptions {
  /** True for sign-in style calls where a 401 is an expected answer and not an expired session. */
  expectUnauthorized?: boolean;
}

export interface Http {
  request<T>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  /** Fetches a file (not JSON) with the same session and error handling. */
  blob(path: string): Promise<Blob>;
}

const NETWORK_MESSAGE = 'Could not reach the server. Check your connection and try again.';
const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

interface ErrorBody {
  error?: { message?: unknown; details?: unknown };
}

function messageFrom(status: number, body: ErrorBody | null): string {
  const message = typeof body?.error?.message === 'string' ? body.error.message : '';
  const details = body?.error?.details;
  // A validation failure carries the field message, which is more useful than "Validation failed".
  if (status === 400 && Array.isArray(details)) {
    const first = details.find((d): d is { message: string } => typeof d?.message === 'string');
    if (first) return first.message;
  }
  if (status === 429) return message || 'Too many requests. Please wait a moment and try again.';
  if (status >= 500) return message || GENERIC_MESSAGE;
  return message || GENERIC_MESSAGE;
}

export function createHttp({ baseUrl = '', fetchImpl, timeoutMs = 30_000, onUnauthorized }: HttpOptions = {}): Http {
  return {
    async blob(path: string): Promise<Blob> {
      const doFetch = fetchImpl ?? fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 60_000));
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}${path}`, { method: 'GET', credentials: 'include', signal: controller.signal });
      } catch {
        clearTimeout(timer);
        throw new ApiError(0, NETWORK_MESSAGE);
      }
      try {
        if (!response.ok) {
          let data: unknown = null;
          try {
            data = await response.json();
          } catch {
            // Not JSON: the generic message is used.
          }
          if (response.status === 401) onUnauthorized?.();
          throw new ApiError(response.status, messageFrom(response.status, data as ErrorBody | null), (data as ErrorBody | null)?.error?.details);
        }
        return await response.blob();
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(0, NETWORK_MESSAGE);
      } finally {
        clearTimeout(timer);
      }
    },

    async request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
      const doFetch = fetchImpl ?? fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const headers: Record<string, string> = { Accept: 'application/json' };
      let payload: BodyInit | undefined;
      if (body instanceof FormData) {
        payload = body;
      } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }

      let response: Response;
      try {
        response = await doFetch(`${baseUrl}${path}`, { method, headers, body: payload, credentials: 'include', signal: controller.signal });
      } catch {
        throw new ApiError(0, NETWORK_MESSAGE);
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 204) return undefined as T;

      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        // A proxy or crash can answer with something that is not JSON.
      }

      if (!response.ok) {
        if (response.status === 401 && !options.expectUnauthorized) onUnauthorized?.();
        throw new ApiError(response.status, messageFrom(response.status, data as ErrorBody | null), (data as ErrorBody | null)?.error?.details);
      }
      if (data === null) throw new ApiError(response.status, GENERIC_MESSAGE);
      return data as T;
    },
  };
}
