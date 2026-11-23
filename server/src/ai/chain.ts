import { AiProviderError, AiUnavailableError } from './types.js';
import type { CallOptions, GenerateRequest, InterpretRequest, LlmProvider } from './types.js';
import type { AiResponse } from '@tajir/shared';

/** A provider that tries several in order. */
export interface ProviderChain extends LlmProvider {
  /** The names of all providers, in the order they are tried. */
  readonly order: string[];
  /** The same, with the model, for logs. */
  readonly labels: string[];
  /** The names of the providers after the first one. */
  readonly backups: string[];
}

/**
 * Tries the providers in order. The first one that gives a usable answer wins. When a provider has
 * failed for good (every retry used, a bad key, no credit, its circuit open), the next one is tried,
 * so a problem with one vendor does not cost the user the AI answer.
 *
 * Each provider already carries its own timeouts, retries and circuit breaker (see withResilience),
 * so a provider that keeps failing is skipped quickly instead of making every user wait for it.
 * Only when all of them fail does this throw, and the caller then answers with the built-in rules.
 */
export function createProviderChain(providers: LlmProvider[]): ProviderChain {
  if (providers.length === 0) throw new Error('A provider chain needs at least one provider');

  return {
    kind: 'llm',
    name: providers[0]!.name,
    order: providers.map((p) => p.name),
    labels: providers.map((p) => p.label ?? p.name),
    backups: providers.slice(1).map((p) => p.name),

    async generate(request: GenerateRequest, options: CallOptions = {}): Promise<unknown> {
      let last: AiUnavailableError | null = null;
      for (const provider of providers) {
        if (!provider.generate) continue;
        if (options.signal?.aborted) break;
        try {
          const answer = await provider.generate(request, options);
          options.onProvider?.(provider.label ?? provider.name);
          return answer;
        } catch (error) {
          if (error instanceof AiUnavailableError || error instanceof AiProviderError) {
            last = error instanceof AiUnavailableError ? error : new AiUnavailableError(error.code);
            options.onFailure?.(provider.name, last.code);
            continue;
          }
          throw error;
        }
      }
      throw last ?? new AiUnavailableError('unknown');
    },

    async interpret(request: InterpretRequest, options: CallOptions = {}): Promise<AiResponse> {
      let last: AiUnavailableError | null = null;
      for (const provider of providers) {
        if (options.signal?.aborted) break;
        try {
          const response = await provider.interpret(request, options);
          options.onProvider?.(provider.name);
          return response;
        } catch (error) {
          if (error instanceof AiUnavailableError || error instanceof AiProviderError) {
            last = error instanceof AiUnavailableError ? error : new AiUnavailableError(error.code);
            options.onFailure?.(provider.name, last.code);
            continue;
          }
          // Anything else is a fault in this code, not in a provider, and is not hidden by trying another.
          throw error;
        }
      }
      throw last ?? new AiUnavailableError('unknown');
    },
  };
}
