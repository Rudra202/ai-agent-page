import { z } from 'zod';
import { REGISTRATION_TYPES } from './workflow.js';

/**
 * Validation rules for information collected during the workflows. These are
 * used by the forms on the client and will be reused by the backend, so the
 * same rules apply on both sides.
 */

export const businessDetailsSchema = z.object({
  companyName: z
    .string()
    .trim()
    .min(2, 'Enter a company name (at least 2 characters)')
    .max(80, 'Keep the company name under 80 characters'),
  activity: z
    .string()
    .trim()
    .min(2, 'Choose or describe a business activity')
    .max(80, 'Keep the activity under 80 characters'),
  category: z
    .string()
    .trim()
    .min(2, 'Choose a business category')
    .max(60, 'Keep the category under 60 characters'),
  description: z.string().trim().max(500, 'Keep the description under 500 characters'),
  shareholders: z
    .number('Enter the number of shareholders')
    .int('Enter a whole number')
    .min(1, 'At least one shareholder is required')
    .max(20, 'Up to 20 shareholders are supported'),
});
export type BusinessDetails = z.infer<typeof businessDetailsSchema>;

export const companyDraftSchema = z.object({
  registrationType: z.enum(REGISTRATION_TYPES).optional(),
  jurisdictionId: z.string().optional(),
  packageId: z.string().optional(),
  companyName: z.string().optional(),
  activity: z.string().optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  shareholders: z.number().optional(),
});
export type CompanyDraft = z.infer<typeof companyDraftSchema>;

export const completeCompanySchema = businessDetailsSchema.extend({
  registrationType: z.enum(REGISTRATION_TYPES),
  jurisdictionId: z.string().min(1, 'Choose a jurisdiction'),
  packageId: z.string().min(1, 'Choose a package'),
});
export type CompleteCompany = z.infer<typeof completeCompanySchema>;

export const COMPANY_FIELD_LABELS: Record<keyof CompanyDraft, string> = {
  registrationType: 'Registration type',
  jurisdictionId: 'Jurisdiction',
  packageId: 'Package',
  companyName: 'Company name',
  activity: 'Business activity',
  category: 'Business category',
  description: 'Business description',
  shareholders: 'Number of shareholders',
};

export const financeDraftSchema = z.object({
  amount: z.number().optional(),
  purpose: z.string().optional(),
});
export type FinanceDraft = z.infer<typeof financeDraftSchema>;

export const completeFinanceSchema = z.object({
  amount: z
    .number('Enter an amount')
    .int('Enter a whole amount')
    .positive('Enter an amount above zero')
    .max(100_000_000, 'That amount is too large for this prototype'),
  purpose: z.string().trim().min(2, 'Tell us what the funds are for').max(120, 'Keep the purpose under 120 characters'),
});
export type CompleteFinance = z.infer<typeof completeFinanceSchema>;

export const FINANCE_FIELD_LABELS: Record<keyof FinanceDraft, string> = {
  amount: 'Financing amount',
  purpose: 'Purpose of funds',
};

export interface DraftProblem<K extends string = string> {
  field: K;
  message: string;
}

function collectProblems<K extends string>(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
  draft: Partial<Record<K, unknown>>,
  labels: Record<K, string>,
): DraftProblem<K>[] {
  const seen = new Set<string>();
  const problems: DraftProblem<K>[] = [];
  for (const issue of issues) {
    const field = String(issue.path[0]) as K;
    if (seen.has(field)) continue;
    seen.add(field);
    const missing = draft[field] === undefined || draft[field] === '';
    problems.push({ field, message: missing ? `${labels[field] ?? field} is required` : issue.message });
  }
  return problems;
}

/** Returns every problem that blocks submission. An empty array means the draft is complete. */
export function validateCompanyDraft(draft: CompanyDraft): DraftProblem<keyof CompanyDraft>[] {
  const result = completeCompanySchema.safeParse({ ...draft, description: draft.description ?? '' });
  if (result.success) return [];
  return collectProblems(result.error.issues, draft, COMPANY_FIELD_LABELS);
}

export function validateFinanceDraft(draft: FinanceDraft): DraftProblem<keyof FinanceDraft>[] {
  const result = completeFinanceSchema.safeParse(draft);
  if (result.success) return [];
  return collectProblems(result.error.issues, draft, FINANCE_FIELD_LABELS);
}
