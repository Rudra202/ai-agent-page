import { describe, expect, it } from 'vitest';
import { createProviderChain } from './chain.js';
import { createGeminiProvider } from './gemini.js';
import type { GeminiClientLike, GeminiResponse } from './gemini.js';
import { createOpenAiProvider } from './openai.js';
import type { OpenAiClientLike, ParsedCompletion } from './openai.js';
import { withResilience } from './resilient.js';
import { AiInvalidOutputError, AiProviderError, AiUnavailableError } from './types.js';
import type { GenerateRequest, LlmProvider } from './types.js';

const request: GenerateRequest = {
  system: 'Read the document.',
  user: '<document>Licence No 1</document>',
  schema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
  schemaName: 'doc_reading',
};

describe('Gemini generate', () => {
  function client(reply: GeminiResponse | Error) {
    const calls: Array<{ model: string; contents: string; config: Record<string, unknown> }> = [];
    const fake: GeminiClientLike = {
      models: {
        async generateContent(params) {
          calls.push(params);
          if (reply instanceof Error) throw reply;
          return reply;
        },
      },
    };
    return { fake, calls };
  }

  it('asks for JSON in the given shape, with the instructions and the material kept apart, and returns the parsed answer', async () => {
    const { fake, calls } = client({ text: '{"a":"x"}' });
    const signal = new AbortController().signal;
    const answer = await createGeminiProvider({ client: fake, model: 'm' }).generate!({ ...request, timeoutMs: 30_000 }, { signal });
    expect(answer).toEqual({ a: 'x' });
    expect(calls[0]).toMatchObject({ model: 'm', contents: request.user });
    expect(calls[0]!.config).toMatchObject({ systemInstruction: request.system, responseMimeType: 'application/json', temperature: 0.1, abortSignal: signal, httpOptions: { timeout: 30_000 } });
    // The schema marker is removed: Gemini does not accept it.
    expect(calls[0]!.config.responseJsonSchema).not.toHaveProperty('$schema');
    expect(calls[0]!.config.responseJsonSchema).toMatchObject({ type: 'object' });
  });

  it('treats an unusable answer as invalid output, a block as a refusal, and a client error as a classified failure', async () => {
    await expect(createGeminiProvider({ client: client({ text: 'not json' }).fake, model: 'm' }).generate!(request)).rejects.toBeInstanceOf(AiInvalidOutputError);
    await expect(createGeminiProvider({ client: client({ text: '{"a":"x"', candidates: [{ finishReason: 'MAX_TOKENS' }] }).fake, model: 'm' }).generate!(request)).rejects.toBeInstanceOf(AiInvalidOutputError);
    await expect(createGeminiProvider({ client: client({ promptFeedback: { blockReason: 'SAFETY' } }).fake, model: 'm' }).generate!(request)).rejects.toMatchObject({ code: 'refusal' });
    await expect(createGeminiProvider({ client: client({ text: '{}', candidates: [{ finishReason: 'SAFETY' }] }).fake, model: 'm' }).generate!(request)).rejects.toMatchObject({ code: 'refusal' });
    await expect(createGeminiProvider({ client: client(Object.assign(new Error('Too many requests'), { status: 429 })).fake, model: 'm' }).generate!(request)).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
  });
});

describe('OpenAI generate', () => {
  function client(reply: ParsedCompletion | Error) {
    const calls: Array<{ body: Record<string, unknown>; options?: { signal?: AbortSignal; timeout?: number } }> = [];
    const fake: OpenAiClientLike = {
      chat: {
        completions: {
          async parse(body, options) {
            calls.push({ body, options });
            if (reply instanceof Error) throw reply;
            return reply;
          },
        },
      },
    };
    return { fake, calls };
  }
  const answer = (content: string, extra: Partial<ParsedCompletion['choices'][0]> = {}): ParsedCompletion => ({ choices: [{ finish_reason: 'stop', message: { content }, ...extra }] });

  it('sends a strict JSON schema, keeps the instructions apart from the material, and does not store the request', async () => {
    const { fake, calls } = client(answer('{"a":"x"}'));
    const result = await createOpenAiProvider({ client: fake, model: 'm' }).generate!({ ...request, timeoutMs: 30_000 });
    expect(result).toEqual({ a: 'x' });
    expect(calls[0]!.body).toMatchObject({
      model: 'm',
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'doc_reading', strict: true, schema: request.schema } },
      store: false,
      temperature: 0.1,
    });
    expect(calls[0]!.options).toMatchObject({ timeout: 30_000 });
  });

  it('prefers what the SDK already parsed, and reports refusals, cut-off and bad JSON', async () => {
    expect(await createOpenAiProvider({ client: client({ choices: [{ message: { parsed: { a: 'p' }, content: '{"a":"c"}' } }] }).fake, model: 'm' }).generate!(request)).toEqual({ a: 'p' });
    await expect(createOpenAiProvider({ client: client({ choices: [{ message: { refusal: 'no' } }] }).fake, model: 'm' }).generate!(request)).rejects.toMatchObject({ code: 'refusal' });
    await expect(createOpenAiProvider({ client: client(answer('{"a":', { finish_reason: 'length' })).fake, model: 'm' }).generate!(request)).rejects.toBeInstanceOf(AiInvalidOutputError);
    await expect(createOpenAiProvider({ client: client(answer('nope')).fake, model: 'm' }).generate!(request)).rejects.toBeInstanceOf(AiInvalidOutputError);
    await expect(createOpenAiProvider({ client: client({ choices: [] }).fake, model: 'm' }).generate!(request)).rejects.toBeInstanceOf(AiInvalidOutputError);
    await expect(createOpenAiProvider({ client: client(Object.assign(new Error('quota'), { status: 429, code: 'insufficient_quota' })).fake, model: 'm' }).generate!(request)).rejects.toMatchObject({ code: 'quota_exhausted', retryable: false });
  });
});

