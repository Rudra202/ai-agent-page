import { aiWireSchema, fromWire } from '@tajir/shared';
import { z } from 'zod';
import { buildMessages } from './prompt.js';
import { AiInvalidOutputError, AiProviderError, classifyError } from './types.js';
import type { CallOptions, GenerateRequest, InterpretRequest, LlmProvider } from './types.js';

/** The part of the Google Gen AI client this provider uses. Keeping it narrow makes the provider easy to test. */
export interface GeminiClientLike {
  models: {
    generateContent(params: { model: string; contents: string; config: Record<string, unknown> }): Promise<GeminiResponse>;
  };
}

export interface GeminiResponse {
  /** The reply text. With a JSON schema set, this is the JSON document. */
  text?: string;
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{ finishReason?: string }>;
}

export interface GeminiProviderOptions {
  client: GeminiClientLike;
  model: string;
  /** Upper bound for the answer. Gemini counts its own reasoning against this, so it is kept generous. */
  maxOutputTokens?: number;
}

/**
 * The JSON Schema Gemini is asked to follow. It is derived from the same shared contract as the
 * OpenAI schema. Gemini accepts a subset of JSON Schema, so the `$schema` marker is removed.
 */
export function geminiResponseSchema(): Record<string, unknown> {
  const { $schema: _marker, ...schema } = z.toJSONSchema(aiWireSchema, { target: 'draft-7' }) as Record<string, unknown>;
  return schema;
}

const REFUSED_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

/**
 * Google Gemini through the official SDK, using a JSON response schema: the reply must match the
 * shared contract and is validated again here before it is returned. Nothing is sent that
 * identifies the user.
 */
export function createGeminiProvider({ client, model, maxOutputTokens = 1500 }: GeminiProviderOptions): LlmProvider {
  const responseJsonSchema = geminiResponseSchema();

  return {
    kind: 'llm',
    name: 'gemini',
    label: `gemini (${model})`,

    async generate(request: GenerateRequest, options: CallOptions = {}) {
      const { $schema: _marker, ...schema } = request.schema;
      let response: GeminiResponse;
      try {
        response = await client.models.generateContent({
          model,
          contents: request.user,
          config: {
            systemInstruction: request.system,
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
            // Reading facts out of a document must be steady, not creative.
            temperature: 0.1,
            maxOutputTokens: Math.max(request.maxOutputTokens ?? maxOutputTokens, 1024),
            abortSignal: options.signal,
            ...(request.timeoutMs ? { httpOptions: { timeout: request.timeoutMs } } : {}),
          },
        });
      } catch (error) {
        throw classifyError(error);
      }
      if (response.promptFeedback?.blockReason) throw new AiProviderError('refusal', { retryable: false, message: 'The model declined to answer' });
      const finish = response.candidates?.[0]?.finishReason;
      if (finish && REFUSED_FINISH.has(finish)) throw new AiProviderError('refusal', { retryable: false, message: 'The model declined to answer' });
      if (finish === 'MAX_TOKENS') throw new AiInvalidOutputError('the reply was cut off');
      try {
        return JSON.parse(response.text ?? '') as unknown;
      } catch {
        throw new AiInvalidOutputError('the reply was not valid JSON');
      }
    },

    async interpret(request: InterpretRequest, options: CallOptions = {}) {
      const [system, user] = buildMessages(request);

      let response: GeminiResponse;
      try {
        response = await client.models.generateContent({
          model,
          contents: user!.content,
          config: {
            systemInstruction: system!.content,
            responseMimeType: 'application/json',
            responseJsonSchema,
            // Low temperature: reading a message into fields should be steady, not creative.
            temperature: 0.3,
            maxOutputTokens: Math.max(maxOutputTokens, 1024),
            abortSignal: options.signal,
          },
        });
      } catch (error) {
        throw classifyError(error);
      }

      if (response.promptFeedback?.blockReason) throw new AiProviderError('refusal', { retryable: false, message: 'The model declined to answer' });
      const finish = response.candidates?.[0]?.finishReason;
      if (finish && REFUSED_FINISH.has(finish)) throw new AiProviderError('refusal', { retryable: false, message: 'The model declined to answer' });
      if (finish === 'MAX_TOKENS') throw new AiInvalidOutputError('the reply was cut off');

      let candidate: unknown;
      try {
        candidate = JSON.parse(response.text ?? '');
      } catch {
        throw new AiInvalidOutputError('the reply was not valid JSON');
      }

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
