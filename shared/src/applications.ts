import type { ApplicationStatus } from './application.js';
import {
  documentLabel,
  FINANCE_INFORMATION_REQUESTS,
  FINANCE_REQUIRED_DOCUMENTS,
  getJurisdiction,
  getPackage,
  requiredDocumentsFor,
} from './catalog.js';
import type { CompleteCompany, CompleteFinance } from './company.js';
import { formatAed } from './format.js';
import {
  canRecordEvent,
  computeProgress,
  nextExternalStep,
  pendingRequirementsOf,
  requirementsOf,
  statusFromEvents,
} from './progress.js';
import type {
  ApplicationProgress,
  EventActor,
  EventCandidate,
  ProgressStepDef,
  Requirement,
  RequirementSpec,
  WorkflowEvent,
} from './progress.js';
import { REGISTRATION_TYPE_LABELS } from './workflow.js';
import type { WorkflowType } from './workflow.js';

export interface DetailRow {
  label: string;
  value: string;
}

/**
 * An application is its identity plus an ordered event log. Status, progress,
 * requirements and dates are all derived from `events`, never stored beside them.
 */
export interface Application {
  /** Human-readable reference, for example REG-2026-178295. */
  id: string;
  service: WorkflowType;
  title: string;
  subtitle: string;
  details: DetailRow[];
  events: WorkflowEvent[];
}

export interface EventContext {
  now: Date;
  newId: () => string;
}

export interface BuildContext extends EventContext {
  /** Documents the user already has on record. Only the type matters here. */
  documents: ReadonlyArray<{ typeId: string }>;
  existingIds: readonly string[];
  random?: () => number;
}

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

// ----------------------------------------------------------------- derived

export const statusOf = (app: Application): ApplicationStatus => statusFromEvents(app.events);
export const progressOf = (app: Application): ApplicationProgress => computeProgress(app.service, app.events);
export const requirementsOfApp = (app: Application): Requirement[] => requirementsOf(app.events);
export const pendingOf = (app: Application): Requirement[] => pendingRequirementsOf(app.events);
export const createdAtOf = (app: Application): string => app.events[0]?.at ?? '';
export const updatedAtOf = (app: Application): string => app.events[app.events.length - 1]?.at ?? '';
export const submittedAtOf = (app: Application): string | undefined => app.events.find((e) => e.kind === 'submitted')?.at;

/** Detail rows plus the answers the user later gave to information requests. */
export function detailRowsOf(app: Application): DetailRow[] {
  const answers = requirementsOf(app.events)
    .filter((r) => r.kind === 'information' && r.done && r.value !== undefined)
    .map((r) => ({ label: r.label, value: r.value as string }));
  return [...app.details, ...answers];
}

const STATUS_ACTIONS: Record<ApplicationStatus, string> = {
  request_understood: 'Tajir is reviewing your request',
  information_required: 'We need a little more information',
  documents_pending: 'We need a document from you',
  preparation: 'We are preparing your request',
  submitted: 'Submitted. Nothing needed from you right now',
  under_review: 'Under review. Nothing needed from you right now',
  completed: 'Nothing further needed',
};

export function nextAction(app: Application): { text: string; needsAction: boolean } {
  const pending = pendingOf(app)[0];
  if (pending) {
    const verb = pending.kind === 'document' ? 'Upload' : 'Provide';
    const label = pending.label.charAt(0).toLowerCase() + pending.label.slice(1);
    return { text: `${verb} ${label}`, needsAction: true };
  }
  return { text: STATUS_ACTIONS[statusOf(app)], needsAction: false };
}

// ---------------------------------------------------------------- recording

export type EventDraft = Pick<WorkflowEvent, 'kind' | 'actor' | 'title'> &
  Partial<Pick<WorkflowEvent, 'detail' | 'requirement' | 'requirementId' | 'value'>>;