describe('resilience around generate', () => {
  const fast = { sleep: async () => undefined, random: () => 0 };
  const provider = (generate: LlmProvider['generate']): LlmProvider => ({ kind: 'llm', name: 'fake', interpret: async () => { throw new Error('not used'); }, generate });

  it('retries a transient failure and returns the answer', async () => {
    let calls = 0;
    const wrapped = withResilience(
      provider(async () => {
        calls += 1;
        if (calls === 1) throw new AiProviderError('rate_limited', { retryable: true });
        return { a: 'ok' };
      }),
      { timeoutMs: 1000, maxRetries: 2, ...fast },
    );
    expect(await wrapped.generate!(request)).toEqual({ a: 'ok' });
    expect(calls).toBe(2);
  });

  it('asks again once when the answer was unusable, then gives up as unavailable', async () => {
    let calls = 0;
    const wrapped = withResilience(
      provider(async () => {
        calls += 1;
        throw new AiInvalidOutputError('not json');
      }),
      { timeoutMs: 1000, maxRetries: 2, ...fast },
    );
    await expect(wrapped.generate!(request)).rejects.toBeInstanceOf(AiUnavailableError);
    expect(calls).toBe(2);
  });

  it('gives document reading more time than a chat message, and tells the provider how much', async () => {
    const seen: Array<number | undefined> = [];
    const wrapped = withResilience(
      provider(async (r) => {
        seen.push(r.timeoutMs);
        return { a: 'ok' };
      }),
      { timeoutMs: 40, maxRetries: 0, ...fast },
    );
    await wrapped.generate!(request);
    expect(seen).toEqual([80]);

    const slow = withResilience(provider(() => new Promise((resolve) => setTimeout(() => resolve({ a: 'late' }), 60))), { timeoutMs: 40, maxRetries: 0, generateTimeoutMs: 20, ...fast });
    await expect(slow.generate!(request)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('opens the circuit after repeated failures, shared with interpret', async () => {
    const wrapped = withResilience(provider(async () => { throw new AiProviderError('server_error', { retryable: false }); }), { timeoutMs: 1000, maxRetries: 0, failureThreshold: 2, ...fast });
    await expect(wrapped.generate!(request)).rejects.toBeInstanceOf(AiUnavailableError);
    await expect(wrapped.generate!(request)).rejects.toBeInstanceOf(AiUnavailableError);
    await expect(wrapped.generate!(request)).rejects.toMatchObject({ code: 'circuit_open' });
    expect(wrapped.circuitState()).toBe('open');
  });

  it('has no generate when the provider has none', () => {
    const wrapped = withResilience({ kind: 'llm', name: 'x', interpret: async () => { throw new Error('x'); } }, { timeoutMs: 100, maxRetries: 0 });
    expect(wrapped.generate).toBeUndefined();
  });

  it('stops retrying when the caller has given up', async () => {
    let calls = 0;
    const controller = new AbortController();
    const wrapped = withResilience(
      provider(async () => {
        calls += 1;
        controller.abort();
        throw new AiProviderError('timeout', { retryable: true });
      }),
      { timeoutMs: 1000, maxRetries: 3, ...fast },
    );
    await expect(wrapped.generate!(request, { signal: controller.signal })).rejects.toBeInstanceOf(AiUnavailableError);
    expect(calls).toBe(1);
  });
});

describe('a chain of providers asked to generate', () => {
  const failing = (code: 'timeout' | 'rate_limited' = 'timeout'): LlmProvider => ({ kind: 'llm', name: 'first', interpret: async () => { throw new Error('x'); }, generate: async () => { throw new AiUnavailableError(code); } });
  const working = (name: string, value: unknown): LlmProvider => ({ kind: 'llm', name, label: `${name} (model)`, interpret: async () => { throw new Error('x'); }, generate: async () => value });
  const interpretOnly: LlmProvider = { kind: 'llm', name: 'chat-only', interpret: async () => { throw new Error('x'); } };

  it('falls through to the next provider and reports who answered and who failed', async () => {
    const answered: string[] = [];
    const failed: Array<[string, string]> = [];
    const chain = createProviderChain([failing('rate_limited'), working('second', { a: 'b' })]);
    expect(await chain.generate!(request, { onProvider: (n) => answered.push(n), onFailure: (n, c) => failed.push([n, c]) })).toEqual({ a: 'b' });
    expect(answered).toEqual(['second (model)']);
    expect(failed).toEqual([['first', 'rate_limited']]);
  });

  it('skips providers that cannot generate, and says unavailable when none can', async () => {
    expect(await createProviderChain([interpretOnly, working('w', { ok: true })]).generate!(request)).toEqual({ ok: true });
    await expect(createProviderChain([interpretOnly]).generate!(request)).rejects.toMatchObject({ code: 'unknown' });
    await expect(createProviderChain([failing(), failing()]).generate!(request)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('does not hide a programming error by trying the next provider', async () => {
    const broken: LlmProvider = { kind: 'llm', name: 'broken', interpret: async () => { throw new Error('x'); }, generate: async () => { throw new TypeError('bug'); } };
    await expect(createProviderChain([broken, working('w', {})]).generate!(request)).rejects.toThrow(TypeError);
  });
});
