import { FIELD_INTENTS } from '../ai.js';
import type { AiExtracted, AiResponse } from '../ai.js';
import { getJurisdiction, getPackage, JURISDICTIONS } from '../catalog.js';
import type { Jurisdiction } from '../catalog.js';
import {
  applyDetails,
  applyFinanceNeed,
  aboutReply,
  exploreReply,
  fallbackReply,
  greetReply,
  isConfirmation,
  parseRegistrationType,
  reprompt,
  respond,
  unsupportedReply,
} from './engine.js';
import type { DetailsPatch, EngineContext, EngineInput, EngineResult, FinanceNeedPatch } from './engine.js';
import {
  checkAssistantText,
  checkGeneralAnswer,
  GENERAL_INFO_NOTE,
  isRestrictedTopic,
  isServiceTopic,
  looksLikeQuestion,
  NEUTRAL_REPLY,
  RESTRICTED_REPLY,
} from './guard.js';
import { DEFAULT_QUICK_REPLIES } from './types.js';
import type { AssistantContent, WorkflowState } from './types.js';

/**
 * Turns an AI proposal into a workflow turn.
 *
 * The model's output is treated as untrusted suggestions. Each proposed value is
 * checked against the catalogue and fed to the engine one step at a time, so it
 * passes the same validation as typed input and can only move the workflow
 * forward in the allowed order. Factual content always comes from the engine.
 * Model-written text is shown only for general conversation, after the claims guard.
 */

export interface AiTurnReport {
  intent: AiResponse['intent'];
  /** Proposed values the engine accepted. */
  applied: string[];
  /** Proposed values that were ignored, with the reason. */
  ignored: string[];
  /** Why the model's text was replaced by a fixed message, if it was. */
  guard?: string[];
  /** True if the user asked about a restricted topic and no model text was used. */
  restricted?: boolean;
}

export interface AiTurn {
  result: EngineResult;
  report: AiTurnReport;
}

const text = (value: string): AssistantContent => ({ kind: 'text', text: value });

/** One validated step the planner wants the engine to take. */
type Proposal = EngineInput | { type: 'details'; patch: DetailsPatch } | { type: 'finance_need'; patch: FinanceNeedPatch };

