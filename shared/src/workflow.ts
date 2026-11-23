/**
 * Workflow definitions shared by the frontend, the backend workflow engine and
 * the AI orchestration layer. The backend is the only component allowed to
 * change workflow state; the AI may only *propose* a transition.
 */

export const WORKFLOW_TYPES = ['company_registration', 'working_capital_finance'] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

export const COMPANY_REGISTRATION_STEPS = [
  'intent',
  'registration_type',
  'jurisdiction',
  'business_details',
  'package_selection',
  'review',
  'submitted',
] as const;
export type CompanyRegistrationStep = (typeof COMPANY_REGISTRATION_STEPS)[number];

export const WORKING_CAPITAL_STEPS = [
  'intent',
  'business_profile',
  'financing_need',
  'documents',
  'review',
  'submitted',
] as const;
export type WorkingCapitalStep = (typeof WORKING_CAPITAL_STEPS)[number];

export type WorkflowStep = CompanyRegistrationStep | WorkingCapitalStep;

export const WORKFLOW_STEPS: Record<WorkflowType, readonly WorkflowStep[]> = {
  company_registration: COMPANY_REGISTRATION_STEPS,
  working_capital_finance: WORKING_CAPITAL_STEPS,
};

export const REGISTRATION_TYPES = ['mainland', 'free_zone', 'offshore'] as const;
export type RegistrationType = (typeof REGISTRATION_TYPES)[number];

export const REGISTRATION_TYPE_LABELS: Record<RegistrationType, string> = {
  mainland: 'UAE Mainland',
  free_zone: 'Free Zone',
  offshore: 'Offshore',
};

/** True when `to` is the step immediately after `from`, or `from` itself (no-op). */
export function isForwardTransition(type: WorkflowType, from: WorkflowStep, to: WorkflowStep): boolean {
  const steps = WORKFLOW_STEPS[type];
  const fromIndex = steps.indexOf(from);
  const toIndex = steps.indexOf(to);
  if (fromIndex === -1 || toIndex === -1) return false;
  return toIndex === fromIndex || toIndex === fromIndex + 1;
}

/** True when moving back to an earlier, editable step (never once submitted). */
export function isEditTransition(type: WorkflowType, from: WorkflowStep, to: WorkflowStep): boolean {
  const steps = WORKFLOW_STEPS[type];
  const fromIndex = steps.indexOf(from);
  const toIndex = steps.indexOf(to);
  if (fromIndex === -1 || toIndex === -1) return false;
  if (from === 'submitted') return false;
  return toIndex < fromIndex;
}
