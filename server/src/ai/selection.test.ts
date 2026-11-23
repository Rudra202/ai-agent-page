import { describe, expect, it } from 'vitest';
import { effectiveAiProviders } from '../config/env.js';
import { aiHealth } from '../routes/health.js';
import { createAiProvider, retriesFor } from './factory.js';
import { rulesProvider } from './types.js';

describe('choosing the assistant', () => {
  const pick = (AI_PROVIDER: 'auto' | 'gemini' | 'openai' | 'rules', GEMINI_API_KEY = '', OPENAI_API_KEY = '') => effectiveAiProviders({ AI_PROVIDER, GEMINI_API_KEY, OPENAI_API_KEY });

  it('puts Gemini first and OpenAI second when both keys are set', () => {
    expect(pick('auto', 'g-key', 'sk-key')).toEqual(['gemini', 'openai']);
  });

  it('uses whichever one has a key', () => {
    expect(pick('auto', 'g-key')).toEqual(['gemini']);
    expect(pick('auto', '', 'sk-key')).toEqual(['openai']);
  });

  it('uses the built-in rules when there is no key at all', () => {
    expect(pick('auto')).toEqual([]);
  });

  it('can be limited to one on purpose, and only with its key', () => {
    expect(pick('gemini', 'g-key', 'sk-key')).toEqual(['gemini']);
    expect(pick('openai', 'g-key', 'sk-key')).toEqual(['openai']);
    expect(pick('gemini', '', 'sk-key')).toEqual([]);
    expect(pick('openai', 'g-key')).toEqual([]);
  });

  it('never uses a model when the rules are chosen, even with keys', () => {
    expect(pick('rules', 'g-key', 'sk-key')).toEqual([]);
  });

  const base = { timeoutMs: 1000, maxRetries: 0, maxOutputTokens: 1500 };
  const keys = { geminiApiKey: 'test-key-not-used', openaiApiKey: 'test-key-not-used' };

  it('builds a chain: Gemini, a second Gemini model, then OpenAI', () => {
    const provider = createAiProvider({ ...base, ...keys, geminiModel: 'model-a', geminiFallbackModel: 'model-b', providers: ['gemini', 'openai'] });
    expect(provider).toMatchObject({
      kind: 'llm',
      name: 'gemini',
      order: ['gemini', 'gemini', 'openai'],
      labels: ['gemini (model-a)', 'gemini (model-b)', 'openai (gpt-4.1-mini)'],
    });
    // The backup named on the profile is the other vendor, not the second Gemini model.
    expect(aiHealth(provider)).toEqual({ ai: 'gemini', aiBackup: 'openai' });
  });

  it('does not add a second Gemini model when none is set or it is the same one', () => {
    expect((createAiProvider({ ...base, ...keys, geminiModel: 'model-a', providers: ['gemini', 'openai'] }) as { order: string[] }).order).toEqual(['gemini', 'openai']);
    expect((createAiProvider({ ...base, ...keys, geminiModel: 'model-a', geminiFallbackModel: 'model-a', providers: ['gemini', 'openai'] }) as { order: string[] }).order).toEqual(['gemini', 'openai']);
    expect((createAiProvider({ ...base, ...keys, geminiModel: 'model-a', geminiFallbackModel: '', providers: ['gemini'] }) as { name: string }).name).toBe('gemini');
  });

  it('builds a single resilient provider when only one model is available', () => {
    const gemini = createAiProvider({ ...base, ...keys, geminiFallbackModel: '', providers: ['gemini'] });
    expect(gemini).toMatchObject({ kind: 'llm', name: 'gemini' });
    expect(typeof (gemini as { circuitState?: unknown }).circuitState).toBe('function');
    expect(aiHealth(gemini)).toEqual({ ai: 'gemini', aiBackup: null });
    expect(aiHealth(createAiProvider({ ...base, ...keys, providers: ['openai'] }))).toEqual({ ai: 'openai', aiBackup: null });
  });

  it('skips a provider whose key is missing, and uses the rules when none is left', () => {
    expect(aiHealth(createAiProvider({ ...base, openaiApiKey: 'x', providers: ['gemini', 'openai'] }))).toEqual({ ai: 'openai', aiBackup: null });
    expect(createAiProvider({ ...base, providers: ['gemini', 'openai'] })).toBe(rulesProvider);
    expect(createAiProvider({ ...base, ...keys, providers: [] })).toBe(rulesProvider);
    expect(aiHealth(rulesProvider)).toEqual({ ai: 'rules', aiBackup: null });
  });
});

describe('retries when there is a backup', () => {
  it('lets a provider with a backup behind it retry once at most, and keeps the retries for the last one', () => {
    expect([0, 1, 2].map((position) => retriesFor(position, 3, 2))).toEqual([1, 1, 2]);
    expect([0, 1].map((position) => retriesFor(position, 2, 3))).toEqual([1, 3]);
  });

  it('never retries more than was configured', () => {
    expect([0, 1].map((position) => retriesFor(position, 2, 0))).toEqual([0, 0]);
  });

  it('keeps the configured retries when there is only one provider', () => {
    expect(retriesFor(0, 1, 2)).toBe(2);
    expect(retriesFor(0, 1, 0)).toBe(0);
  });
});
