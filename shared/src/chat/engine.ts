import { FALLBACK_AI_RESPONSE } from '../ai.js';
import { buildCompanyApplication, buildFinanceApplication, pendingOf, provideRequirement, updatedAtOf } from '../applications.js';
import type { Application } from '../applications.js';
import {
  BUSINESS_ACTIVITIES,
  categoryForActivity,
  documentLabel,
  FINANCE_AMOUNT_CHIPS,
  FINANCE_DISCLAIMER,
  FINANCE_PURPOSES,
  FINANCE_REQUIRED_DOCUMENTS,
  getJurisdiction,
  getPackage,
  getRegistrationOption,
  jurisdictionsFor,
  packagesForJurisdiction,
  REGISTRATION_OPTIONS,
  requiredDocumentsFor,
  requiredDocumentStatus,
  SAMPLE_DATA_NOTE,
} from '../catalog.js';
import {
  businessDetailsSchema,
  completeCompanySchema,
  completeFinanceSchema,
  validateCompanyDraft,
  validateFinanceDraft,
} from '../company.js';
import type { CompanyDraft, CompleteCompany, CompleteFinance } from '../company.js';
import { formatAed } from '../format.js';
import { isForwardTransition, REGISTRATION_TYPE_LABELS } from '../workflow.js';
import type { RegistrationType, WorkflowStep } from '../workflow.js';
import { DEFAULT_QUICK_REPLIES, INITIAL_WORKFLOW } from './types.js';
import type { AssistantContent, ChatUser, OptionCard, SummaryField, WorkflowState } from './types.js';

/**
 * The deterministic workflow engine. It owns the step order, validates every
 * value against schemas and the catalogue, and writes all factual content
 * (options, packages, prices, summaries) from configured data. Neither the
 * rules in this file nor an AI model can change a record: anything that must be
 * persisted comes back as an `effect`, which the caller carries out through its
 * own validated path (the browser prototype's store, or the backend services).
 */

export interface EngineContext {
  applications: Application[];
  /** Documents on record. Only the type matters here. */
  documents: ReadonlyArray<{ typeId: string }>;
  user: ChatUser;
  now: Date;
  newId: () => string;
  random?: () => number;
}

export type EngineInput =
  | { type: 'text'; text: string }
  | { type: 'select'; step: WorkflowStep; cardId: string }
  | { type: 'confirm'; step: WorkflowStep };

/** What the engine wants to say and which state it moves to once an effect has succeeded. */
export interface Completion {
  workflow: WorkflowState;
  replies: AssistantContent[];
  quickReplies: string[];
}

/**
 * A change the engine asks the caller to make. The caller performs it through its
 * own validated path and passes the resulting application to `done`, so the
 * reply always reflects what really happened, including the real reference.
 */
export type Effect =
  | { type: 'submit_company'; company: CompleteCompany; done: (application: Application) => Completion }
  | { type: 'submit_finance'; finance: CompleteFinance; done: (application: Application) => Completion }
  | {
      type: 'provide_information';
      applicationId: string;
      requirementId: string;
      value: string;
      done: (application: Application) => Completion;
    };

export interface EngineResult {
  workflow: WorkflowState;
  replies: AssistantContent[];
  quickReplies: string[];
  effects: Effect[];
}

// ------------------------------------------------------------------ helpers

const text = (value: string): AssistantContent => ({ kind: 'text', text: value });

function result(
  workflow: WorkflowState,
  replies: AssistantContent[],
  quickReplies: string[] = [],
  effects: Effect[] = [],
): EngineResult {
  return { workflow, replies, quickReplies, effects };
}

function advance(wf: WorkflowState, to: WorkflowStep): WorkflowState {
  if (!wf.type) throw new Error('No active workflow');
  if (!isForwardTransition(wf.type, wf.step, to)) {
    throw new Error(`Transition ${wf.step} -> ${to} is not allowed for ${wf.type}`);
  }
  return { ...wf, step: to };
}

export function welcomeContent(): { replies: AssistantContent[]; quickReplies: string[] } {
  return { replies: [text('What can Tajir help you with today?')], quickReplies: DEFAULT_QUICK_REPLIES };
}

const lower = (value: string) => value.trim().toLowerCase();

// ------------------------------------------------------------ intent parsing

type Intent =
  | 'start_company'
  | 'working_capital'
  | 'status'
  | 'upload_help'
  | 'explore'
  | 'about'
  | 'greet'
  | 'unsupported'
  | 'unknown';

export function classify(input: string): Intent {
  const t = lower(input);
  if (/status|where is my (application|request|registration)/.test(t)) return 'status';
  if (/upload|attach|where can i (send|add|put)|how do i (send|share)/.test(t)) return 'upload_help';
  if (/(start|register|set ?up|open|form|create|incorporate)\b.*\b(company|business)|new company/.test(t)) {
    return 'start_company';
  }
  if (/working capital|financ|loan|funding|credit/.test(t)) return 'working_capital';
  if (/\bvat\b|ejari|tenancy|renew|bank account|visa|licen[cs]e/.test(t)) return 'unsupported';
  if (/introduce yourself|who are you|what are you|about yourself|tell me about (you|tajir)|what is tajir|what'?s tajir|your name/.test(t)) return 'about';
  if (/explore|services|what can you|options/.test(t)) return 'explore';
  if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/.test(t)) return 'greet';
  return 'unknown';
}

