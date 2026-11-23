import type { ApplicationStatus } from './application.js';
import type { WorkflowType } from './workflow.js';

/**
 * Application progress is NOT stored. It is computed from the ordered list of
 * workflow events, so a step can only show as complete if the matching event
 * was actually recorded. `canRecordEvent` is the single gate that decides
 * whether an event may be appended, which prevents out-of-order or invented
 * steps. The same code runs in the browser prototype and on the backend.
 */

export const EVENT_KINDS = [
  'request_understood',
  'details_confirmed',
  'requirement_requested',
  'requirement_provided',
  'requirements_complete',
  'preparation_started',
  'submitted',
  'under_review',
  'completed',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** user = the person did it. system = the workflow engine did it. simulation = a prototype-only stand-in for an authority or provider. */
export const EVENT_ACTORS = ['user', 'system', 'simulation'] as const;
export type EventActor = (typeof EVENT_ACTORS)[number];

export interface RequirementSpec {
  id: string;
  label: string;
  /** "document" is resolved by an upload, "information" by typing the answer. */
  kind: 'document' | 'information';
  docTypeId?: string;
}

export interface WorkflowEvent {
  id: string;
  /** ISO timestamp. */
  at: string;
  kind: EventKind;
  actor: EventActor;
  title: string;
  detail?: string;
  /** Set on requirement_requested. */
  requirement?: RequirementSpec;
  /** Set on requirement_provided. */
  requirementId?: string;
  /** Answer given for an information requirement. */
  value?: string;
}

export type MilestoneKind = Exclude<EventKind, 'requirement_requested' | 'requirement_provided'>;

export interface ProgressStepDef {
  kind: MilestoneKind;
  label: string;
}

/**
 * The steps of each service, in order. A step is complete when an event of its
 * kind exists. Under review and Completed can only be recorded by a provider or
 * authority integration, or by the clearly labelled simulation in the prototype.
 */
export const PROGRESS_STEPS: Record<WorkflowType, readonly ProgressStepDef[]> = {
  company_registration: [
    { kind: 'request_understood', label: 'Request understood' },
    { kind: 'details_confirmed', label: 'Details confirmed' },
    { kind: 'requirements_complete', label: 'Documents ready' },
    { kind: 'submitted', label: 'Submitted' },
    { kind: 'under_review', label: 'Under review' },
    { kind: 'completed', label: 'Completed' },
  ],
  working_capital_finance: [
    { kind: 'request_understood', label: 'Request understood' },
    { kind: 'details_confirmed', label: 'Request confirmed' },
    { kind: 'requirements_complete', label: 'Documents and information received' },
    { kind: 'preparation_started', label: 'Preparation' },
    { kind: 'under_review', label: 'Under review' },
    { kind: 'completed', label: 'Completed' },
  ],
};

// ------------------------------------------------------------ requirements

export interface Requirement extends RequirementSpec {
  done: boolean;
  providedAt?: string;
  value?: string;
}

/** Requirements are requested and provided by events, in order. */
export function requirementsOf(events: readonly WorkflowEvent[]): Requirement[] {
  const list: Requirement[] = [];
  for (const event of events) {
    if (event.kind === 'requirement_requested' && event.requirement) {
      list.push({ ...event.requirement, done: false });
    } else if (event.kind === 'requirement_provided' && event.requirementId) {
      const match = list.find((r) => r.id === event.requirementId && !r.done);
      if (match) {
        match.done = true;
        match.providedAt = event.at;
        if (event.value !== undefined) match.value = event.value;
      }
    }
  }
  return list;
}

export function pendingRequirementsOf(events: readonly WorkflowEvent[]): Requirement[] {
  return requirementsOf(events).filter((r) => !r.done);
}

// ---------------------------------------------------------------- progress

export type StepState = 'complete' | 'current' | 'upcoming';

export interface ProgressStepState extends ProgressStepDef {
  state: StepState;
  /** When the matching event happened. Only set for complete steps. */
  at?: string;
  actor?: EventActor;
}

export interface ApplicationProgress {
  steps: ProgressStepState[];
  completedCount: number;
  total: number;
  /** completedCount / total, between 0 and 1. */
  fraction: number;
  current: ProgressStepState | null;
  /** False if a later step is complete while an earlier one is not. This should never happen. */
  consistent: boolean;
}

export function computeProgress(service: WorkflowType, events: readonly WorkflowEvent[]): ApplicationProgress {
  const defs = PROGRESS_STEPS[service];
  let currentAssigned = false;
  const steps: ProgressStepState[] = defs.map((def) => {
    const event = events.find((e) => e.kind === def.kind);
    if (event) return { ...def, state: 'complete', at: event.at, actor: event.actor };
    if (!currentAssigned) {
      currentAssigned = true;
      return { ...def, state: 'current' };
    }
    return { ...def, state: 'upcoming' };
  });

  const completedCount = steps.filter((s) => s.state === 'complete').length;
  let seenIncomplete = false;
  let consistent = true;
  for (const step of steps) {
    if (step.state !== 'complete') seenIncomplete = true;
    else if (seenIncomplete) consistent = false;
  }

  return {
    steps,
    completedCount,
    total: steps.length,
    fraction: steps.length === 0 ? 0 : completedCount / steps.length,
    current: steps.find((s) => s.state === 'current') ?? null,
    consistent,
  };
}

/** The generic status label used for badges and the Activity filters, derived from events. */
export function statusFromEvents(events: readonly WorkflowEvent[]): ApplicationStatus {
  const has = (kind: EventKind) => events.some((e) => e.kind === kind);
  if (has('completed')) return 'completed';
  const pending = pendingRequirementsOf(events);
  if (pending.some((r) => r.kind === 'document')) return 'documents_pending';
  if (pending.length > 0) return 'information_required';
  if (has('under_review')) return 'under_review';
  if (has('submitted')) return 'submitted';
  if (has('preparation_started')) return 'preparation';
  return 'request_understood';
}

// -------------------------------------------------------------- validation

export type EventCandidate = Pick<WorkflowEvent, 'kind' | 'requirement' | 'requirementId'>;
export type RecordCheck = { ok: true } | { ok: false; reason: string };

const fail = (reason: string): RecordCheck => ({ ok: false, reason });

/**
 * Decides whether an event may be appended. Milestones must follow the order
 * of the service's steps, may only happen once, and cannot happen while a
 * requirement is outstanding. Nothing can be recorded after completion.
 */
export function canRecordEvent(
  service: WorkflowType,
  events: readonly WorkflowEvent[],
  candidate: EventCandidate,
): RecordCheck {
  const has = (kind: EventKind) => events.some((e) => e.kind === kind);
  if (has('completed')) return fail('This application is already completed.');

  if (candidate.kind === 'requirement_requested') {
    const requirement = candidate.requirement;
    if (!requirement) return fail('A requirement is needed.');
    if (!has('request_understood')) return fail('The request has not been understood yet.');
    if (requirementsOf(events).some((r) => r.id === requirement.id)) return fail('That requirement was already requested.');
    return { ok: true };
  }

  if (candidate.kind === 'requirement_provided') {
    if (!candidate.requirementId) return fail('A requirement id is needed.');
    if (!pendingRequirementsOf(events).some((r) => r.id === candidate.requirementId)) {
      return fail('That requirement is not outstanding.');
    }
    return { ok: true };
  }

  const steps = PROGRESS_STEPS[service];
  const index = steps.findIndex((s) => s.kind === candidate.kind);
  if (index === -1) return fail(`"${candidate.kind}" is not a step of ${service}.`);
  if (has(candidate.kind)) return fail('That step was already recorded.');
  const previous = steps[index - 1];
  if (previous && !has(previous.kind)) return fail(`"${previous.label}" must happen first.`);

  const gateIndex = steps.findIndex((s) => s.kind === 'requirements_complete');
  if (index >= gateIndex && pendingRequirementsOf(events).length > 0) {
    return fail('Outstanding requirements must be provided first.');
  }
  return { ok: true };
}

/** Which step a simulation (or a future back-office integration) may record next, if any. */
export function nextExternalStep(service: WorkflowType, events: readonly WorkflowEvent[]): ProgressStepDef | null {
  for (const step of PROGRESS_STEPS[service]) {
    if (step.kind !== 'under_review' && step.kind !== 'completed') continue;
    if (events.some((e) => e.kind === step.kind)) continue;
    return canRecordEvent(service, events, { kind: step.kind }).ok ? step : null;
  }
  return null;
}