/** Appends an event if, and only if, the workflow allows it. */
export function recordEvent(app: Application, draft: EventDraft, ctx: EventContext): Application {
  const candidate: EventCandidate = { kind: draft.kind, requirement: draft.requirement, requirementId: draft.requirementId };
  const check = canRecordEvent(app.service, app.events, candidate);
  if (!check.ok) throw new WorkflowError(check.reason);
  const event: WorkflowEvent = { id: ctx.newId(), at: ctx.now.toISOString(), ...draft };
  return { ...app, events: [...app.events, event] };
}

function requestRequirement(app: Application, requirement: RequirementSpec, ctx: EventContext): Application {
  return recordEvent(
    app,
    {
      kind: 'requirement_requested',
      actor: 'system',
      title: `Waiting for: ${requirement.label}`,
      detail: requirement.kind === 'document' ? 'Document needed' : 'Information needed',
      requirement,
    },
    ctx,
  );
}

/**
 * When nothing is outstanding, records the automatic follow-on steps: the
 * requirements gate, then submission (company) or preparation (finance).
 * Every step here is recorded only because its precondition now holds, and it
 * does nothing if there is nothing left to record, so it is safe to call again
 * (the backend uses it to finish a cascade that was interrupted).
 */
export function settleApplication(app: Application, ctx: EventContext): Application {
  let next = app;
  const has = (kind: WorkflowEvent['kind']) => next.events.some((e) => e.kind === kind);
  if (pendingRequirementsOf(next.events).length > 0 || !has('details_confirmed')) return next;

  if (!has('requirements_complete')) {
    next = recordEvent(
      next,
      next.service === 'company_registration'
        ? { kind: 'requirements_complete', actor: 'system', title: 'Documents ready', detail: 'All required documents are on record' }
        : { kind: 'requirements_complete', actor: 'system', title: 'Documents and information received' },
      ctx,
    );
  }
  if (next.service === 'company_registration' && !has('submitted')) {
    next = recordEvent(
      next,
      { kind: 'submitted', actor: 'system', title: 'Submitted', detail: 'Prototype: nothing is filed with a real authority' },
      ctx,
    );
  }
  if (next.service === 'working_capital_finance' && !has('preparation_started')) {
    next = recordEvent(
      next,
      { kind: 'preparation_started', actor: 'system', title: 'Preparation started', detail: 'Prototype: no lender is contacted' },
      ctx,
    );
  }
  return next;
}

export interface ProvideOptions {
  actor: EventActor;
  /** Answer text for an information requirement. */
  value?: string;
  /** For example the file name. Never file contents. */
  detail?: string;
}

/** Records that a requirement was provided, then settles the application if that was the last one. */
export function provideRequirement(
  app: Application,
  requirementId: string,
  ctx: EventContext,
  options: ProvideOptions,
): Application {
  const requirement = pendingRequirementsOf(app.events).find((r) => r.id === requirementId);
  if (!requirement) throw new WorkflowError('That requirement is not outstanding.');
  const provided = recordEvent(
    app,
    {
      kind: 'requirement_provided',
      actor: options.actor,
      title: requirement.kind === 'document' ? `Document recorded: ${requirement.label}` : `Provided: ${requirement.label}`,
      detail: options.detail,
      requirementId,
      value: options.value,
    },
    ctx,
  );
  return settleApplication(provided, ctx);
}

/** Prototype only: stands in for an authority or provider by recording the next external step. */
export function simulateNext(app: Application, ctx: EventContext): { app: Application; step: ProgressStepDef } | null {
  const step = nextExternalStep(app.service, app.events);
  if (!step) return null;
  const next = recordEvent(
    app,
    {
      kind: step.kind,
      actor: 'simulation',
      title: `${step.label} (simulated)`,
      detail: 'Prototype only: no authority or provider was contacted',
    },
    ctx,
  );
  return { app: next, step };
}

// ----------------------------------------------------------------- builders