/** Used while a free-text answer is expected, so a company called "Finance Hub" is not read as a command. */
function classifyStrict(input: string): Intent {
  const t = lower(input);
  if (t === 'start a company' || t === 'start company') return 'start_company';
  if (t === 'working capital finance') return 'working_capital';
  if (t === 'check registration status') return 'status';
  return 'unknown';
}

export const AFFIRMATIVE = /^(yes|yep|yeah|ok|okay|sure|continue|go ahead|proceed|correct)\b/i;

export function isConfirmation(input: string): boolean {
  return /\b(confirm|submit|approve)\b/i.test(input) && !/\b(don'?t|do not|not|cancel)\b/i.test(input);
}

export function parseRegistrationType(input: string): RegistrationType | null {
  const t = lower(input);
  if (/free\s*-?\s*zone/.test(t)) return 'free_zone';
  if (/main\s*-?\s*land/.test(t)) return 'mainland';
  if (/off\s*-?\s*shore/.test(t)) return 'offshore';
  return null;
}

export function parseCount(input: string): number | null {
  const t = lower(input);
  if (/^\d+$/.test(t)) return Number(t);
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const index = words.indexOf(t);
  return index >= 0 ? index : null;
}

export function parseAmount(input: string): number | null {
  const t = lower(input).replace(/aed|,|\s/g, '');
  const match = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(t);
  if (!match) return null;
  const multiplier = match[2] === 'k' ? 1_000 : match[2] === 'm' ? 1_000_000 : 1;
  return Math.round(Number(match[1]) * multiplier);
}

// ----------------------------------------------------------------- card data

function registrationTypeCards(): OptionCard[] {
  return REGISTRATION_OPTIONS.map((o) => ({
    id: o.id,
    title: o.title,
    description: o.description,
    tags: o.tags,
    facts: [
      { label: 'Setup time', value: o.setupTime },
      ...(o.estCost !== undefined ? [{ label: 'Est. cost', value: `From ${formatAed(o.estCost)}` }] : []),
    ],
    actionLabel: 'Select',
  }));
}

function jurisdictionCards(type: RegistrationType): OptionCard[] {
  return jurisdictionsFor(type).map((j) => ({
    id: j.id,
    title: j.name,
    description: j.description,
    tags: j.tags,
    facts: [
      ...(j.setupCostFrom !== undefined
        ? [{ label: 'Setup cost (approx)', value: `${formatAed(j.setupCostFrom)}+` }]
        : [{ label: 'Setup cost', value: 'Pricing on request' }]),
      { label: 'Location', value: j.location },
    ],
    actionLabel: 'Select',
  }));
}

function packageCards(jurisdictionId: string): OptionCard[] {
  return packagesForJurisdiction(jurisdictionId).map((p) => ({
    id: p.id,
    title: `${p.name} package`,
    facts: [{ label: 'Price', value: p.price !== undefined ? formatAed(p.price) : 'Pricing on request' }],
    bullets: [
      { heading: 'Included', items: p.includes },
      { heading: 'Requirements', items: p.requirements },
    ],
    actionLabel: 'Select package',
  }));
}

// ------------------------------------------------------------------- summary

export function companySummaryFields(draft: CompanyDraft, user: ChatUser, documents: ReadonlyArray<{ typeId: string }>): SummaryField[] {
  const jurisdiction = getJurisdiction(draft.jurisdictionId);
  const pkg = getPackage(draft.packageId);
  const docs = requiredDocumentStatus(requiredDocumentsFor(draft.registrationType), documents);
  const missingDocs = docs.filter((d) => !d.onRecord);
  const none = 'Not provided yet';
  return [
    { label: 'Registration type', value: draft.registrationType ? REGISTRATION_TYPE_LABELS[draft.registrationType] : none },
    { label: 'Jurisdiction', value: jurisdiction?.name ?? none },
    { label: 'Business activity', value: draft.activity || none },
    { label: 'Company name', value: draft.companyName || none },
    { label: 'Shareholders', value: draft.shareholders !== undefined ? String(draft.shareholders) : none },
    {
      label: 'Package',
      value: pkg ? `${pkg.name}${pkg.price !== undefined ? ` (${formatAed(pkg.price)})` : ' (pricing on request)'}` : none,
    },
    { label: 'Applicant', value: user.name },
    {
      label: 'Documents',
      value: missingDocs.length
        ? `${missingDocs.length} still needed: ${missingDocs.map((d) => d.label).join(', ')}`
        : 'All key documents are on record',
    },
  ];
}

function companySummary(wf: WorkflowState, ctx: EngineContext): AssistantContent {
  const jurisdiction = getJurisdiction(wf.company.jurisdictionId);
  return {
    kind: 'summary',
    workflow: 'company_registration',
    step: 'review',
    title: 'New Company Registration',
    fields: companySummaryFields(wf.company, ctx.user, ctx.documents),
    note: `We'll use the documents on record to fill in the application, and ${jurisdiction?.shortName ?? 'the authority'} would review it and confirm name availability. Prototype: fees and requirements are sample information, and nothing is filed with a real authority.`,
    problems: validateCompanyDraft(wf.company).map((p) => p.message),
  };
}

function financeSummary(wf: WorkflowState, ctx: EngineContext): AssistantContent {
  const docs = requiredDocumentStatus(FINANCE_REQUIRED_DOCUMENTS, ctx.documents);
  const missing = docs.filter((d) => !d.onRecord);
  return {
    kind: 'summary',
    workflow: 'working_capital_finance',
    step: 'review',
    title: 'Working Capital Finance Request',
    fields: [
      { label: 'Business', value: ctx.user.company },
      { label: 'Amount requested', value: wf.finance.amount !== undefined ? formatAed(wf.finance.amount) : 'Not provided yet' },
      { label: 'Purpose', value: wf.finance.purpose || 'Not provided yet' },
      {
        label: 'Documents',
        value: missing.length ? `${missing.map((d) => d.label).join(', ')} still needed` : 'All required documents are on record',
      },
    ],
    note: FINANCE_DISCLAIMER,
    problems: validateFinanceDraft(wf.finance).map((p) => p.message),
  };
}

// ------------------------------------------------------------ global intents

function startCompany(): EngineResult {
  const wf: WorkflowState = { ...INITIAL_WORKFLOW, type: 'company_registration', step: 'registration_type' };
  return result(wf, [
    text(
      'Happy to help you register a new company in the UAE. A couple of quick questions to get started - which type of company would you like to establish?',
    ),
    {
      kind: 'options',
      workflow: 'company_registration',
      step: 'registration_type',
      eyebrow: 'WHERE WOULD YOU LIKE TO REGISTER?',
      cards: registrationTypeCards(),
      note: SAMPLE_DATA_NOTE,
    },
  ]);
}

function startFinance(ctx: EngineContext): EngineResult {
  const wf: WorkflowState = { ...INITIAL_WORKFLOW, type: 'working_capital_finance', step: 'business_profile' };
  return result(
    wf,
    [
      text(`Happy to help with working capital. ${FINANCE_DISCLAIMER}`),
      text(`Shall I use ${ctx.user.company} for this request?`),
    ],
    [`Yes, use ${ctx.user.company}`],
  );
}

function statusReply(wf: WorkflowState, ctx: EngineContext): EngineResult {
  const recent = [...ctx.applications].sort((a, b) => updatedAtOf(b).localeCompare(updatedAtOf(a))).slice(0, 3);
  if (recent.length === 0) {
    return result(wf, [text('You have no applications yet. Would you like to start one?')], DEFAULT_QUICK_REPLIES);
  }
  return result(wf, [
    text("Here's where your latest applications stand."),
    { kind: 'status_list', applicationIds: recent.map((a) => a.id) },
  ]);
}

function uploadHelp(wf: WorkflowState, ctx: EngineContext): EngineResult {
  const preferred = ctx.applications.find((a) => a.id === wf.clarificationApplicationId);
  const target =
    preferred && pendingOf(preferred).some((r) => r.kind === 'document')
      ? preferred
      : ctx.applications.find((a) => pendingOf(a).some((r) => r.kind === 'document'));
  if (!target) return result(wf, [text('Nothing needs a document from you right now.')], DEFAULT_QUICK_REPLIES);
  return result(wf, [
    text('You can upload it using the document upload option below.'),
    { kind: 'upload', applicationId: target.id },
  ]);
}

function fallback(wf: WorkflowState): EngineResult {
  return result(wf, [text(FALLBACK_AI_RESPONSE.message)], FALLBACK_AI_RESPONSE.quickReplies ?? DEFAULT_QUICK_REPLIES);
}

function stale(wf: WorkflowState): EngineResult {
  return result(wf, [text('That option is no longer available. Let us continue from where we left off.')]);
}

export function exploreReply(wf: WorkflowState): EngineResult {
  return result(
    wf,
    [
      text(
        'I can help you start a company (Mainland, Free Zone or Offshore) or set up a Working Capital Finance request. Which would you like to explore?',
      ),
    ],
    ['Start a company', 'Working Capital Finance'],
  );
}

/** A fixed introduction, written by us, so the most basic question never gets "I did not get that". */
export function aboutReply(wf: WorkflowState): EngineResult {
  return result(
    wf,
    [
      text(
        "I'm Tajir, an assistant that helps you set up a company in the UAE (Mainland, Free Zone or Offshore) and record Working Capital Finance requests. I can guide you step by step, show sample options, collect your documents and keep track of your applications. This is a prototype: nothing is filed with any authority or lender.",
      ),
    ],
    DEFAULT_QUICK_REPLIES,
  );
}

export function greetReply(wf: WorkflowState, ctx: EngineContext): EngineResult {
  return result(wf, [text(`Hello ${ctx.user.firstName}! What can Tajir help you with today?`)], DEFAULT_QUICK_REPLIES);
}

export function unsupportedReply(wf: WorkflowState): EngineResult {
  return result(
    wf,
    [text("That journey isn't part of this prototype yet. I can help you start a company or set up a Working Capital Finance request.")],
    ['Start a company', 'Working Capital Finance'],
  );
}

export function fallbackReply(wf: WorkflowState): EngineResult {
  return fallback(wf);
}

function handleGlobalIntent(intent: Intent, wf: WorkflowState, ctx: EngineContext): EngineResult | null {
  switch (intent) {
    case 'start_company':
      return startCompany();
    case 'working_capital':
      return startFinance(ctx);
    case 'status':
      return statusReply(wf, ctx);
    case 'upload_help':
      return uploadHelp(wf, ctx);
    case 'explore':
      return exploreReply(wf);
    case 'about':
      return aboutReply(wf);
    case 'greet':
      return greetReply(wf, ctx);
    case 'unsupported':
      return unsupportedReply(wf);
    default:
      return null;
  }
}

// ------------------------------------------------------------ company flow

function companyTypeChosen(wf: WorkflowState, type: RegistrationType): EngineResult {
  const option = getRegistrationOption(type);
  const next = advance({ ...wf, company: { registrationType: type } }, 'jurisdiction');
  const noun = option?.jurisdictionNoun ?? 'options';
  const question =
    type === 'free_zone'
      ? 'Which free zone are you considering, or would you like me to show you some popular options based on your business activity?'
      : `Which of the ${noun} are you considering, or shall I show you some popular options?`;
  return result(next, [text(`Great choice. ${question}`)], [`Show me popular ${noun}`]);
}

function showJurisdictions(wf: WorkflowState): EngineResult {
  const type = wf.company.registrationType;
  if (!type) return fallback(wf);
  const option = getRegistrationOption(type);
  return result(wf, [
    text('Here are some popular options. Each suits different business types - which one fits your plan?'),
    {
      kind: 'options',
      workflow: 'company_registration',
      step: 'jurisdiction',
      eyebrow: option?.eyebrow ?? 'OPTIONS',
      cards: jurisdictionCards(type),
      note: SAMPLE_DATA_NOTE,
    },
  ]);
}

function jurisdictionChosen(wf: WorkflowState, jurisdictionId: string): EngineResult {
  const jurisdiction = getJurisdiction(jurisdictionId);
  if (!jurisdiction || jurisdiction.registrationType !== wf.company.registrationType) return stale(wf);
  const next = advance({ ...wf, company: { ...wf.company, jurisdictionId } }, 'business_details');
  return result(
    next,
    [
      text(
        `Good choice - ${jurisdiction.shortName} is ${jurisdiction.fit}. Let's get your new company registered. What will the business activity be?`,
      ),
    ],
    BUSINESS_ACTIVITIES.map((a) => a.label),
  );
}

type DetailField = 'activity' | 'companyName' | 'shareholders' | 'description';

export function nextDetailField(c: CompanyDraft): DetailField | null {
  if (c.activity === undefined) return 'activity';
  if (c.companyName === undefined) return 'companyName';
  if (c.shareholders === undefined) return 'shareholders';
  if (c.description === undefined) return 'description';
  return null;
}

const DETAIL_PROMPTS: Record<DetailField, { text: string; quickReplies: string[] }> = {
  activity: { text: 'What will the business activity be?', quickReplies: BUSINESS_ACTIVITIES.map((a) => a.label) },
  companyName: { text: 'What would you like to name your new company?', quickReplies: [] },
  shareholders: { text: 'How many shareholders will the company have?', quickReplies: ['1', '2', '3', '4'] },
  description: {
    text: 'Add a short description of what the company will do, or skip this for now.',
    quickReplies: ['Skip'],
  },
};

function askDetail(wf: WorkflowState, field: DetailField, prefix = ''): EngineResult {
  const prompt = DETAIL_PROMPTS[field];
  return result(wf, [text(`${prefix}${prompt.text}`)], prompt.quickReplies);
}

function toPackageSelection(wf: WorkflowState): EngineResult {
  const jurisdiction = getJurisdiction(wf.company.jurisdictionId);
  const next = advance(wf, 'package_selection');
  return result(next, [
    text(`Thanks. These are the packages available for ${jurisdiction?.shortName ?? 'your choice'} (sample data). Which one would you like?`),
    {
      kind: 'options',
      workflow: 'company_registration',
      step: 'package_selection',
      eyebrow: 'AVAILABLE PACKAGES',
      cards: packageCards(wf.company.jurisdictionId ?? ''),
      note: SAMPLE_DATA_NOTE,
    },
  ]);
}

function handleCompanyDetails(wf: WorkflowState, input: string): EngineResult {
  const field = nextDetailField(wf.company);
  if (!field) return toPackageSelection(wf);
  const shape = businessDetailsSchema.shape;
  let company = wf.company;
  let prefix = '';

  switch (field) {
    case 'activity': {
      const parsed = shape.activity.safeParse(input);
      if (!parsed.success) return askDetail(wf, field, `${parsed.error.issues[0]?.message}. `);
      company = { ...company, activity: parsed.data, category: categoryForActivity(parsed.data) };
      prefix = 'Got it. ';
      break;
    }
    case 'companyName': {
      const parsed = shape.companyName.safeParse(input);
      if (!parsed.success) return askDetail(wf, field, `${parsed.error.issues[0]?.message}. `);
      company = { ...company, companyName: parsed.data };
      break;
    }
    case 'shareholders': {
      const count = parseCount(input);
      const parsed = shape.shareholders.safeParse(count ?? Number.NaN);
      if (count === null || !parsed.success) {
        const message = count === null ? 'Please enter a whole number, for example 2' : parsed.error?.issues[0]?.message;
        return askDetail(wf, field, `${message}. `);
      }
      company = { ...company, shareholders: parsed.data };
      prefix = 'Almost there. ';
      break;
    }
    case 'description': {
      const skipped = /^(skip|no|none|nothing|n\/a)$/i.test(input.trim());
      const parsed = shape.description.safeParse(skipped ? '' : input);
      if (!parsed.success) return askDetail(wf, field, `${parsed.error.issues[0]?.message}. `);
      company = { ...company, description: parsed.data };
      break;
    }
  }

  const updated = { ...wf, company };
  const following = nextDetailField(company);
  return following ? askDetail(updated, following, prefix) : toPackageSelection(updated);
}

function packageChosen(wf: WorkflowState, packageId: string, ctx: EngineContext): EngineResult {
  const pkg = getPackage(packageId);
  if (!pkg || pkg.jurisdictionId !== wf.company.jurisdictionId) return stale(wf);
  const next = advance({ ...wf, company: { ...wf.company, packageId } }, 'review');
  return result(next, [
    text("Perfect. Here's a summary of your new company setup - please review and confirm to proceed."),
    companySummary(next, ctx),
  ]);
}

function submitCompany(wf: WorkflowState, _ctx: EngineContext): EngineResult {
  const problems = validateCompanyDraft(wf.company);
  if (problems.length > 0) {
    return result(wf, [text(`I can't submit yet: ${problems.map((p) => p.message).join('; ')}.`)]);
  }
  const complete = completeCompanySchema.parse({ ...wf.company, description: wf.company.description ?? '' });
  const jurisdiction = getJurisdiction(complete.jurisdictionId);

  return {
    workflow: wf,
    replies: [],
    quickReplies: [],
    effects: [
      {
        type: 'submit_company',
        company: complete,
        done: (application) => {
          const waiting = pendingOf(application);
          const replies: AssistantContent[] = waiting.length
            ? [
                text(
                  `Your request for ${complete.companyName} is recorded as ${application.id}, but it can't go further yet. We still need: ${waiting.map((r) => r.label).join(', ')}. You can upload them below.`,
                ),
                { kind: 'status', applicationId: application.id },
                { kind: 'upload', applicationId: application.id },
              ]
            : [
                text(
                  `Your company registration for ${complete.companyName} has been submitted to ${jurisdiction?.shortName ?? 'the authority'}. Your reference is ${application.id}. You'll receive updates here as it progresses - typical processing takes ${jurisdiction?.processing ?? 'a few days'} (sample estimate). Prototype: nothing is filed with a real authority.`,
                ),
                { kind: 'status', applicationId: application.id },
              ];
          return { workflow: advance(wf, 'submitted'), replies, quickReplies: ['Check registration status', 'Start a company'] };
        },
      },
    ],
  };
}

function handleCompanyText(wf: WorkflowState, input: string, ctx: EngineContext): EngineResult {
  switch (wf.step) {
    case 'registration_type': {
      const type = parseRegistrationType(input);
      if (type) return companyTypeChosen(wf, type);
      return result(wf, [text('Please choose UAE Mainland, Free Zone or Offshore.')], REGISTRATION_OPTIONS.map((o) => o.title));
    }
    case 'jurisdiction': {
      const type = wf.company.registrationType;
      const t = lower(input);
      const match = jurisdictionsFor(type).find(
        (j) => j.aliases.some((alias) => t.includes(alias)) || t.includes(j.shortName.toLowerCase()),
      );
      if (match) return jurisdictionChosen(wf, match.id);
      if (/popular|show|option|suggest|yes|list|which/.test(t)) return showJurisdictions(wf);
      const noun = getRegistrationOption(type)?.jurisdictionNoun ?? 'options';
      return result(wf, [text("I couldn't find that one. Would you like to see the popular options?")], [`Show me popular ${noun}`]);
    }
    case 'business_details':
      return handleCompanyDetails(wf, input);
    case 'package_selection': {
      const t = lower(input);
      const match = packagesForJurisdiction(wf.company.jurisdictionId).find((p) => t.includes(p.name.toLowerCase()));
      if (match) return packageChosen(wf, match.id, ctx);
      return result(wf, [text('Please pick one of the packages above, or tell me its name.')]);
    }
    case 'review': {
      if (isConfirmation(input)) return submitCompany(wf, ctx);
      if (/edit|change|update/.test(lower(input))) {
        return result(wf, [text('You can change any detail on the review page. Use "Review & edit details" on the summary above.')]);
      }
      return result(wf, [text('Please confirm with the button on the summary, or say "confirm" to submit.')]);
    }
    default:
      return result(
        wf,
        [text('Your application is already submitted. You can follow it from Activity.')],
        ['Check registration status', 'Start a company'],
      );
  }
}

// ------------------------------------------------------------- finance flow

function askFinanceNeed(wf: WorkflowState, prefix = ''): EngineResult {
  if (wf.finance.amount === undefined) {
    return result(
      wf,
      [text(`${prefix}How much working capital do you need, in AED?`)],
      FINANCE_AMOUNT_CHIPS.map((n) => formatAed(n)),
    );
  }
  return result(wf, [text(`${prefix}What will the funds be used for?`)], FINANCE_PURPOSES);
}

function handleFinanceNeed(wf: WorkflowState, input: string, ctx: EngineContext): EngineResult {
  const shape = completeFinanceSchema.shape;
  let finance = wf.finance;
  if (finance.amount === undefined) {
    const amount = parseAmount(input);
    const parsed = shape.amount.safeParse(amount ?? Number.NaN);
    if (amount === null || !parsed.success) {
      const message = amount === null ? 'Please enter an amount in AED, for example 350000' : parsed.error?.issues[0]?.message;
      return askFinanceNeed(wf, `${message}. `);
    }
    finance = { ...finance, amount: parsed.data };
    return askFinanceNeed({ ...wf, finance }, 'Noted. ');
  }
  const parsed = shape.purpose.safeParse(input);
  if (!parsed.success) return askFinanceNeed(wf, `${parsed.error.issues[0]?.message}. `);
  finance = { ...finance, purpose: parsed.data };

  return toFinanceDocuments({ ...wf, finance }, ctx);
}

function toFinanceDocuments(wf: WorkflowState, ctx: EngineContext): EngineResult {
  const next = advance(wf, 'documents');
  const missing = requiredDocumentStatus(FINANCE_REQUIRED_DOCUMENTS, ctx.documents).filter((d) => !d.onRecord);
  const message = missing.length
    ? `To process your request we'll need your ${missing.map((d) => documentLabel(d.typeId).toLowerCase()).join(', ')}. It isn't on record yet, so I'll flag it on your request and you can add it as soon as the request is created.`
    : 'Everything we need is already on record.';
  return result(next, [text(message)], ['Continue']);
}

function submitFinance(wf: WorkflowState, _ctx: EngineContext): EngineResult {
  const problems = validateFinanceDraft(wf.finance);
  if (problems.length > 0) {
    return result(wf, [text(`I can't submit yet: ${problems.map((p) => p.message).join('; ')}.`)]);
  }
  const complete = completeFinanceSchema.parse(wf.finance);

  return {
    workflow: wf,
    replies: [],
    quickReplies: [],
    effects: [
      {
        type: 'submit_finance',
        finance: complete,
        done: (application) => {
          const waiting = pendingOf(application);
          const replies: AssistantContent[] = [
            text(`Your working capital request ${application.id} for ${formatAed(complete.amount)} has been recorded. ${FINANCE_DISCLAIMER}`),
            { kind: 'status', applicationId: application.id },
          ];
          if (waiting.length) {
            replies.push(text(`We still need: ${waiting.map((r) => r.label).join(', ')}.`), { kind: 'upload', applicationId: application.id });
          }
          return { workflow: advance(wf, 'submitted'), replies, quickReplies: ['Check registration status'] };
        },
      },
    ],
  };
}

function handleFinanceText(wf: WorkflowState, input: string, ctx: EngineContext): EngineResult {
  switch (wf.step) {
    case 'business_profile': {
      if (!AFFIRMATIVE.test(input)) {
        return result(wf, [text(`This prototype uses ${ctx.user.company}. Shall I continue with it?`)], [`Yes, use ${ctx.user.company}`]);
      }
      return askFinanceNeed(advance(wf, 'financing_need'));
    }
    case 'financing_need':
      return handleFinanceNeed(wf, input, ctx);
    case 'documents': {
      if (!AFFIRMATIVE.test(input)) return result(wf, [text('Say "continue" when you are ready to review your request.')], ['Continue']);
      const next = advance(wf, 'review');
      return result(next, [text("Here's a summary of your request - please review and confirm."), financeSummary(next, ctx)]);
    }
    case 'review':
      if (isConfirmation(input)) return submitFinance(wf, ctx);
      return result(wf, [text('Please confirm with the button on the summary, or say "confirm" to submit.')]);
    default:
      return result(wf, [text('Your request is already recorded. You can follow it from Activity.')], ['Check registration status']);
  }
}

// ----------------------------------------------------------- clarifications

function shortLabel(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

export function startClarification(app: Application): EngineResult {
  const wf: WorkflowState = { ...INITIAL_WORKFLOW, clarificationApplicationId: app.id };
  const pending = pendingOf(app);
  const first = pending[0];
  if (!first) {
    return result(wf, [text(`Nothing is outstanding for ${app.title} ${app.id}.`), { kind: 'status', applicationId: app.id }]);
  }
  const lead =
    first.kind === 'document'
      ? `We need your ${shortLabel(first.label)} to continue ${app.title.toLowerCase()} ${app.id}.`
      : `We need one more detail to continue ${app.title.toLowerCase()} ${app.id}: ${first.label}. Please type it below.`;
  return result(
    wf,
    [text(lead), { kind: 'upload', applicationId: app.id }],
    first.kind === 'document' ? ['Where can I upload it?'] : [],
  );
}

/** Reply after a document upload has been applied. `app` is the updated application. */
export function uploadAcknowledgement(wf: WorkflowState, app: Application, label: string): EngineResult {
  const pending = pendingOf(app);
  if (pending.length > 0) {
    return result(wf, [
      text(`Thanks, I've recorded your ${shortLabel(label)}. The file is stored on this prototype's server. Still outstanding: ${pending.map((r) => r.label).join(', ')}.`),
      { kind: 'upload', applicationId: app.id },
    ]);
  }
  return result(wf, [
    text(`Thanks, I've recorded your ${shortLabel(label)}. The file is stored on this prototype's server. That's everything we need for now.`),
    { kind: 'status', applicationId: app.id },
  ]);
}

function handleClarificationText(wf: WorkflowState, input: string, ctx: EngineContext): EngineResult | null {
  const app = ctx.applications.find((a) => a.id === wf.clarificationApplicationId);
  if (!app) return null;
  const pending = pendingOf(app);
  const info = pending.find((r) => r.kind === 'information');
  if (!info) {
    if (pending.some((r) => r.kind === 'document')) {
      return result(wf, [text('Please use the upload option below for that document.'), { kind: 'upload', applicationId: app.id }]);
    }
    return null;
  }
  if (input.length > 120) {
    return result(wf, [text('Please keep that answer under 120 characters.')]);
  }
  return {
    workflow: wf,
    replies: [],
    quickReplies: [],
    effects: [
      {
        type: 'provide_information',
        applicationId: app.id,
        requirementId: info.id,
        value: input,
        done: (updated) => {
          const remaining = pendingOf(updated);
          const replies: AssistantContent[] = remaining.length
            ? [
                text(`Thanks, I've saved that. Still outstanding: ${remaining.map((r) => r.label).join(', ')}.`),
                { kind: 'upload', applicationId: updated.id },
              ]
            : [text("Thanks, I've saved that. That's everything we need for now."), { kind: 'status', applicationId: updated.id }];
          return { workflow: wf, replies, quickReplies: [] };
        },
      },
    ],
  };
}

// -------------------------------------------------------------------- entry

function handleSelect(wf: WorkflowState, input: Extract<EngineInput, { type: 'select' }>, ctx: EngineContext): EngineResult {
  if (wf.type !== 'company_registration' || input.step !== wf.step) return stale(wf);
  switch (wf.step) {
    case 'registration_type': {
      const type = REGISTRATION_OPTIONS.find((o) => o.id === input.cardId)?.id;
      return type ? companyTypeChosen(wf, type) : stale(wf);
    }
    case 'jurisdiction':
      return jurisdictionChosen(wf, input.cardId);
    case 'package_selection':
      return packageChosen(wf, input.cardId, ctx);
    default:
      return stale(wf);
  }
}

function handleConfirm(wf: WorkflowState, input: Extract<EngineInput, { type: 'confirm' }>, ctx: EngineContext): EngineResult {
  if (!wf.type || wf.step !== 'review' || input.step !== 'review') return stale(wf);
  return wf.type === 'company_registration' ? submitCompany(wf, ctx) : submitFinance(wf, ctx);
}

function collectingFreeText(wf: WorkflowState, ctx: EngineContext): boolean {
  if (wf.type === 'company_registration' && wf.step === 'business_details') return true;
  if (wf.type === 'working_capital_finance' && wf.step === 'financing_need') return true;
  if (!wf.type && wf.clarificationApplicationId) {
    const app = ctx.applications.find((a) => a.id === wf.clarificationApplicationId);
    return !!app && pendingOf(app).some((r) => r.kind === 'information');
  }
  return false;
}

function handleText(wf: WorkflowState, input: string, ctx: EngineContext): EngineResult {
  if (!input) return result(wf, [text('Type a message or pick one of the options below.')], DEFAULT_QUICK_REPLIES);

  const intent = collectingFreeText(wf, ctx) ? classifyStrict(input) : classify(input);
  const global = handleGlobalIntent(intent, wf, ctx);
  if (global) return global;

  if (wf.type === 'company_registration') return handleCompanyText(wf, input, ctx);
  if (wf.type === 'working_capital_finance') return handleFinanceText(wf, input, ctx);
  if (wf.clarificationApplicationId) {
    const clarified = handleClarificationText(wf, input, ctx);
    if (clarified) return clarified;
  }
  return fallback(wf);
}

/** Main entry point: the whole mock AI is this one pure function. */
export function respond(wf: WorkflowState, input: EngineInput, ctx: EngineContext): EngineResult {
  switch (input.type) {
    case 'select':
      return handleSelect(wf, input, ctx);
    case 'confirm':
      return handleConfirm(wf, input, ctx);
    default:
      return handleText(wf, input.text.trim(), ctx);
  }
}

// ----------------------------------------------------- structured proposals
//
// These accept values that an AI model proposed. Every value goes through the same
// schemas as typed input, so a model can never put an invalid or out-of-range value
// into the draft, and the step only moves forward when the draft allows it.

export interface DetailsPatch {
  activity?: string;
  companyName?: string;
  shareholders?: number;
  description?: string;
}

/** Applies several business details at once, then asks for whatever is still missing. */
export function applyDetails(wf: WorkflowState, patch: DetailsPatch): EngineResult {
  if (wf.type !== 'company_registration' || wf.step !== 'business_details') return stale(wf);
  const shape = businessDetailsSchema.shape;
  let company = wf.company;
  const problems: string[] = [];
  let applied = 0;

  if (patch.activity !== undefined) {
    const parsed = shape.activity.safeParse(patch.activity);
    if (parsed.success) {
      company = { ...company, activity: parsed.data, category: categoryForActivity(parsed.data) };
      applied += 1;
    } else problems.push(parsed.error.issues[0]?.message ?? 'That activity is not valid');
  }
  if (patch.companyName !== undefined) {
    const parsed = shape.companyName.safeParse(patch.companyName);
    if (parsed.success) {
      company = { ...company, companyName: parsed.data };
      applied += 1;
    } else problems.push(parsed.error.issues[0]?.message ?? 'That company name is not valid');
  }
  if (patch.shareholders !== undefined) {
    const parsed = shape.shareholders.safeParse(patch.shareholders);
    if (parsed.success) {
      company = { ...company, shareholders: parsed.data };
      applied += 1;
    } else problems.push(parsed.error.issues[0]?.message ?? 'That number of shareholders is not valid');
  }
  if (patch.description !== undefined) {
    const parsed = shape.description.safeParse(patch.description);
    if (parsed.success) {
      company = { ...company, description: parsed.data };
      applied += 1;
    } else problems.push(parsed.error.issues[0]?.message ?? 'That description is not valid');
  }

  const updated = { ...wf, company };
  const following = nextDetailField(company);
  const prefix = problems.length > 0 ? `${problems.join('. ')}. ` : applied > 0 ? 'Got it. ' : '';
  return following ? askDetail(updated, following, prefix) : toPackageSelection(updated);
}

export interface FinanceNeedPatch {
  amount?: number;
  purpose?: string;
}

/** Applies the amount and purpose together, then asks for what is missing or moves on. */
export function applyFinanceNeed(wf: WorkflowState, patch: FinanceNeedPatch, ctx: EngineContext): EngineResult {
  if (wf.type !== 'working_capital_finance' || wf.step !== 'financing_need') return stale(wf);
  const shape = completeFinanceSchema.shape;
  let finance = wf.finance;
  const problems: string[] = [];
  let applied = 0;

  if (patch.amount !== undefined) {
    const parsed = shape.amount.safeParse(Math.round(patch.amount));
    if (parsed.success) {
      finance = { ...finance, amount: parsed.data };
      applied += 1;
    } else problems.push(parsed.error.issues[0]?.message ?? 'That amount is not valid');
  }
  if (patch.purpose !== undefined) {
    const parsed = shape.purpose.safeParse(patch.purpose);
    if (parsed.success) {
      finance = { ...finance, purpose: parsed.data };
      applied += 1;
    } else problems.push(parsed.error.issues[0]?.message ?? 'That purpose is not valid');
  }

  const updated = { ...wf, finance };
  const prefix = problems.length > 0 ? `${problems.join('. ')}. ` : applied > 0 ? 'Noted. ' : '';
  if (updated.finance.amount === undefined || updated.finance.purpose === undefined) return askFinanceNeed(updated, prefix);
  return toFinanceDocuments(updated, ctx);
}

// ---------------------------------------------------------------- re-prompting

/**
 * Asks the question the workflow is waiting for again, without changing state.
 * Used after a side question or when a message could not be used as an answer.
 */
export function reprompt(wf: WorkflowState, ctx: EngineContext): { replies: AssistantContent[]; quickReplies: string[] } {
  const asked = (r: EngineResult) => ({ replies: r.replies, quickReplies: r.quickReplies });

  if (wf.type === null) {
    const app = ctx.applications.find((a) => a.id === wf.clarificationApplicationId);
    const pending = app ? pendingOf(app) : [];
    if (app && pending.length > 0) {
      const first = pending[0]!;
      return {
        replies: [text(first.kind === 'document' ? `We still need your ${shortLabel(first.label)}.` : `We still need: ${first.label}. Please type it below.`)],
        quickReplies: first.kind === 'document' ? ['Where can I upload it?'] : [],
      };
    }
    return { replies: [], quickReplies: DEFAULT_QUICK_REPLIES };
  }

  if (wf.type === 'company_registration') {
    switch (wf.step) {
      case 'registration_type':
        return {
          replies: [text('Which type of company would you like to establish: UAE Mainland, Free Zone or Offshore?')],
          quickReplies: REGISTRATION_OPTIONS.map((o) => o.title),
        };
      case 'jurisdiction': {
        const noun = getRegistrationOption(wf.company.registrationType)?.jurisdictionNoun ?? 'options';
        return { replies: [text(`Which of the ${noun} are you considering, or shall I show you some popular options?`)], quickReplies: [`Show me popular ${noun}`] };
      }
      case 'business_details': {
        const field = nextDetailField(wf.company);
        return field ? asked(askDetail(wf, field)) : { replies: [], quickReplies: [] };
      }
      case 'package_selection':
        return { replies: [text('Please pick one of the packages shown, or tell me its name.')], quickReplies: [] };
      case 'review':
        return { replies: [text('Please confirm with the button on the summary, or say "confirm" to submit.')], quickReplies: [] };
      default:
        return { replies: [], quickReplies: ['Check registration status', 'Start a company'] };
    }
  }

  switch (wf.step) {
    case 'business_profile':
      return { replies: [text(`Shall I use ${ctx.user.company} for this request?`)], quickReplies: [`Yes, use ${ctx.user.company}`] };
    case 'financing_need':
      return asked(askFinanceNeed(wf));
    case 'documents':
      return { replies: [text('Say "continue" when you are ready to review your request.')], quickReplies: ['Continue'] };
    case 'review':
      return { replies: [text('Please confirm with the button on the summary, or say "confirm" to submit.')], quickReplies: [] };
    default:
      return { replies: [], quickReplies: ['Check registration status'] };
  }
}

// ------------------------------------------------------- running the effects

export interface SettledTurn {
  workflow: WorkflowState;
  replies: AssistantContent[];
  quickReplies: string[];
  /** The applications after the effects ran. */
  applications: Application[];
  createdApplicationId?: string;
}

/**
 * Carries out the engine's effects in memory, using the shared builders. This is
 * what the browser prototype uses. The backend does the same through its own
 * validated services and database.
 */
export function settleLocally(result: EngineResult, ctx: EngineContext): SettledTurn {
  let applications = ctx.applications;
  let workflow = result.workflow;
  const replies = [...result.replies];
  let quickReplies = result.quickReplies;
  let createdApplicationId: string | undefined;

  for (const effect of result.effects) {
    let application: Application | undefined;
    const build = { documents: ctx.documents, existingIds: applications.map((a) => a.id), now: ctx.now, newId: ctx.newId, random: ctx.random };

    if (effect.type === 'submit_company') {
      application = buildCompanyApplication(effect.company, build);
      applications = [application, ...applications];
      createdApplicationId = application.id;
    } else if (effect.type === 'submit_finance') {
      application = buildFinanceApplication(effect.finance, ctx.user.company, build);
      applications = [application, ...applications];
      createdApplicationId = application.id;
    } else {
      const existing = applications.find((a) => a.id === effect.applicationId);
      if (!existing) continue;
      try {
        application = provideRequirement(existing, effect.requirementId, { now: ctx.now, newId: ctx.newId }, { actor: 'user', value: effect.value });
      } catch {
        // The workflow refused the step, for example because it was already provided. Nothing changes.
        application = existing;
      }
      const settled = application;
      applications = applications.map((a) => (a.id === settled.id ? settled : a));
    }

    const completion = effect.done(application);
    workflow = completion.workflow;
    replies.push(...completion.replies);
    quickReplies = completion.quickReplies;
  }

  return { workflow, replies, quickReplies, applications, createdApplicationId };
}
