import { describe, expect, it } from 'vitest';
import { draftConsistencyProblem, draftPatchSchema, mergeCompanyDraft, stepForDraft } from './draft.js';

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

describe('mergeCompanyDraft', () => {
  it('clears the jurisdiction and package when the registration type changes', () => {
    const next = mergeCompanyDraft(complete, { registrationType: 'offshore' });
    expect(next.jurisdictionId).toBeUndefined();
    expect(next.packageId).toBeUndefined();
    expect(next.companyName).toBe('Vinith Media');
  });

  it('keeps the new jurisdiction and package when both are supplied', () => {
    const next = mergeCompanyDraft(complete, { registrationType: 'offshore', jurisdictionId: 'rak-offshore', packageId: 'rak-offshore-growth' });
    expect(next).toMatchObject({ jurisdictionId: 'rak-offshore', packageId: 'rak-offshore-growth' });
  });

  it('clears only the package when the jurisdiction changes', () => {
    const next = mergeCompanyDraft(complete, { jurisdictionId: 'ifza' });
    expect(next.jurisdictionId).toBe('ifza');
    expect(next.packageId).toBeUndefined();
    expect(next.registrationType).toBe('free_zone');
  });

  it('derives the category from a changed activity', () => {
    expect(mergeCompanyDraft(complete, { activity: 'Consulting' }).category).toBe('Professional Services');
    expect(mergeCompanyDraft(complete, { activity: 'Consulting', category: 'Technology' }).category).toBe('Technology');
  });
});

describe('stepForDraft', () => {
  it('returns the earliest step with missing data', () => {
    expect(stepForDraft({})).toBe('registration_type');
    expect(stepForDraft({ registrationType: 'free_zone' })).toBe('jurisdiction');
    expect(stepForDraft({ registrationType: 'free_zone', jurisdictionId: 'shams' })).toBe('business_details');
    expect(stepForDraft({ ...complete, packageId: undefined })).toBe('package_selection');
  });

  it('returns review only when the draft is valid', () => {
    expect(stepForDraft(complete)).toBe('review');
    expect(stepForDraft({ ...complete, companyName: 'A' })).toBe('business_details');
  });
});

describe('draftPatchSchema', () => {
  it('accepts valid partial edits', () => {
    expect(draftPatchSchema.parse({ companyName: 'Desert Rose' })).toEqual({ companyName: 'Desert Rose' });
    expect(draftPatchSchema.parse({ shareholders: 3, description: '' })).toEqual({ shareholders: 3, description: '' });
  });

  it.each([
    ['an empty edit', {}],
    ['an unknown field', { companyName: 'Desert Rose', status: 'approved' }],
    ['a step', { step: 'submitted' }],
    ['a short name', { companyName: 'A' }],
    ['zero shareholders', { shareholders: 0 }],
    ['a fractional shareholder count', { shareholders: 1.5 }],
    ['too many shareholders', { shareholders: 21 }],
    ['an unknown registration type', { registrationType: 'cayman' }],
    ['a non-string id', { jurisdictionId: { $ne: '' } }],
    ['an overlong description', { description: 'x'.repeat(501) }],
  ])('rejects %s', (_label, patch) => {
    expect(draftPatchSchema.safeParse(patch).success).toBe(false);
  });
});

describe('draftConsistencyProblem', () => {
  it('accepts an incomplete but consistent draft', () => {
    expect(draftConsistencyProblem({})).toBeNull();
    expect(draftConsistencyProblem({ registrationType: 'free_zone', jurisdictionId: 'shams' })).toBeNull();
    expect(draftConsistencyProblem(complete)).toBeNull();
  });

  it('rejects ids that do not exist or do not belong together', () => {
    expect(draftConsistencyProblem({ jurisdictionId: 'atlantis' })).toMatch(/not available/);
    expect(draftConsistencyProblem({ registrationType: 'mainland', jurisdictionId: 'shams' })).toMatch(/registration type/);
    expect(draftConsistencyProblem({ ...complete, packageId: 'nope' })).toMatch(/not available/);
    expect(draftConsistencyProblem({ ...complete, packageId: 'dmcc-starter' })).toMatch(/does not belong/);
    expect(draftConsistencyProblem({ packageId: 'shams-starter' })).toMatch(/does not belong/);
  });
});