/** REG-2026-178295 style reference, unique among `existingIds`. */
export function generateReference(
  prefix: 'REG' | 'FIN',
  existingIds: readonly string[],
  now: Date,
  random: () => number = Math.random,
): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const digits = String(Math.floor(random() * 1_000_000)).padStart(6, '0');
    const id = `${prefix}-${now.getFullYear()}-${digits}`;
    if (!existingIds.includes(id)) return id;
  }
  throw new Error('Could not generate a unique reference');
}

function missingDocuments(typeIds: string[], documents: ReadonlyArray<{ typeId: string }>): string[] {
  return typeIds.filter((typeId) => !documents.some((d) => d.typeId === typeId));
}

export function companyDetailRows(company: CompleteCompany): DetailRow[] {
  const jurisdiction = getJurisdiction(company.jurisdictionId);
  const pkg = getPackage(company.packageId);
  return [
    { label: 'Registration type', value: REGISTRATION_TYPE_LABELS[company.registrationType] },
    { label: 'Jurisdiction', value: jurisdiction?.name ?? company.jurisdictionId },
    { label: 'Business activity', value: company.activity },
    { label: 'Business category', value: company.category },
    { label: 'Company name', value: company.companyName },
    { label: 'Shareholders', value: String(company.shareholders) },
    { label: 'Package', value: pkg ? pkg.name : company.packageId },
    ...(company.description ? [{ label: 'Description', value: company.description }] : []),
  ];
}

/** Creates the application for a validated company registration. Every event is checked as it is recorded. */
export function buildCompanyApplication(company: CompleteCompany, ctx: BuildContext): Application {
  let app: Application = {
    id: generateReference('REG', ctx.existingIds, ctx.now, ctx.random),
    service: 'company_registration',
    title: 'Company Registration',
    subtitle: company.companyName,
    details: companyDetailRows(company),
    events: [],
  };
  app = recordEvent(app, { kind: 'request_understood', actor: 'system', title: 'Request understood', detail: 'Company Registration' }, ctx);
  app = recordEvent(
    app,
    { kind: 'details_confirmed', actor: 'user', title: 'Details confirmed', detail: `Confirmed by you for ${company.companyName}` },
    ctx,
  );
  for (const typeId of missingDocuments(requiredDocumentsFor(company.registrationType), ctx.documents)) {
    app = requestRequirement(
      app,
      { id: `req-${typeId}`, label: documentLabel(typeId), kind: 'document', docTypeId: typeId },
      ctx,
    );
  }
  return settleApplication(app, ctx);
}

export function buildFinanceApplication(finance: CompleteFinance, company: string, ctx: BuildContext): Application {
  let app: Application = {
    id: generateReference('FIN', ctx.existingIds, ctx.now, ctx.random),
    service: 'working_capital_finance',
    title: 'Working Capital Finance',
    subtitle: formatAed(finance.amount),
    details: [
      { label: 'Business', value: company },
      { label: 'Amount requested', value: formatAed(finance.amount) },
      { label: 'Purpose', value: finance.purpose },
    ],
    events: [],
  };
  app = recordEvent(app, { kind: 'request_understood', actor: 'system', title: 'Request understood', detail: 'Working Capital Finance' }, ctx);
  app = recordEvent(
    app,
    { kind: 'details_confirmed', actor: 'user', title: 'Request confirmed', detail: `${formatAed(finance.amount)} for ${finance.purpose}` },
    ctx,
  );
  for (const typeId of missingDocuments(FINANCE_REQUIRED_DOCUMENTS, ctx.documents)) {
    app = requestRequirement(
      app,
      { id: `req-${typeId}`, label: documentLabel(typeId), kind: 'document', docTypeId: typeId },
      ctx,
    );
  }
  FINANCE_INFORMATION_REQUESTS.forEach((label, index) => {
    app = requestRequirement(app, { id: `req-info-${index}`, label, kind: 'information' }, ctx);
  });
  return settleApplication(app, ctx);
}
