import { pendingOf } from '../applications.js';
import {
  BUSINESS_ACTIVITIES,
  FINANCE_PURPOSES,
  JURISDICTIONS,
  PACKAGES,
  REGISTRATION_OPTIONS,
} from '../catalog.js';
import { nextDetailField, reprompt } from './engine.js';
import type { EngineContext } from './engine.js';
import type { WorkflowState } from './types.js';

/** One earlier message, kept short. */
export interface HistoryItem {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Everything a model is allowed to know about a conversation. It is deliberately small:
 * where the workflow is, the business facts the user has typed so far, what question is
 * open, the catalogue ids it may pick from, and a short trimmed history. It never
 * contains an email, a full name, a token, a document or anything from the database.
 */
export interface InterpretContext {
  workflow: { type: WorkflowState['type']; step: WorkflowState['step'] };
  /** Business facts collected so far. Keys match the extracted fields of an AI response. */
  collected: Record<string, string | number>;
  /** The question the workflow is waiting for, and the field its answer belongs to. */
  expecting: { field: string | null; question: string };
  allowed: {
    registrationTypes: Array<{ id: string; title: string }>;
    jurisdictions: Array<{ id: string; name: string; registrationType: string; aliases: string[] }>;
    packages: Array<{ id: string; jurisdictionId: string; name: string }>;
    activities: string[];
    financePurposes: string[];
  };
  pendingRequirements: string[];
  recent: HistoryItem[];
}

// Enough of the recent conversation to follow a question and its follow-ups, and still small.
export const MAX_HISTORY_ITEMS = 10;
export const MAX_HISTORY_CHARS = 400;

/** Which extracted field the workflow expects next. */
export function expectedField(wf: WorkflowState, ctx: EngineContext): string | null {
  if (wf.type === null) {
    const app = ctx.applications.find((a) => a.id === wf.clarificationApplicationId);
    return app && pendingOf(app).some((r) => r.kind === 'information') ? 'informationAnswer' : null;
  }
  if (wf.type === 'company_registration') {
    switch (wf.step) {
      case 'registration_type':
        return 'registrationType';
      case 'jurisdiction':
        return 'jurisdictionId';
      case 'business_details':
        return nextDetailField(wf.company);
      case 'package_selection':
        return 'packageId';
      case 'review':
        return 'confirmation';
      default:
        return null;
    }
  }
  switch (wf.step) {
    case 'business_profile':
    case 'documents':
      return 'affirmative';
    case 'financing_need':
      return wf.finance.amount === undefined ? 'financeAmount' : 'financePurpose';
    case 'review':
      return 'confirmation';
    default:
      return null;
  }
}

function collectedFacts(wf: WorkflowState): Record<string, string | number> {
  const facts: Record<string, string | number> = {};
  const c = wf.company;
  if (c.registrationType) facts.registrationType = c.registrationType;
  if (c.jurisdictionId) facts.jurisdictionId = c.jurisdictionId;
  if (c.activity) facts.activity = c.activity;
  if (c.companyName) facts.companyName = c.companyName;
  if (c.shareholders !== undefined) facts.shareholders = c.shareholders;
  if (c.description) facts.description = c.description;
  if (c.packageId) facts.packageId = c.packageId;
  if (wf.finance.amount !== undefined) facts.financeAmount = wf.finance.amount;
  if (wf.finance.purpose) facts.financePurpose = wf.finance.purpose;
  return facts;
}

const squash = (value: string, max: number) => value.replace(/\s+/g, ' ').trim().slice(0, max);

export function buildInterpretContext(wf: WorkflowState, ctx: EngineContext, history: readonly HistoryItem[] = []): InterpretContext {
  const question = reprompt(wf, ctx).replies.find((r) => r.kind === 'text');
  const app = ctx.applications.find((a) => a.id === wf.clarificationApplicationId);

  return {
    workflow: { type: wf.type, step: wf.step },
    collected: collectedFacts(wf),
    expecting: { field: expectedField(wf, ctx), question: question && question.kind === 'text' ? question.text : '' },
    allowed: {
      registrationTypes: REGISTRATION_OPTIONS.map((o) => ({ id: o.id, title: o.title })),
      jurisdictions: JURISDICTIONS.map((j) => ({ id: j.id, name: j.name, registrationType: j.registrationType, aliases: j.aliases })),
      packages: PACKAGES.map((p) => ({ id: p.id, jurisdictionId: p.jurisdictionId, name: p.name })),
      activities: BUSINESS_ACTIVITIES.map((a) => a.label),
      financePurposes: FINANCE_PURPOSES,
    },
    pendingRequirements: app ? pendingOf(app).map((r) => r.label) : [],
    recent: history
      .filter((item) => item.text.trim().length > 0)
      .slice(-MAX_HISTORY_ITEMS)
      .map((item) => ({ role: item.role, text: squash(item.text, MAX_HISTORY_CHARS) })),
  };
}
