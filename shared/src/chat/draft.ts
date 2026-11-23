import { z } from 'zod';
import { categoryForActivity, getJurisdiction, getPackage } from '../catalog.js';
import { businessDetailsSchema, validateCompanyDraft } from '../company.js';
import type { CompanyDraft } from '../company.js';
import { REGISTRATION_TYPES } from '../workflow.js';
import type { WorkflowStep } from '../workflow.js';

/**
 * Editing the company draft outside the conversation (the review screen).
 * The same rules apply wherever the edit is made: the browser checks the form,
 * and the server checks it again before it changes any stored state.
 */

/** The earliest workflow step that still has missing or invalid data. */
export function stepForDraft(draft: CompanyDraft): WorkflowStep {
  if (!draft.registrationType) return 'registration_type';
  if (!draft.jurisdictionId) return 'jurisdiction';
  if (!draft.activity || !draft.category || !draft.companyName || draft.shareholders === undefined) {
    return 'business_details';
  }
  if (!draft.packageId) return 'package_selection';
  return validateCompanyDraft(draft).length === 0 ? 'review' : 'business_details';
}

/** Merges an edit into the company draft, clearing choices that depended on a changed value. */
export function mergeCompanyDraft(current: CompanyDraft, patch: Partial<CompanyDraft>): CompanyDraft {
  const next: CompanyDraft = { ...current, ...patch };
  if (patch.registrationType !== undefined && patch.registrationType !== current.registrationType) {
    if (patch.jurisdictionId === undefined) next.jurisdictionId = undefined;
    if (patch.packageId === undefined) next.packageId = undefined;
  }
  if (patch.jurisdictionId !== undefined && patch.jurisdictionId !== current.jurisdictionId) {
    if (patch.packageId === undefined) next.packageId = undefined;
  }
  if (patch.activity !== undefined && patch.category === undefined && patch.activity !== current.activity) {
    next.category = categoryForActivity(patch.activity);
  }
  return next;
}

/**
 * What a draft edit may contain. Every field is checked with the same rules as the
 * conversation, and unknown fields are rejected. At least one field is required.
 */
export const draftPatchSchema = z
  .object({
    registrationType: z.enum(REGISTRATION_TYPES),
    jurisdictionId: z.string().min(1).max(64),
    packageId: z.string().min(1).max(64),
    companyName: businessDetailsSchema.shape.companyName,
    activity: businessDetailsSchema.shape.activity,
    category: businessDetailsSchema.shape.category,
    description: businessDetailsSchema.shape.description,
    shareholders: businessDetailsSchema.shape.shareholders,
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to change' });

export type DraftPatch = z.output<typeof draftPatchSchema>;

/**
 * Checks that a merged draft only refers to things that exist and belong together.
 * Returns the problem as plain text, or null when the draft is consistent.
 * An incomplete draft is fine: completeness is checked at submission.
 */
export function draftConsistencyProblem(draft: CompanyDraft): string | null {
  if (draft.jurisdictionId !== undefined) {
    const jurisdiction = getJurisdiction(draft.jurisdictionId);
    if (!jurisdiction) return 'That jurisdiction is not available';
    if (draft.registrationType !== undefined && jurisdiction.registrationType !== draft.registrationType) {
      return 'That jurisdiction is not available for this registration type';
    }
  }
  if (draft.packageId !== undefined) {
    const pkg = getPackage(draft.packageId);
    if (!pkg) return 'That package is not available';
    if (pkg.jurisdictionId !== draft.jurisdictionId) return 'That package does not belong to the chosen jurisdiction';
  }
  return null;
}
