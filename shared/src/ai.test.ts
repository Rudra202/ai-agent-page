import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AI_INTENTS, aiExtractedSchema, aiResponseSchema, aiWireSchema, fromWire } from './ai.js';
import type { AiWire } from './ai.js';

const wire = (overrides: Partial<AiWire> = {}): AiWire => ({
  intent: 'collect_business_details',
  message: 'Thanks.',
  registrationType: null,
  jurisdictionId: null,
  packageId: null,
  activity: null,
  companyName: null,
  shareholders: null,
  description: null,
  financeAmount: null,
  financePurpose: null,
  informationAnswer: null,
  affirmative: null,
  ...overrides,
});

describe('extracted values', () => {
  it('rejects unknown keys, so a model cannot smuggle in other fields', () => {
    expect(aiExtractedSchema.safeParse({ companyName: 'Acme', status: 'completed' }).success).toBe(false);
    expect(aiExtractedSchema.safeParse({ workflowStep: 'submitted' }).success).toBe(false);
  });

  it('rejects values of the wrong type or length', () => {
    expect(aiExtractedSchema.safeParse({ shareholders: '2' }).success).toBe(false);
    expect(aiExtractedSchema.safeParse({ companyName: 'x'.repeat(81) }).success).toBe(false);
    expect(aiExtractedSchema.safeParse({ registrationType: 'galaxy' }).success).toBe(false);
    expect(aiExtractedSchema.safeParse({ affirmative: 'yes' }).success).toBe(false);
  });

  it('accepts a sensible set', () => {
    expect(aiExtractedSchema.safeParse({ registrationType: 'free_zone', jurisdictionId: 'shams', shareholders: 2, affirmative: true }).success).toBe(true);
  });
});

describe('the intents', () => {
  it('include the ones the planner relies on and reject anything else', () => {
    for (const intent of ['check_status', 'unsupported', 'confirm_submission', 'answer_question']) expect(AI_INTENTS).toContain(intent);
    expect(aiResponseSchema.safeParse({ intent: 'delete_all', message: 'x' }).success).toBe(false);
    expect(aiResponseSchema.safeParse({ intent: 'greet', message: 'x', extracted: { hack: true } }).success).toBe(false);
  });
});

describe('the wire format', () => {
  it('is a strict schema: every property is required and no object is open-ended', () => {
    const json = z.toJSONSchema(aiWireSchema) as { properties: Record<string, unknown>; required: string[]; additionalProperties?: boolean };
    expect(json.additionalProperties).toBe(false);
    expect(json.required.sort()).toEqual(Object.keys(json.properties).sort());
    // Nothing optional or free-form, which strict structured outputs would refuse.
    expect(JSON.stringify(json)).not.toContain('"additionalProperties":true');
  });

  it('never asks the model for options, quick replies or workflow state', () => {
    const keys = Object.keys((z.toJSONSchema(aiWireSchema) as { properties: Record<string, unknown> }).properties);
    for (const forbidden of ['options', 'quickReplies', 'workflow', 'requiresConfirmation', 'status', 'step']) expect(keys).not.toContain(forbidden);
  });

  it('turns nulls into "not stated" and trims what was stated', () => {
    const ai = fromWire(wire({ companyName: '  Acme Consulting  ', shareholders: 2, jurisdictionId: ' shams ' }));
    expect(ai.extracted).toEqual({ companyName: 'Acme Consulting', shareholders: 2, jurisdictionId: 'shams' });
    expect(fromWire(wire()).extracted).toEqual({});
  });

  it('drops empty strings but keeps an empty description, which means the user skipped it', () => {
    const ai = fromWire(wire({ activity: '   ', companyName: '', description: '' }));
    expect(ai.extracted).toEqual({ description: '' });
  });

  it('gives an empty message a neutral value and caps a very long one', () => {
    expect(fromWire(wire({ message: '   ' })).message).toBe('OK');
    expect(fromWire(wire({ message: 'x'.repeat(5000) })).message).toHaveLength(2000);
  });

  it('refuses a value that breaks the contract instead of passing it on', () => {
    expect(() => fromWire(wire({ companyName: 'x'.repeat(81) }))).toThrow();
    expect(() => fromWire(wire({ informationAnswer: 'x'.repeat(121) }))).toThrow();
  });

  it('rejects an unknown intent or a wrongly typed field in the model output', () => {
    expect(aiWireSchema.safeParse({ ...wire(), intent: 'grant_approval' }).success).toBe(false);
    expect(aiWireSchema.safeParse({ ...wire(), shareholders: '2' }).success).toBe(false);
    expect(aiWireSchema.safeParse({ ...wire(), registrationType: 'galaxy' }).success).toBe(false);
    const { affirmative: _omitted, ...missing } = wire();
    expect(aiWireSchema.safeParse(missing).success).toBe(false);
  });
});
