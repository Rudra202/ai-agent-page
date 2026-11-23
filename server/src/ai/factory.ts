import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { createProviderChain } from './chain.js';
import { createGeminiProvider } from './gemini.js';
import type { GeminiClientLike } from './gemini.js';
import { createOpenAiProvider } from './openai.js';
import type { OpenAiClientLike } from './openai.js';
import { withResilience } from './resilient.js';
import type { AiCallEvent } from './resilient.js';
import { rulesProvider } from './types.js';
import type { AiProvider, LlmProvider } from './types.js';

export interface AiSettings {
  /** The models to use, in the order they are tried. A model without a key below is skipped. Empty means the built-in rules. */
  providers: Array<'gemini' | 'openai'>;
  geminiApiKey?: string;
  geminiModel?: string;
  /** A second Gemini model tried when the first fails. Skipped when empty or the same as the first. */
  geminiFallbackModel?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
}

/**
 * Builds the assistant. Each model gets its own timeout, retries and circuit breaker, and they are tried
 * in the order given, so a problem with the first (no quota, an outage, a bad key) falls through to the next.
 * Without any usable model the built-in rules are used. To add another vendor, add a case here.
 * The SDKs' own retries are off: the resilience wrapper owns retries, timeouts and backoff.
 */
/**
 * How many times a provider retries itself. One that has a backup behind it retries at most once and then lets
 * the backup answer, because an overloaded model can take many seconds to fail and the user is waiting.
 * The last one in the list keeps the configured retries, since nothing is left after it but the built-in rules.
 */
export function retriesFor(position: number, total: number, configured: number): number {
  return position < total - 1 ? Math.min(1, configured) : configured;
}

export function createAiProvider(settings: AiSettings, onEvent?: (event: AiCallEvent) => void): AiProvider {
  // The providers to build, in order, so each knows whether a backup follows it.
  const plan: Array<{ name: 'gemini' | 'openai'; model: string }> = [];
  for (const name of settings.providers) {
    if (name === 'gemini' && settings.geminiApiKey) {
      const primary = settings.geminiModel ?? 'gemini-3.5-flash-lite';
      plan.push({ name, model: primary });
      // One overloaded model should not cost the user the answer, so a second one comes next, on the same key.
      if (settings.geminiFallbackModel && settings.geminiFallbackModel !== primary) plan.push({ name, model: settings.geminiFallbackModel });
    } else if (name === 'openai' && settings.openaiApiKey) {
      plan.push({ name, model: settings.openaiModel ?? 'gpt-4.1-mini' });
    }
  }

  const resilience = (name: string, position: number) => ({
    timeoutMs: settings.timeoutMs,
    maxRetries: retriesFor(position, plan.length, settings.maxRetries),
    onEvent: onEvent ? (event: AiCallEvent) => onEvent({ ...event, provider: name } as AiCallEvent) : undefined,
  });

  const geminiClient = settings.geminiApiKey ? new GoogleGenAI({ apiKey: settings.geminiApiKey, httpOptions: { timeout: settings.timeoutMs + 2000 } }) : null;
  const openaiClient = settings.openaiApiKey ? new OpenAI({ apiKey: settings.openaiApiKey, maxRetries: 0, timeout: settings.timeoutMs + 2000 }) : null;

  const built: LlmProvider[] = plan.map(({ name, model }, position) => {
    const inner =
      name === 'gemini'
        ? createGeminiProvider({ client: geminiClient as unknown as GeminiClientLike, model, maxOutputTokens: settings.maxOutputTokens })
        : createOpenAiProvider({ client: openaiClient as unknown as OpenAiClientLike, model, maxOutputTokens: settings.maxOutputTokens });
    return withResilience(inner, resilience(name, position));
  });

  if (built.length === 0) return rulesProvider;
  return built.length === 1 ? built[0]! : createProviderChain(built);
}
