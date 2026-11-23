import { describe, expect, it } from 'vitest';
import { businessDetailsSchema, validateCompanyDraft, validateFinanceDraft } from './company.js';

const complete = {
  registrationType: 'free_zone' as const,
  jurisdictionId: 'shams',
  packageId: 'shams-starter',
  companyName: 'Vinith Media',
  activity: 'Media & Marketing',
  category: 'Media & Advertising',
  description: '',
  shareholders: 1,
};

describe('validateCompanyDraft', () => {
  it('reports every required field for an empty draft, but not the optional description', () => {
    const fields = validateCompanyDraft({}).map((p) => p.field);
    expect(fields).toEqual(
      expect.arrayContaining(['registrationType', 'jurisdictionId', 'packageId', 'companyName', 'activity', 'category', 'shareholders']),
    );
    expect(fields).not.toContain('description');
  });

  it('accepts a complete draft, with or without a description', () => {
    expect(validateCompanyDraft(complete)).toEqual([]);
    const { description: _description, ...withoutDescription } = complete;
    expect(validateCompanyDraft(withoutDescription)).toEqual([]);
  });

  it('flags invalid values with a specific message', () => {
    const problems = validateCompanyDraft({ ...complete, shareholders: 0, companyName: 'A' });
    expect(problems.find((p) => p.field === 'shareholders')?.message).toContain('At least one');
    expect(problems.find((p) => p.field === 'companyName')?.message).toContain('at least 2');
  });

  it('says a field is required when it is missing', () => {
    const problems = validateCompanyDraft({ ...complete, companyName: undefined });
    expect(problems.find((p) => p.field === 'companyName')?.message).toBe('Company name is required');
  });
});

describe('business details schema', () => {
  it('rejects fractional and oversized shareholder counts', () => {
    expect(businessDetailsSchema.shape.shareholders.safeParse(1.5).success).toBe(false);
    expect(businessDetailsSchema.shape.shareholders.safeParse(21).success).toBe(false);
    expect(businessDetailsSchema.shape.shareholders.safeParse(3).success).toBe(true);
  });
});

describe('validateFinanceDraft', () => {
  it('requires an amount and a purpose', () => {
    expect(validateFinanceDraft({}).map((p) => p.field).sort()).toEqual(['amount', 'purpose']);
    expect(validateFinanceDraft({ amount: 350000, purpose: 'Inventory' })).toEqual([]);
  });

  it('rejects zero and negative amounts', () => {
    expect(validateFinanceDraft({ amount: 0, purpose: 'Inventory' })[0]?.field).toBe('amount');
    expect(validateFinanceDraft({ amount: -5, purpose: 'Inventory' })[0]?.field).toBe('amount');
  });
});
