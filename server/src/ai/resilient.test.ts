import { FALLBACK_AI_RESPONSE } from '@tajir/shared';
import type { AiResponse, InterpretContext } from '@tajir/shared';
import { describe, expect, it, vi } from 'vitest';
import { withResilience } from './resilient.js';
import type { AiCallEvent } from './resilient.js';
import { AiInvalidOutputError, AiProviderError, AiUnavailableError } from './types.js';
import type { CallOptions, InterpretRequest, LlmProvider } from './types.js';

const context = {} as InterpretContext;
const request: InterpretRequest = { text: 'hello', context };
const OK: AiResponse = { ...FALLBACK_AI_RESPONSE, intent: 'greet', message: 'Hi!' };

/** A provider that plays back a script: a value to return, or an error to throw, per call. */
function scripted(steps: Array<AiResponse | Error>): LlmProvider & { calls: number; signals: Array<AbortSignal | undefined> } {
  const provider = {
    kind: 'llm' as const,
    name: 'scripted',
    calls: 0,
    signals: [] as Array<AbortSignal | undefined>,
    async interpret(_request: InterpretRequest, options?: CallOptions) {
      const step = steps[Math.min(provider.calls, steps.length - 1)];
      provider.calls += 1;
      provider.signals.push(options?.signal);
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return provider;
}

const status = (code: number, extra: Record<string, unknown> = {}) => Object.assign(new Error('boom'), { status: code, ...extra });

function setup(inner: LlmProvider, overrides: Partial<Parameters<typeof withResilience>[1]> = {}) {
  const sleeps: number[] = [];
  const events: AiCallEvent[] = [];
  let time = 1_000_000;
  const provider = withResilience(inner, {
    timeoutMs: 1000,
    maxRetries: 2,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    failureThreshold: 3,
    cooldownMs: 10_000,
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { provider, sleeps, events, advance: (ms: number) => (time += ms) };
}

describe('retries', () => {
  it('returns the first good answer without waiting', async () => {
    const inner = scripted([OK]);
    const { provider, sleeps } = setup(inner);
    await expect(provider.interpret(request)).resolves.toEqual(OK);
    expect(inner.calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it.each([
    ['429 rate limit', status(429)],
    ['500 server error', status(500)],
    ['503 unavailable', status(503)],
    ['408 request timeout', status(408)],
    ['409 conflict', status(409)],
    ['a dropped connection', Object.assign(new Error('x'), { name: 'APIConnectionError' })],
    ['a reset socket', Object.assign(new Error('x'), { code: 'ECONNRESET' })],
  ])('retries after %s and then succeeds', async (_label, error) => {
    const inner = scripted([error, OK]);
    const { provider, sleeps } = setup(inner);
    await expect(provider.interpret(request)).resolves.toEqual(OK);
    expect(inner.calls).toBe(2);
    expect(sleeps).toHaveLength(1);
  });

  it.each([
    ['401 bad key', status(401)],
    ['403 forbidden', status(403)],
    ['404 unknown model', status(404)],
    ['400 bad request', status(400)],
    ['422 unprocessable', status(422)],
    ['429 with no quota left', status(429, { code: 'insufficient_quota' })],
    ['an unknown error', new Error('mystery')],
  ])('does not retry after %s', async (_label, error) => {
    const inner = scripted([error, OK]);
    const { provider, sleeps } = setup(inner);
    await expect(provider.interpret(request)).rejects.toBeInstanceOf(AiUnavailableError);
    expect(inner.calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('gives up after the configured number of retries', async () => {
    const inner = scripted([status(503)]);
    const { provider, sleeps } = setup(inner, { maxRetries: 2 });
    const error = await provider.interpret(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect((error as AiUnavailableError).code).toBe('server_error');
    // One first call plus two retries.
    expect(inner.calls).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it('does not retry at all when retries are set to zero', async () => {
    const inner = scripted([status(500), OK]);
    const { provider } = setup(inner, { maxRetries: 0 });
    await expect(provider.interpret(request)).rejects.toBeInstanceOf(AiUnavailableError);
    expect(inner.calls).toBe(1);
  });

  it('backs off exponentially with jitter, and never beyond the cap', async () => {
    const inner = scripted([status(503)]);
    // random 0 gives the lowest delay in each band, 1 the highest.
    const low = setup(inner, { maxRetries: 4, random: () => 0, baseDelayMs: 100, maxDelayMs: 500 });
    await low.provider.interpret(request).catch(() => undefined);
    expect(low.sleeps).toEqual([50, 100, 200, 250]);

    const high = setup(scripted([status(503)]), { maxRetries: 4, random: () => 1, baseDelayMs: 100, maxDelayMs: 500 });
    await high.provider.interpret(request).catch(() => undefined);
    expect(high.sleeps).toEqual([100, 200, 400, 500]);
  });

  it('honours the retry-after hint of a rate limit, within the cap', async () => {
    const inner = scripted([status(429, { headers: { 'retry-after': '1' } }), OK]);
    const { provider, sleeps } = setup(inner, { maxDelayMs: 5000, baseDelayMs: 100 });
    await provider.interpret(request);
    expect(sleeps).toEqual([1000]);

    const capped = setup(scripted([status(429, { headers: { 'retry-after': '3600' } }), OK]), { maxDelayMs: 2000 });
    await capped.provider.interpret(request);
    expect(capped.sleeps).toEqual([2000]);
  });

  it('reports each failed attempt without any message text', async () => {
    const inner = scripted([status(503), OK]);
    const { provider, events } = setup(inner);
    await provider.interpret(request);
    expect(events).toEqual([{ type: 'attempt_failed', code: 'server_error', attempt: 1, willRetry: true }]);
  });
});

describe('invalid answers', () => {
  it('asks again once when the model answers in an unusable shape', async () => {
    const inner = scripted([new AiInvalidOutputError('the reply did not match the schema'), OK]);
    const { provider, sleeps } = setup(inner);
    await expect(provider.interpret(request)).resolves.toEqual(OK);
    expect(inner.calls).toBe(2);
    // The repair attempt is immediate: the service is fine, the answer was not.
    expect(sleeps).toEqual([]);
  });

  it('gives up after one repair attempt', async () => {
    const inner = scripted([new AiInvalidOutputError('bad'), new AiInvalidOutputError('bad again'), OK]);
    const { provider } = setup(inner);
    const error = await provider.interpret(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect((error as AiUnavailableError).code).toBe('invalid_output');
    expect(inner.calls).toBe(2);
  });

  it('does not retry a refusal', async () => {
    const inner = scripted([new AiProviderError('refusal', { retryable: false }), OK]);
    const { provider } = setup(inner);
    await expect(provider.interpret(request)).rejects.toMatchObject({ code: 'refusal' });
    expect(inner.calls).toBe(1);
  });
});

describe('timeouts', () => {
  const hanging = (): LlmProvider & { aborted: number } => {
    const provider = {
      kind: 'llm' as const,
      name: 'hanging',
      aborted: 0,
      interpret(_r: InterpretRequest, options?: CallOptions) {
        return new Promise<AiResponse>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            provider.aborted += 1;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      },
    };
    return provider;
  };

  it('gives up on a call that takes too long, aborts it, and reports a timeout', async () => {
    const inner = hanging();
    const { provider } = setup(inner, { timeoutMs: 20, maxRetries: 0 });
    const started = Date.now();
    const error = await provider.interpret(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect((error as AiUnavailableError).code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(inner.aborted).toBe(1);
  });

  it('retries a timeout and succeeds when the next call is fast', async () => {
    let calls = 0;
    const inner: LlmProvider = {
      kind: 'llm',
      name: 'slow-then-fast',
      interpret(_r, options) {
        calls += 1;
        if (calls === 1) return new Promise<AiResponse>(() => options?.signal?.addEventListener('abort', () => undefined));
        return Promise.resolve(OK);
      },
    };
    const { provider } = setup(inner, { timeoutMs: 20 });
    await expect(provider.interpret(request)).resolves.toEqual(OK);
    expect(calls).toBe(2);
  });

  it('ignores a late answer from a call that already timed out', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const inner: LlmProvider = {
      kind: 'llm',
      name: 'late',
      interpret: () => new Promise<AiResponse>((_resolve, reject) => setTimeout(() => reject(new Error('late failure')), 60)),
    };
    const { provider } = setup(inner, { timeoutMs: 10, maxRetries: 0 });
    await expect(provider.interpret(request)).rejects.toBeInstanceOf(AiUnavailableError);
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('stops when the caller aborts', async () => {
    const inner = hanging();
    const { provider } = setup(inner, { timeoutMs: 5000, maxRetries: 0 });
    const controller = new AbortController();
    const pending = provider.interpret(request, { signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    expect(await pending).toBeInstanceOf(AiUnavailableError);
    expect(inner.aborted).toBe(1);
  });
});

describe('circuit breaker', () => {
  it('opens after repeated failures and then rejects at once, without calling the provider', async () => {
    const inner = scripted([status(503)]);
    const { provider, events } = setup(inner, { maxRetries: 0, failureThreshold: 3 });
    for (let i = 0; i < 3; i += 1) await provider.interpret(request).catch(() => undefined);
    expect(provider.circuitState()).toBe('open');
    expect(events).toContainEqual({ type: 'circuit_opened' });

    const callsBefore = inner.calls;
    const error = await provider.interpret(request).catch((e: unknown) => e);
    expect((error as AiUnavailableError).code).toBe('circuit_open');
    expect(inner.calls).toBe(callsBefore);
    expect(events).toContainEqual({ type: 'circuit_rejected' });
  });

  it('counts a whole failed call once, however many retries it made', async () => {
    const inner = scripted([status(503)]);
    const { provider } = setup(inner, { maxRetries: 2, failureThreshold: 3 });
    await provider.interpret(request).catch(() => undefined);
    await provider.interpret(request).catch(() => undefined);
    expect(provider.circuitState()).toBe('closed');
  });

  it('is reset by a success, so scattered failures never open it', async () => {
    const inner = scripted([status(503), status(503), OK, status(503), status(503), OK]);
    const { provider } = setup(inner, { maxRetries: 0, failureThreshold: 3 });
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i += 1) outcomes.push(await provider.interpret(request).then(() => 'ok', () => 'fail'));
    expect(outcomes).toEqual(['fail', 'fail', 'ok', 'fail', 'fail', 'ok']);
    expect(provider.circuitState()).toBe('closed');
  });

  it('lets one trial call through after the cooldown and closes again when it works', async () => {
    const inner = scripted([status(503), status(503), status(503), OK]);
    const { provider, advance, events } = setup(inner, { maxRetries: 0, failureThreshold: 3, cooldownMs: 10_000 });
    for (let i = 0; i < 3; i += 1) await provider.interpret(request).catch(() => undefined);
    expect(provider.circuitState()).toBe('open');

    advance(9_999);
    expect(provider.circuitState()).toBe('open');
    advance(1);
    expect(provider.circuitState()).toBe('half_open');

    await expect(provider.interpret(request)).resolves.toEqual(OK);
    expect(provider.circuitState()).toBe('closed');
    expect(events).toContainEqual({ type: 'circuit_closed' });
  });

  it('stays open and waits again when the trial call fails', async () => {
    const inner = scripted([status(503)]);
    const { provider, advance } = setup(inner, { maxRetries: 0, failureThreshold: 2, cooldownMs: 10_000 });
    for (let i = 0; i < 2; i += 1) await provider.interpret(request).catch(() => undefined);
    advance(10_000);
    const callsBefore = inner.calls;
    await provider.interpret(request).catch(() => undefined);
    expect(inner.calls).toBe(callsBefore + 1);
    expect(provider.circuitState()).toBe('open');
    advance(5_000);
    expect(provider.circuitState()).toBe('open');
  });

  it('allows only one trial call at a time while half open', async () => {
    let release: (value: AiResponse) => void = () => undefined;
    let calls = 0;
    const inner: LlmProvider = {
      kind: 'llm',
      name: 'gate',
      interpret: () => {
        calls += 1;
        if (calls <= 2) return Promise.reject(status(503));
        return new Promise<AiResponse>((resolve) => {
          release = resolve;
        });
      },
    };
    const { provider, advance } = setup(inner, { maxRetries: 0, failureThreshold: 2, cooldownMs: 1000 });
    for (let i = 0; i < 2; i += 1) await provider.interpret(request).catch(() => undefined);
    advance(1000);

    const trial = provider.interpret(request);
    const second = await provider.interpret(request).catch((e: unknown) => e);
    expect((second as AiUnavailableError).code).toBe('circuit_open');
    release(OK);
    await expect(trial).resolves.toEqual(OK);
  });
});

describe('caller abort', () => {
  it('does not keep retrying once the caller has given up', async () => {
    let calls = 0;
    const inner: LlmProvider = {
      kind: 'llm',
      name: 'aborting',
      interpret: (_r, options) =>
        new Promise<AiResponse>((_resolve, reject) => {
          calls += 1;
          options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    };
    const { provider } = setup(inner, { timeoutMs: 5000, maxRetries: 3 });
    const controller = new AbortController();
    const pending = provider.interpret(request, { signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    expect(await pending).toBeInstanceOf(AiUnavailableError);
    expect(calls).toBe(1);
  });
});
