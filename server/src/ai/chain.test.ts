import { FALLBACK_AI_RESPONSE } from '@tajir/shared';
import type { AiResponse, InterpretContext } from '@tajir/shared';
import { describe, expect, it, vi } from 'vitest';
import { createProviderChain } from './chain.js';
import { withResilience } from './resilient.js';
import { AiProviderError, AiUnavailableError } from './types.js';
import type { InterpretRequest, LlmProvider } from './types.js';

const request: InterpretRequest = { text: 'hello', context: {} as InterpretContext };
const answer = (message: string): AiResponse => ({ ...FALLBACK_AI_RESPONSE, intent: 'answer_question', message });

/** A provider that plays back a script of answers or errors, one per call. */
function scripted(name: string, steps: Array<AiResponse | Error>): LlmProvider & { calls: number } {
  const provider = {
    kind: 'llm' as const,
    name,
    calls: 0,
    async interpret() {
      const step = steps[Math.min(provider.calls, steps.length - 1)]!;
      provider.calls += 1;
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return provider;
}

const unavailable = (code: ConstructorParameters<typeof AiUnavailableError>[0]) => new AiUnavailableError(code);

describe('the provider chain', () => {
  it('uses the first provider when it works, and never calls the second', async () => {
    const gemini = scripted('gemini', [answer('from gemini')]);
    const openai = scripted('openai', [answer('from openai')]);
    const chain = createProviderChain([gemini, openai]);
    const onProvider = vi.fn();
    await expect(chain.interpret(request, { onProvider })).resolves.toMatchObject({ message: 'from gemini' });
    expect(onProvider).toHaveBeenCalledWith('gemini');
    expect(openai.calls).toBe(0);
  });

  it('falls through to the second provider when the first has failed for good, and says which answered', async () => {
    const gemini = scripted('gemini', [unavailable('server_error')]);
    const openai = scripted('openai', [answer('from openai')]);
    const chain = createProviderChain([gemini, openai]);
    const onProvider = vi.fn();
    const onFailure = vi.fn();
    await expect(chain.interpret(request, { onProvider, onFailure })).resolves.toMatchObject({ message: 'from openai' });
    expect(onFailure).toHaveBeenCalledWith('gemini', 'server_error');
    expect(onProvider).toHaveBeenCalledWith('openai');
  });

  it.each(['quota_exhausted', 'auth', 'not_found', 'timeout', 'rate_limited', 'invalid_output', 'refusal', 'circuit_open'] as const)(
    'moves on after %s',
    async (code) => {
      const chain = createProviderChain([scripted('gemini', [unavailable(code)]), scripted('openai', [answer('backup')])]);
      await expect(chain.interpret(request)).resolves.toMatchObject({ message: 'backup' });
    },
  );

  it('also moves on when a provider throws a raw provider error instead of the wrapped one', async () => {
    const chain = createProviderChain([scripted('gemini', [new AiProviderError('auth', { retryable: false })]), scripted('openai', [answer('backup')])]);
    await expect(chain.interpret(request)).resolves.toMatchObject({ message: 'backup' });
  });

  it('throws only when every provider has failed, with the last failure, so the rules can answer', async () => {
    const chain = createProviderChain([scripted('gemini', [unavailable('server_error')]), scripted('openai', [unavailable('quota_exhausted')])]);
    const onFailure = vi.fn();
    const error = await chain.interpret(request, { onFailure }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect((error as AiUnavailableError).code).toBe('quota_exhausted');
    expect(onFailure.mock.calls.map((c) => c[0])).toEqual(['gemini', 'openai']);
  });

  it('does not hide a bug in this code by trying another provider', async () => {
    const openai = scripted('openai', [answer('backup')]);
    const chain = createProviderChain([scripted('gemini', [new TypeError('x is not a function')]), openai]);
    await expect(chain.interpret(request)).rejects.toThrow('x is not a function');
    expect(openai.calls).toBe(0);
  });

  it('stops trying when the caller has given up', async () => {
    const openai = scripted('openai', [answer('backup')]);
    const chain = createProviderChain([scripted('gemini', [unavailable('timeout')]), openai]);
    const controller = new AbortController();
    controller.abort();
    await expect(chain.interpret(request, { signal: controller.signal })).rejects.toBeInstanceOf(AiUnavailableError);
    expect(openai.calls).toBe(0);
  });

  it('reports its order, so the health report and the logs can name them', () => {
    const chain = createProviderChain([scripted('gemini', []), scripted('openai', [])]);
    expect(chain.name).toBe('gemini');
    expect(chain.order).toEqual(['gemini', 'openai']);
    expect(chain.backups).toEqual(['openai']);
    expect(() => createProviderChain([])).toThrow();
  });

  describe('with the real retry and breaker wrapper on each provider', () => {
    const failing = (status: number): LlmProvider & { calls: number } => {
      const p = {
        kind: 'llm' as const,
        name: 'gemini',
        calls: 0,
        async interpret(): Promise<AiResponse> {
          p.calls += 1;
          throw Object.assign(new Error('down'), { status });
        },
      };
      return p;
    };
    const wrap = (inner: LlmProvider) => withResilience(inner, { timeoutMs: 1000, maxRetries: 1, failureThreshold: 2, cooldownMs: 60_000, sleep: async () => undefined, random: () => 0 });

    it('retries the first provider before giving up on it, then uses the backup', async () => {
      const gemini = failing(503);
      const chain = createProviderChain([wrap(gemini), wrap(scripted('openai', [answer('backup')]))]);
      await expect(chain.interpret(request)).resolves.toMatchObject({ message: 'backup' });
      // One first call and one retry.
      expect(gemini.calls).toBe(2);
    });

    it('skips a provider whose breaker is open, so users do not wait for it', async () => {
      const gemini = failing(503);
      const openai = scripted('openai', [answer('backup')]);
      const chain = createProviderChain([wrap(gemini), wrap(openai)]);
      for (let i = 0; i < 2; i += 1) await chain.interpret(request);
      const before = gemini.calls;
      await expect(chain.interpret(request)).resolves.toMatchObject({ message: 'backup' });
      expect(gemini.calls).toBe(before);
    });

    it('does not retry a bad key or an empty account, and goes straight to the backup', async () => {
      const gemini = failing(401);
      const chain = createProviderChain([wrap(gemini), wrap(scripted('openai', [answer('backup')]))]);
      await chain.interpret(request);
      expect(gemini.calls).toBe(1);
    });
  });
});
