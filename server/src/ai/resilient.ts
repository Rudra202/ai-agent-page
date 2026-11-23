import type { AiResponse } from '@tajir/shared';
import { AiInvalidOutputError, AiProviderError, AiUnavailableError, classifyError } from './types.js';
import type { AiErrorCode, CallOptions, GenerateRequest, InterpretRequest, LlmProvider } from './types.js';

/**
 * Wraps a provider with the behaviour a production call needs:
 * - a hard timeout per attempt (the call is aborted and abandoned),
 * - retries with exponential backoff and jitter, only for failures that can pass
 *   (timeouts, rate limits, 5xx, network); never for bad credentials or bad requests,
 * - one extra attempt when the model answers in an unusable shape,
 * - a circuit breaker, so a provider that keeps failing is skipped for a while
 *   instead of making every user wait for the timeout.
 *
 * It only ever throws AiUnavailableError. The caller answers with the
 * deterministic rules, so users are never left without a reply.
 */

export interface ResilienceOptions {
  timeoutMs: number;
  /** Per-attempt timeout for `generate` (reading a document takes longer than reading a chat message). Defaults to twice `timeoutMs`. */
  generateTimeoutMs?: number;
  /** Retries after the first attempt, for transient failures. */
  maxRetries: number;
  /** Extra attempts after an unusable answer. */
  maxRepairs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Consecutive failed calls that open the circuit. */
  failureThreshold?: number;
  /** How long the circuit stays open before one trial call is allowed. */
  cooldownMs?: number;
  // Injectable so that tests are fast and deterministic.
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onEvent?: (event: AiCallEvent) => void;
}

export type AiCallEvent = { provider?: string } & (
  | { type: 'attempt_failed'; code: AiErrorCode; attempt: number; willRetry: boolean }
  | { type: 'circuit_opened' }
  | { type: 'circuit_closed' }
  | { type: 'circuit_rejected' }
);

export interface ResilientProvider extends LlmProvider {
  /** For health reporting and tests. */
  circuitState(): 'closed' | 'open' | 'half_open';
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function withResilience(inner: LlmProvider, options: ResilienceOptions): ResilientProvider {
  const {
    timeoutMs,
    generateTimeoutMs = timeoutMs * 2,
    maxRetries,
    maxRepairs = 1,
    baseDelayMs = 400,
    maxDelayMs = 4000,
    failureThreshold = 5,
    cooldownMs = 30_000,
    now = Date.now,
    sleep = defaultSleep,
    random = Math.random,
    onEvent = () => undefined,
  } = options;

  let consecutiveFailures = 0;
  let openedAt: number | null = null;
  let trialInFlight = false;

  const state = (): 'closed' | 'open' | 'half_open' => {
    if (openedAt === null) return 'closed';
    return now() - openedAt >= cooldownMs ? 'half_open' : 'open';
  };

  const recordSuccess = () => {
    if (openedAt !== null) onEvent({ type: 'circuit_closed' });
    consecutiveFailures = 0;
    openedAt = null;
  };

  const recordFailure = () => {
    consecutiveFailures += 1;
    if (openedAt !== null || consecutiveFailures >= failureThreshold) {
      if (openedAt === null) onEvent({ type: 'circuit_opened' });
      openedAt = now();
    }
  };

  const backoff = (retry: number, error: AiProviderError): number => {
    const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** retry);
    const jittered = exponential / 2 + random() * (exponential / 2);
    // Honour the provider's own hint, but never wait longer than the cap.
    return Math.min(maxDelayMs, Math.max(jittered, error.retryAfterMs ?? 0));
  };

  /** One attempt with a timeout. The underlying request is aborted when time is up. */
  const attempt = async <T>(invoke: (signal: AbortSignal) => Promise<T>, outer: AbortSignal | undefined, limitMs: number): Promise<T> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onOuterAbort = () => controller.abort();
    outer?.addEventListener('abort', onOuterAbort, { once: true });

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AiProviderError('timeout', { retryable: true }));
      }, limitMs);
    });

    try {
      const call = invoke(controller.signal);
      // If the timeout wins, the late result of the call is ignored and must not become an unhandled rejection.
      call.catch(() => undefined);
      return await Promise.race([call, timeout]);
    } catch (error) {
      throw classifyError(error);
    } finally {
      if (timer) clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    }
  };

  /** Runs one call with the retries, repairs and circuit breaker shared by every kind of call. */
  const run = async <T>(invoke: (signal: AbortSignal) => Promise<T>, callOptions: CallOptions, limitMs: number): Promise<T> => {
    const current = state();
    if (current === 'open' || (current === 'half_open' && trialInFlight)) {
      onEvent({ type: 'circuit_rejected' });
      throw new AiUnavailableError('circuit_open');
    }
    if (current === 'half_open') trialInFlight = true;

    let retries = 0;
    let repairs = 0;
    let calls = 0;
    let lastCode: AiErrorCode = 'unknown';

    try {
      for (;;) {
        calls += 1;
        try {
          const response = await attempt(invoke, callOptions.signal, limitMs);
          recordSuccess();
          return response;
        } catch (raw) {
          const error = classifyError(raw);
          lastCode = error.code;
          const invalid = error instanceof AiInvalidOutputError;
          // A caller that has given up is not retried for.
          const canRetry = callOptions.signal?.aborted ? false : invalid ? repairs < maxRepairs : error.retryable && retries < maxRetries;
          onEvent({ type: 'attempt_failed', code: error.code, attempt: calls, willRetry: canRetry });
          if (!canRetry) break;
          if (invalid) {
            repairs += 1;
          } else {
            await sleep(backoff(retries, error));
            retries += 1;
          }
        }
      }
      // Problems that are the user's or the configuration's fault, not a sign that the service is down,
      // still count: a bad key makes every call fail, so the circuit protects users from waiting on it.
      recordFailure();
      throw new AiUnavailableError(lastCode);
    } finally {
      trialInFlight = false;
    }
  };

  return {
    kind: 'llm',
    name: inner.name,
    label: inner.label,
    circuitState: state,

    interpret: (request: InterpretRequest, callOptions: CallOptions = {}): Promise<AiResponse> =>
      run((signal) => inner.interpret(request, { signal }), callOptions, timeoutMs),

    ...(inner.generate
      ? {
          generate: (request: GenerateRequest, callOptions: CallOptions = {}): Promise<unknown> =>
            run((signal) => inner.generate!({ ...request, timeoutMs: generateTimeoutMs }, { signal }), callOptions, generateTimeoutMs),
        }
      : {}),
  };
}
