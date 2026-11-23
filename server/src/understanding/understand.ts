import { randomBytes } from 'node:crypto';
import { isUnderstandingType } from '@tajir/shared';
import type { AiProvider } from '../ai/types.js';
import { AiInvalidOutputError, AiProviderError, AiUnavailableError } from '../ai/types.js';
import type { AiStatus } from '../domain/documents.js';
import type { ExtractionDeps } from '../extraction/pipeline.js';
import type { Repositories } from '../repositories/types.js';
import { buildUnderstandingPrompt } from './prompt.js';
import { MAX_AI_CHARS, redactForAi } from './redact.js';
import { jsonSchemaFor } from './schemas.js';
import { buildReading, UnusableReadingError } from './validate.js';

export interface UnderstandingDeps {
  ai: AiProvider;
  repos: Repositories;
  /** DOCUMENT_AI_ENABLED. When off, nothing is ever sent to a model. */
  enabled: boolean;
  /** Short operational messages. Never document text, never the AI's answer. */
  log?: (message: string) => void;
}

/** "gemini (gemini-3.5-flash-lite)" into its two parts. */
function splitLabel(label: string | undefined, fallback: string): { provider: string; model?: string } {
  const match = label ? /^([\w-]+) \((.+)\)$/.exec(label) : null;
  return match ? { provider: match[1]!, model: match[2]! } : { provider: fallback };
}

/**
 * The optional step after a document's text has been read: ask an AI model to fill in the details that document type
 * has, and keep the result apart as "facts" (checked against the text) and "interpretation" (the AI's own words).
 *
 * It only ever reads the text it is given and writes one thing: the reading, onto that document's extraction.
 * The model has no tools and no access to anything else, so a document that tries to give it orders can, at worst,
 * make it write something that the checks then remove. Without a model (the built-in rules), or with the step switched
 * off, the document is still read, and the result says the AI step was skipped.
 */
export function createUnderstandingStep(deps: UnderstandingDeps): NonNullable<ExtractionDeps['understand']> {
  const log = deps.log ?? (() => undefined);

  return async ({ doc, text, detectedType, signal }) => {
    if (!deps.enabled) return { aiStatus: 'not_requested' };

    const ai = deps.ai;
    if (ai.kind !== 'llm' || !ai.generate) {
      await deps.repos.extractions.setUnderstanding(doc.id, { structured: null, ai: { status: 'skipped', at: new Date() } });
      return { aiStatus: 'skipped' };
    }

    const type = isUnderstandingType(detectedType) ? detectedType : 'other';
    const excerpt = text.length > MAX_AI_CHARS ? text.slice(0, MAX_AI_CHARS) : text;
    const { text: redacted } = redactForAi(excerpt);
    const { system, user } = buildUnderstandingPrompt(type, redacted, randomBytes(12).toString('hex'));

    let answeredBy: string | undefined;
    const record = async (status: AiStatus, extra: { error?: string; provider?: string; model?: string } = {}) =>
      deps.repos.extractions.setUnderstanding(doc.id, { structured: null, ai: { status, at: new Date(), ...extra } });

    try {
      const answer = await ai.generate({ system, user, schema: jsonSchemaFor(type), schemaName: 'document_reading', maxOutputTokens: 1500 }, { signal, onProvider: (name) => (answeredBy = name) });
      const { reading, aiType } = buildReading(type, answer, text);
      if (text.length > MAX_AI_CHARS) reading.notes.push('Only the first part of this long document was read by the AI.');
      const who = splitLabel(answeredBy ?? ai.label, ai.name);
      // The AI's own view of the type is used only to name a document the text rules could not place.
      const betterType = type === 'other' && isUnderstandingType(aiType) ? aiType : undefined;
      if (betterType) reading.notes.push(`The AI thinks this is a ${betterType.replace('_', ' ')}. Press "read again" to fill in its details.`);
      await deps.repos.extractions.setUnderstanding(doc.id, {
        structured: reading as unknown as Record<string, unknown>,
        ai: { status: 'completed', provider: who.provider, ...(who.model ? { model: who.model } : {}), at: new Date() },
        ...(betterType ? { detectedType: betterType } : {}),
      });
      return { aiStatus: 'completed', ...(betterType ? { detectedType: betterType } : {}) };
    } catch (error) {
      // Only a code is kept: provider and validation messages can quote the document.
      if (error instanceof AiUnavailableError) {
        await record('unavailable', { error: error.code });
        log(`[documents] AI reading unavailable for ${doc.id} (${error.code})`);
        return { aiStatus: 'unavailable', message: 'The text was read, but the AI analysis was not available just now.' };
      }
      const code = error instanceof UnusableReadingError || error instanceof AiInvalidOutputError ? 'invalid_output' : error instanceof AiProviderError ? error.code : 'unknown';
      await record('failed', { error: code });
      log(`[documents] AI reading failed for ${doc.id} (${code})`);
      return { aiStatus: 'failed', message: 'The text was read, but the AI analysis could not be completed.' };
    }
  };
}
