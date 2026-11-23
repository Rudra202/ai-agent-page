import { aiWireSchema, fromWire } from '@tajir/shared';
import { zodResponseFormat } from 'openai/helpers/zod';
import { buildMessages } from './prompt.js';
import { AiInvalidOutputError, AiProviderError, classifyError } from './types.js';
import type { CallOptions, GenerateRequest, InterpretRequest, LlmProvider } from './types.js';

/** The part of the OpenAI client this provider uses. Keeping it narrow makes the provider easy to test. */
export interface OpenAiClientLike {
  chat: {
    completions: {
      parse(body: Record<string, unknown>, options?: { signal?: AbortSignal; timeout?: number }): Promise<ParsedCompletion>;
    };
  };
}

export interface ParsedCompletion {
  choices: Array<{
    finish_reason?: string | null;
    message: { content?: string | null; refusal?: string | null; parsed?: unknown };
  }>;
}

export interface OpenAiProviderOptions {
  client: OpenAiClientLike;
  model: string;
  /** Upper bound for the answer. The structured reply is small. */
  maxOutputTokens?: number;
}

/**
 * OpenAI through the official SDK, using structured outputs: the reply must match
 * the strict schema derived from the shared Zod contract, and it is validated again
 * here before it is returned. Nothing is sent that identifies the user.
 */
export function createOpenAiProvider({ client, model, maxOutputTokens = 500 }: OpenAiProviderOptions): LlmProvider {
  const responseFormat = zodResponseFormat(aiWireSchema, 'tajir_interpretation');

  return {
    kind: 'llm',
    name: 'openai',
    label: `openai (${model})`,

    async generate(request: GenerateRequest, options: CallOptions = {}) {
      let completion: ParsedCompletion;
      try {
        completion = await client.chat.completions.parse(
          {
            model,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
            response_format: { type: 'json_schema', json_schema: { name: request.schemaName, strict: true, schema: request.schema } },
            max_completion_tokens: Math.max(request.maxOutputTokens ?? maxOutputTokens, 800),
            temperature: 0.1,
            store: false,
          },
          { signal: options.signal, ...(request.timeoutMs ? { timeout: request.timeoutMs } : {}) },
        );
      } catch (error) {
        throw classifyError(error);
      }
      const choice = completion.choices?.[0];
      if (!choice) throw new AiInvalidOutputError('the reply had no choices');
      if (choice.message.refusal) throw new AiProviderError('refusal', { retryable: false, message: 'The model declined to answer' });
      if (choice.finish_reason === 'length') throw new AiInvalidOutputError('the reply was cut off');
      if (choice.finish_reason === 'content_filter') throw new AiInvalidOutputError('the reply was filtered');
      if (choice.message.parsed !== undefined && choice.message.parsed !== null) return choice.message.parsed;
      try {
        return JSON.parse(choice.message.content ?? '') as unknown;
      } catch {
        throw new AiInvalidOutputError('the reply was not valid JSON');
      }
    },

    async interpret(request: InterpretRequest, options: CallOptions = {}) {
      let completion: ParsedCompletion;
      try {
        completion = await client.chat.completions.parse(
          {
            model,
            messages: buildMessages(request),
            response_format: responseFormat,
            max_completion_tokens: maxOutputTokens,
            // Requests are not stored for training or retention beyond what the account allows.
            store: false,
          },
          { signal: options.signal },
        );
      } catch (error) {
        throw classifyError(error);
      }

      const choice = completion.choices?.[0];
      if (!choice) throw new AiInvalidOutputError('the reply had no choices');
      if (choice.message.refusal) throw new AiProviderError('refusal', { retryable: false, message: 'The model declined to answer' });
      if (choice.finish_reason === 'length') throw new AiInvalidOutputError('the reply was cut off');
      if (choice.finish_reason === 'content_filter') throw new AiInvalidOutputError('the reply was filtered');

      let candidate: unknown = choice.message.parsed;
      if (candidate === undefined || candidate === null) {
        try {
          candidate = JSON.parse(choice.message.content ?? '');
        } catch {
          throw new AiInvalidOutputError('the reply was not valid JSON');
        }
      }

      // The SDK has parsed the reply already. It is checked again so that nothing unvalidated gets through.
      const wire = aiWireSchema.safeParse(candidate);
      if (!wire.success) throw new AiInvalidOutputError('the reply did not match the schema');
      try {
        return fromWire(wire.data);
      } catch {
        throw new AiInvalidOutputError('a value broke the contract');
      }
    },
  };
}
