import { z } from 'zod';
import { companyDraftSchema, financeDraftSchema } from '../company.js';
import type { CompanyDraft, FinanceDraft } from '../company.js';
import { WORKFLOW_STEPS, WORKFLOW_TYPES } from '../workflow.js';
import type { WorkflowStep, WorkflowType } from '../workflow.js';

export interface OptionCard {
  id: string;
  title: string;
  description?: string;
  tags?: string[];
  facts?: Array<{ label: string; value: string }>;
  bullets?: Array<{ heading: string; items: string[] }>;
  actionLabel: string;
}

export interface SummaryField {
  label: string;
  value: string;
}

/** What Tajir can say. Rich kinds render as cards inside the conversation. */
export type AssistantContent =
  | { kind: 'text'; text: string }
  | {
      kind: 'options';
      workflow: WorkflowType;
      step: WorkflowStep;
      eyebrow: string;
      cards: OptionCard[];
      note?: string;
    }
  | {
      kind: 'summary';
      workflow: WorkflowType;
      step: WorkflowStep;
      title: string;
      fields: SummaryField[];
      note: string;
      problems: string[];
    }
  | { kind: 'status'; applicationId: string }
  | { kind: 'status_list'; applicationIds: string[] }
  | { kind: 'upload'; applicationId: string };

/** The person the conversation is with, reduced to what the engine needs to word its replies. */
export interface ChatUser {
  name: string;
  firstName: string;
  company: string;
}

/**
 * The workflow state is owned by the engine and the backend. The AI never
 * writes it: it can only propose values that the engine validates.
 */
export interface WorkflowState {
  type: WorkflowType | null;
  step: WorkflowStep;
  company: CompanyDraft;
  finance: FinanceDraft;
  /** Set while Tajir is helping the user resolve an application's missing items. */
  clarificationApplicationId?: string;
}

export const INITIAL_WORKFLOW: WorkflowState = {
  type: null,
  step: 'intent',
  company: {},
  finance: {},
};

export const DEFAULT_QUICK_REPLIES = [
  'Start a company',
  'Working Capital Finance',
  'Explore business services',
  'Check registration status',
];

const reference = /^(REG|FIN)-\d{4}-\d{6}$/;

/** Shape of the workflow state when it is read back from storage. Anything else is treated as corrupt. */
export const workflowStateSchema = z
  .object({
    type: z.enum(WORKFLOW_TYPES).nullable(),
    step: z.string(),
    company: companyDraftSchema,
    finance: financeDraftSchema,
    clarificationApplicationId: z.string().regex(reference).optional(),
  })
  .refine((state) => (state.type === null ? state.step === 'intent' : (WORKFLOW_STEPS[state.type] as readonly string[]).includes(state.step)), {
    message: 'The step does not belong to the workflow',
  });

/** Reads a stored workflow state, returning a fresh one if it is missing, corrupt or inconsistent. */
export function parseWorkflowState(value: unknown): WorkflowState {
  const parsed = workflowStateSchema.safeParse(value);
  if (!parsed.success) return { ...INITIAL_WORKFLOW, company: {}, finance: {} };
  return parsed.data as WorkflowState;
}
