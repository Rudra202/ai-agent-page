import { z } from 'zod';
import { REGISTRATION_TYPES, WORKFLOW_TYPES } from './workflow.js';

/**
 * The contract between an AI model (or the rules-based mock) and the backend.
 *
 * An AI response is a PROPOSAL. It says what the user seems to want and which
 * values they stated. The workflow engine validates every value against the
 * schemas and the catalogue, decides which step is allowed, and writes all
 * factual content itself. Nothing in a response can change a record.
 */

export const AI_INTENTS = [
  'greet',
  'start_company',
  'working_capital',
  'explore_services',
  'select_registration_type',
  'collect_business_details',
  'suggest_jurisdiction',
  'present_packages',
  'select_package',
  'review',
  'confirm_submission',
  'clarification',
  'upload_document',
  'check_status',
  'unsupported',
  'answer_question',
  'unknown',
] as const;
export type AiIntent = (typeof AI_INTENTS)[number];

/** Intents that are about filling in the current workflow, as opposed to chatting or branching away from it. */
export const FIELD_INTENTS: readonly AiIntent[] = [
  'start_company',
  'working_capital',
  'select_registration_type',
  'collect_business_details',
  'suggest_jurisdiction',
  'present_packages',
  'select_package',
  'review',
  'confirm_submission',
  'clarification',
];

export const aiOptionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  description: z.string().max(300).optional(),
});
export type AiOption = z.infer<typeof aiOptionSchema>;

/**
 * Values the user stated. All optional, all re-validated by the engine, and none is
 * ever trusted on its own: an id must exist in the catalogue and belong to the
 * current choices, a number must pass the same limits as typed input.
 */
export const aiExtractedSchema = z
  .object({
    registrationType: z.enum(REGISTRATION_TYPES).optional(),
    jurisdictionId: z.string().min(1).max(64).optional(),
    packageId: z.string().min(1).max(96).optional(),
    activity: z.string().min(1).max(80).optional(),
    companyName: z.string().min(1).max(80).optional(),
    shareholders: z.number().optional(),
    description: z.string().max(500).optional(),
    financeAmount: z.number().optional(),
    financePurpose: z.string().min(1).max(120).optional(),
    informationAnswer: z.string().min(1).max(120).optional(),
    /** True only for a clear "yes" to a yes/no question that is pending. */
    affirmative: z.boolean().optional(),
  })
  .strict();
export type AiExtracted = z.infer<typeof aiExtractedSchema>;

export const aiResponseSchema = z.object({
  intent: z.enum(AI_INTENTS),
  message: z.string().min(1).max(2000),
  options: z.array(aiOptionSchema).max(8).optional(),
  quickReplies: z.array(z.string().min(1).max(60)).max(6).optional(),
  extracted: aiExtractedSchema.optional(),
  workflow: z
    .object({
      type: z.enum(WORKFLOW_TYPES).nullable(),
      currentStep: z.string().min(1).max(64).nullable(),
    })
    .optional(),
  requiresConfirmation: z.boolean().optional(),
});
export type AiResponse = z.infer<typeof aiResponseSchema>;

/** Safe fallback used when the model returns something that does not validate. */
export const FALLBACK_AI_RESPONSE: AiResponse = {
  intent: 'unknown',
  message: 'Sorry, I did not quite get that. Could you rephrase, or pick one of the options below?',
  quickReplies: ['Start a company', 'Working Capital Finance', 'Explore business services'],
};

// ------------------------------------------------------------ the wire format

/**
 * What a model is asked to return. Strict structured outputs need every field present
 * and no open-ended objects, so each value is nullable instead of optional. It is a
 * subset of the contract above: the model is never asked for options, quick replies
 * or workflow state, because it does not get to decide those.
 */
export const aiWireSchema = z.object({
  intent: z.enum(AI_INTENTS),
  message: z.string(),
  registrationType: z.enum(REGISTRATION_TYPES).nullable(),
  jurisdictionId: z.string().nullable(),
  packageId: z.string().nullable(),
  activity: z.string().nullable(),
  companyName: z.string().nullable(),
  shareholders: z.number().nullable(),
  description: z.string().nullable(),
  financeAmount: z.number().nullable(),
  financePurpose: z.string().nullable(),
  informationAnswer: z.string().nullable(),
  affirmative: z.boolean().nullable(),
});
export type AiWire = z.infer<typeof aiWireSchema>;

const EXTRACTED_KEYS = [
  'registrationType',
  'jurisdictionId',
  'packageId',
  'activity',
  'companyName',
  'shareholders',
  'description',
  'financeAmount',
  'financePurpose',
  'informationAnswer',
  'affirmative',
] as const;

/**
 * Turns the wire format into the contract. Nulls and empty strings become "not
 * stated" (an empty description is kept: it means the user chose to skip it). It
 * throws a ZodError if a value breaks the contract, for example an overlong name.
 */
export function fromWire(wire: AiWire): AiResponse {
  const extracted: Record<string, unknown> = {};
  for (const key of EXTRACTED_KEYS) {
    const value = wire[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '' && key !== 'description') continue;
      extracted[key] = trimmed;
    } else {
      extracted[key] = value;
    }
  }
  return aiResponseSchema.parse({
    intent: wire.intent,
    message: wire.message.trim().slice(0, 2000) || 'OK',
    extracted,
  });
}
