import { UNDERSTANDING_FIELDS, UNDERSTANDING_TYPES } from '@tajir/shared';
import type { UnderstandingType } from '@tajir/shared';
import { z } from 'zod';

/**
 * The shape the AI is asked to answer in. It is deliberately plain: every field is required and may be null, and
 * there are no length limits here, because some providers' strict modes refuse those. Lengths, grounding and the
 * claims check are applied afterwards, in code, to whatever comes back.
 */
const readingParts = {
  summary: z.string().nullable(),
  observations: z.array(z.string()),
};

export function wireSchemaFor(type: UnderstandingType | 'other') {
  const documentType = z.enum([...UNDERSTANDING_TYPES, 'other']);
  if (type === 'other') return z.object({ documentType, ...readingParts }).strict();
  const facts: Record<string, z.ZodType> = {};
  for (const field of UNDERSTANDING_FIELDS[type]) facts[field.key] = field.list ? z.array(z.string()) : z.string().nullable();
  return z.object({ documentType, facts: z.object(facts).strict(), ...readingParts }).strict();
}

/** The same shape as a JSON Schema, for the provider. */
export function jsonSchemaFor(type: UnderstandingType | 'other'): Record<string, unknown> {
  return z.toJSONSchema(wireSchemaFor(type), { target: 'draft-7' }) as Record<string, unknown>;
}
