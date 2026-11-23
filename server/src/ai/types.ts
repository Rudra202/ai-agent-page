import type { AiResponse, InterpretContext } from '@tajir/shared';

/**
 * AI providers. A provider reads a user's message and the small context the
 * workflow engine gives it, and returns a structured PROPOSAL. It has no access
 * to the database, the repositories or the services, and nothing it returns is
 * trusted: the workflow engine validates every value.
 *
 * To add another vendor (for example Anthropic), implement `LlmProvider` and add
 * it to the factory. Nothing else in the app changes.
 */

export interface InterpretRequest {
  /** The user's message. Untrusted. */
  text: string;
  context: InterpretContext;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Called with the name of the provider that gave the answer, when several are tried in turn. */
  onProvider?: (name: string) => void;
  /** Called with the name and failure code of each provider that could not answer. */
  onFailure?: (name: string, code: AiErrorCode) => void;
}

/** A request for a JSON answer in a given shape, outside the chat flow (for example reading a document). */
export interface GenerateRequest {
  /** Instructions. Written by us, never from a user or a document. */
  system: string;
  /** The material to work on. Untrusted: it may be a document that tries to give orders. */
  user: string;
  /** The JSON Schema the answer must follow. The caller validates the answer again; nothing here is trusted. */
  schema: Record<string, unknown>;
  schemaName: string;
  maxOutputTokens?: number;
  /** Set by the resilience wrapper: how long one attempt may take. */
  timeoutMs?: number;
}

export interface LlmProvider {
  readonly kind: 'llm';
  readonly name: string;
  /** For logs only: the name and the model, for example "gemini (gemini-3.5-flash-lite)". */
  readonly label?: string;
  interpret(request: InterpretRequest, options?: CallOptions): Promise<AiResponse>;
  /** Optional: a JSON answer for a caller-defined schema. Returns parsed JSON that the caller must validate. */
  generate?(request: GenerateRequest, options?: CallOptions): Promise<unknown>;
}

/** The built-in rules: no model, no network. Used when no AI key is set, and as the fallback when a model cannot be reached. */
export interface RulesProvider {
  readonly kind: 'rules';
  readonly name: 'rules';
}

export type AiProvider = LlmProvider | RulesProvider;

export const rulesProvider: RulesProvider = { kind: 'rules', name: 'rules' };

// ------------------------------------------------------------------- errors

export type AiErrorCode =
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'server_error'
  | 'quota_exhausted'
  | 'bad_request'
  | 'auth'
  | 'not_found'
  | 'refusal'
  | 'invalid_output'
  | 'circuit_open'
  | 'unknown';

/**
 * A failure of the provider. The message is generic on purpose: provider errors can
 * echo parts of a credential, so details are limited to a status and a code.
 */
export class AiProviderError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: AiErrorCode, options: { retryable: boolean; status?: number; retryAfterMs?: number; message?: string }) {
    super(options.message ?? `AI provider error: ${code}${options.status ? ` (status ${options.status})` : ''}`);
    this.name = 'AiProviderError';
    this.code = code;
    this.retryable = options.retryable;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** The model answered, but not in the required shape or with values that break the contract. */
export class AiInvalidOutputError extends AiProviderError {
  constructor(detail: string) {
    super('invalid_output', { retryable: false, message: `AI output was not usable: ${detail}` });
    this.name = 'AiInvalidOutputError';
  }
}

/** Every attempt failed, or the circuit is open. The caller should fall back to the rules. */
export class AiUnavailableError extends Error {
  readonly code: AiErrorCode;

  constructor(code: AiErrorCode) {
    super(`AI unavailable: ${code}`);
    this.name = 'AiUnavailableError';
    this.code = code;
  }
}

/** Codes that mean the account has no credit or quota left. Waiting will not help. */
const QUOTA_CODES = new Set(['insufficient_quota', 'credit_balance_exhausted', 'billing_hard_limit_reached']);

const RETRYABLE_NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT']);

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') return (headers as { get(n: string): string | null }).get(name) ?? undefined;
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

/** Turns anything a provider throws into an AiProviderError with a retry decision. */
export function classifyError(error: unknown): AiProviderError {
  if (error instanceof AiProviderError) return error;
  const e = (error ?? {}) as { name?: string; message?: string; status?: number; code?: string; type?: string; headers?: unknown; error?: { code?: string; type?: string } };
  const status = typeof e.status === 'number' ? e.status : undefined;
  const apiCode = e.code ?? e.error?.code;
  const apiType = e.type ?? e.error?.type;

  if (e.name === 'AbortError' || e.name === 'APIUserAbortError') return new AiProviderError('timeout', { retryable: true });
  if (e.name === 'APIConnectionTimeoutError') return new AiProviderError('timeout', { retryable: true });
  if (e.name === 'APIConnectionError' || (apiCode && RETRYABLE_NETWORK_CODES.has(apiCode))) return new AiProviderError('network', { retryable: true });
  // Node's fetch reports a dropped connection as a TypeError.
  if (e.name === 'TypeError' && /fetch failed|network|socket/i.test(e.message ?? '')) return new AiProviderError('network', { retryable: true });
  if (e.name === 'LengthFinishReasonError' || e.name === 'ContentFilterFinishReasonError') return new AiInvalidOutputError(e.name);

  if (status !== undefined) {
    const retryAfter = Number(headerValue(e.headers, 'retry-after'));
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : undefined;
    // Running out of quota will not fix itself in a few seconds, so it is not retried.
    if (status === 429) {
      return QUOTA_CODES.has(apiCode ?? '') || apiType === 'insufficient_quota'
        ? new AiProviderError('quota_exhausted', { retryable: false, status })
        : new AiProviderError('rate_limited', { retryable: true, status, retryAfterMs });
    }
    if (status === 408 || status === 409) return new AiProviderError('timeout', { retryable: true, status });
    if (status >= 500) return new AiProviderError('server_error', { retryable: true, status, retryAfterMs });
    if (status === 401 || status === 403) return new AiProviderError('auth', { retryable: false, status });
    // Gemini reports a bad API key as a 400. The message is only read here, never repeated.
    if (status === 400 && /api key|api_key/i.test(e.message ?? '')) return new AiProviderError('auth', { retryable: false, status });
    if (status === 404) return new AiProviderError('not_found', { retryable: false, status });
    return new AiProviderError('bad_request', { retryable: false, status });
  }
  return new AiProviderError('unknown', { retryable: false });
}