/** A flow is only restarted from the middle by an unmistakable, short command. */
const EXPLICIT_START_COMPANY = /^(?:please\s+)?(?:i\s+(?:want|would like|need|'d like)\s+to\s+)?(?:start|register|set\s?up|open|form|create|incorporate)\s+(?:a|my|the|another)?\s*(?:new\s+)?(?:company|business)\s*[.!]?$/i;
const EXPLICIT_START_FINANCE = /^(?:please\s+)?(?:i\s+(?:want|need|would like)\s+)?(?:a\s+|some\s+)?working\s+capital(?:\s+(?:finance|request))?\s*[.!]?$/i;
/** Asking Tajir to introduce itself, even when the message starts with a greeting. */
const ASKS_WHO = /introduce yourself|who are you|what are you|about yourself|tell me about (?:you|tajir)|what is tajir|what'?s tajir/i;
const SKIP = /\b(?:skip|no description|none|nothing|n\/a)\b/i;

export function runAiTurn(wf: WorkflowState, ai: AiResponse, userText: string, ctx: EngineContext): AiTurn {
  const report: AiTurnReport = { intent: ai.intent, applied: [], ignored: [] };
  const input = userText.trim();
  let state = wf;
  let last: EngineResult | null = null;

  const run = (proposal: Proposal): EngineResult => {
    const result =
      proposal.type === 'details'
        ? applyDetails(state, proposal.patch)
        : proposal.type === 'finance_need'
          ? applyFinanceNeed(state, proposal.patch, ctx)
          : respond(state, proposal, ctx);
    state = result.workflow;
    last = result;
    return result;
  };
  const finish = (result: EngineResult): AiTurn => ({ result, report });

  // ---- 1. intents that leave the current question alone or branch away from it
  switch (ai.intent) {
    case 'check_status':
      return finish(respond(state, { type: 'text', text: 'Check registration status' }, ctx));
    case 'upload_document':
      return finish(respond(state, { type: 'text', text: 'Where can I upload it?' }, ctx));
    case 'unsupported':
      return finish(unsupportedReply(state));
    case 'greet':
    case 'explore_services':
    case 'answer_question':
    case 'unknown':
      // A chatty or unclear turn never changes the draft, even if the model attached values to it.
      if (ai.extracted && Object.keys(ai.extracted).length > 0) {
        report.ignored.push('extracted values ignored because the intent is not about filling in the workflow');
      }
      return finish(conversational(state, ai, input, ctx, report));
    case 'start_company':
      if (state.type === null || EXPLICIT_START_COMPANY.test(input)) run({ type: 'text', text: 'Start a company' });
      else report.ignored.push('start_company: not restarting a flow that is in progress');
      break;
    case 'working_capital':
      if (state.type === null || EXPLICIT_START_FINANCE.test(input)) run({ type: 'text', text: 'Working Capital Finance' });
      else report.ignored.push('working_capital: not restarting a flow that is in progress');
      break;
    default:
      break;
  }

  // ---- 2. apply what the user stated, one validated step at a time
  if (FIELD_INTENTS.includes(ai.intent)) {
    const extracted = ai.extracted ?? {};
    const used = new Set<string>();
    for (let step = 0; step < 12; step += 1) {
      const proposal = nextProposal(state, extracted, used, ai, input, report);
      if (!proposal) break;
      const result = run(proposal);
      if (result.effects.length > 0) break;
    }
  } else if (ai.extracted && Object.keys(ai.extracted).length > 0) {
    report.ignored.push('extracted values ignored because the intent is not about filling in the workflow');
  }

  // ---- 3. nothing usable: ask the open question again
  if (!last) {
    if (state.type === null) return finish(fallbackReply(state));
    const again = reprompt(state, ctx);
    return finish({
      workflow: state,
      replies: [text("I couldn't use that as an answer."), ...again.replies],
      quickReplies: again.quickReplies,
      effects: [],
    });
  }
  return finish(last);
}


// ------------------------------------------------------------------ grounding
//
// A model can be wrong, or be talked into something. So a choice it reports is only
// used if the user's own message actually names it. The model reads the message; it
// does not get to pick an option, a package or a company name on the user's behalf.

const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const mentions = (userText: string, phrase: string) => ` ${normalise(userText)} `.includes(` ${normalise(phrase)} `);

function jurisdictionMentioned(userText: string, j: Jurisdiction): boolean {
  return [j.id, j.name, j.shortName, ...j.aliases].some((phrase) => mentions(userText, phrase));
}

function registrationTypeStated(userText: string, type: string): boolean {
  return parseRegistrationType(userText) === type || JURISDICTIONS.some((j) => j.registrationType === type && jurisdictionMentioned(userText, j));
}

function nameStated(userText: string, name: string): boolean {
  const wanted = normalise(name);
  return wanted.length > 0 && normalise(userText).includes(wanted);
}

// ------------------------------------------------------------------ proposals

function nextProposal(
  state: WorkflowState,
  e: AiExtracted,
  used: Set<string>,
  ai: AiResponse,
  userText: string,
  report: AiTurnReport,
): Proposal | null {
  const take = (...keys: Array<keyof AiExtracted>): boolean => {
    const fresh = keys.filter((k) => e[k] !== undefined && !used.has(k));
    fresh.forEach((k) => used.add(k));
    return fresh.length > 0;
  };
  const applied = (...keys: string[]) => report.applied.push(...keys);

  if (state.type === null) {
    if (state.clarificationApplicationId && e.informationAnswer !== undefined && take('informationAnswer')) {
      applied('informationAnswer');
      return { type: 'text', text: e.informationAnswer };
    }
    return null;
  }

  if (state.type === 'company_registration') {
    switch (state.step) {
      case 'registration_type':
        if (e.registrationType && take('registrationType')) {
          if (!registrationTypeStated(userText, e.registrationType)) {
            report.ignored.push('registrationType: not stated in the message');
            return null;
          }
          applied('registrationType');
          return { type: 'select', step: 'registration_type', cardId: e.registrationType };
        }
        return null;

      case 'jurisdiction': {
        if (e.jurisdictionId !== undefined && take('jurisdictionId')) {
          const j = getJurisdiction(e.jurisdictionId);
          if (j && j.registrationType === state.company.registrationType) {
            if (!jurisdictionMentioned(userText, j)) {
              report.ignored.push('jurisdictionId: not named in the message');
              return null;
            }
            applied('jurisdictionId');
            return { type: 'select', step: 'jurisdiction', cardId: j.id };
          }
          report.ignored.push('jurisdictionId: not one of the available options for this registration type');
          return null;
        }
        if (ai.intent === 'suggest_jurisdiction' && !used.has('suggest')) {
          used.add('suggest');
          return { type: 'text', text: 'Show me popular options' };
        }
        return null;
      }

      case 'business_details': {
        const patch: DetailsPatch = {};
        if (e.activity !== undefined && !used.has('activity')) patch.activity = e.activity;
        if (e.companyName !== undefined && !used.has('companyName')) {
          if (nameStated(userText, e.companyName)) patch.companyName = e.companyName;
          else {
            used.add('companyName');
            report.ignored.push('companyName: not written in the message');
          }
        }
        if (e.shareholders !== undefined && !used.has('shareholders')) patch.shareholders = e.shareholders;
        // An empty description only counts when the user really chose to skip it.
        if (e.description !== undefined && !used.has('description') && (e.description !== '' || SKIP.test(userText))) {
          patch.description = e.description;
        }
        const keys = Object.keys(patch);
        if (keys.length === 0) return null;
        keys.forEach((k) => used.add(k));
        applied(...keys);
        return { type: 'details', patch };
      }

      case 'package_selection':
        if (e.packageId !== undefined && take('packageId')) {
          const p = getPackage(e.packageId);
          if (p && p.jurisdictionId === state.company.jurisdictionId) {
            if (!mentions(userText, p.name)) {
              report.ignored.push('packageId: not named in the message');
              return null;
            }
            applied('packageId');
            return { type: 'select', step: 'package_selection', cardId: p.id };
          }
          report.ignored.push('packageId: not one of the packages for the chosen jurisdiction');
        }
        return null;

      case 'review':
        return confirmation(used, ai, userText, report);

      default:
        return null;
    }
  }

  switch (state.step) {
    case 'business_profile':
      if (e.affirmative === true && take('affirmative')) {
        applied('affirmative');
        return { type: 'text', text: 'yes' };
      }
      return null;

    case 'financing_need': {
      const patch: FinanceNeedPatch = {};
      if (e.financeAmount !== undefined && !used.has('financeAmount')) patch.amount = e.financeAmount;
      if (e.financePurpose !== undefined && !used.has('financePurpose')) patch.purpose = e.financePurpose;
      const keys = Object.keys(patch);
      if (keys.length === 0) return null;
      if (patch.amount !== undefined) used.add('financeAmount');
      if (patch.purpose !== undefined) used.add('financePurpose');
      applied(...(patch.amount !== undefined ? ['financeAmount'] : []), ...(patch.purpose !== undefined ? ['financePurpose'] : []));
      return { type: 'finance_need', patch };
    }

    case 'documents':
      if (e.affirmative === true && take('affirmative')) {
        applied('affirmative');
        return { type: 'text', text: 'continue' };
      }
      return null;

    case 'review':
      return confirmation(used, ai, userText, report);

    default:
      return null;
  }
}

/**
 * Submission is a consequential step, so a model saying "the user confirmed" is not
 * enough. It needs the model to read it as a confirmation AND the user's own words
 * to be an unmistakable confirmation that is not a question. The explicit
 * "Confirm & Submit" button never goes through here.
 */
function confirmation(used: Set<string>, ai: AiResponse, userText: string, report: AiTurnReport): Proposal | null {
  if (used.has('confirm')) return null;
  used.add('confirm');
  if (ai.intent !== 'confirm_submission' && ai.intent !== 'review') return null;
  if (!isConfirmation(userText) || looksLikeQuestion(userText)) {
    report.ignored.push('confirmation: the answer was not an unmistakable confirmation by the user');
    return null;
  }
  report.applied.push('confirm');
  return { type: 'confirm', step: 'review' };
}

// -------------------------------------------------------------- conversation

/** Side questions and greetings. The open question is asked again afterwards. */
function conversational(state: WorkflowState, ai: AiResponse, userText: string, ctx: EngineContext, report: AiTurnReport): EngineResult {
  let reply: AssistantContent[];

  if (ai.intent === 'greet') {
    // "Hi, introduce yourself" is a greeting and a question: the question gets answered.
    reply = (ASKS_WHO.test(userText) ? aboutReply(state) : greetReply(state, ctx)).replies;
  } else if (ai.intent === 'explore_services') {
    reply = exploreReply(state).replies;
  } else if (isServiceTopic(userText) && isRestrictedTopic(userText)) {
    // The model is not trusted to answer questions about fees, eligibility, law or approvals for UAE company setup.
    report.restricted = true;
    reply = [text(RESTRICTED_REPLY)];
  } else if (ai.intent === 'unknown') {
    reply = fallbackReply(state).replies;
  } else if (isServiceTopic(userText)) {
    // Close to what Tajir does: short, with no figures, rules or promises, and always marked as general information.
    const checked = checkAssistantText(ai.message);
    if (checked.ok) {
      reply = [text(`${checked.text} ${GENERAL_INFO_NOTE}`)];
    } else {
      report.guard = checked.reasons;
      reply = [text(NEUTRAL_REPLY)];
    }
  } else {
    // An ordinary question: the model answers it properly, with the lighter checks.
    const checked = checkGeneralAnswer(ai.message);
    if (checked.ok) {
      reply = [text(checked.text)];
    } else {
      report.guard = checked.reasons;
      reply = [text(NEUTRAL_REPLY)];
    }
  }

  const again = state.type === null ? { replies: [] as AssistantContent[], quickReplies: DEFAULT_QUICK_REPLIES } : reprompt(state, ctx);
  const quickReplies = again.quickReplies.length > 0 ? again.quickReplies : state.type === null ? DEFAULT_QUICK_REPLIES : [];
  return { workflow: state, replies: [...reply, ...again.replies], quickReplies, effects: [] };
}
