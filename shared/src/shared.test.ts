import { describe, expect, it } from 'vitest';
import { isEditTransition, isForwardTransition } from './workflow.js';
import { activityFilterFor, statusProgress } from './application.js';
import { aiResponseSchema, FALLBACK_AI_RESPONSE } from './ai.js';

describe('workflow transitions', () => {
  it('allows moving to the next step only', () => {
    expect(isForwardTransition('company_registration', 'intent', 'registration_type')).toBe(true);
    expect(isForwardTransition('company_registration', 'intent', 'package_selection')).toBe(false);
    expect(isForwardTransition('company_registration', 'review', 'review')).toBe(true);
  });

  it('allows editing earlier steps before submission only', () => {
    expect(isEditTransition('company_registration', 'review', 'business_details')).toBe(true);
    expect(isEditTransition('company_registration', 'submitted', 'review')).toBe(false);
  });
});

describe('application helpers', () => {
  it('buckets statuses into activity filters', () => {
    expect(activityFilterFor('documents_pending')).toBe('needs_action');
    expect(activityFilterFor('under_review')).toBe('in_progress');
    expect(activityFilterFor('completed')).toBe('completed');
  });

  it('reports progress between 0 and 1', () => {
    expect(statusProgress('request_understood')).toBeGreaterThan(0);
    expect(statusProgress('completed')).toBe(1);
  });
});

describe('ai response schema', () => {
  it('accepts the fallback response', () => {
    expect(aiResponseSchema.safeParse(FALLBACK_AI_RESPONSE).success).toBe(true);
  });

  it('rejects unknown intents and oversized option lists', () => {
    expect(aiResponseSchema.safeParse({ intent: 'hack_db', message: 'x' }).success).toBe(false);
    const tooMany = Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    expect(aiResponseSchema.safeParse({ intent: 'greet', message: 'x', options: tooMany }).success).toBe(false);
  });
});
