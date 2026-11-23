import { describe, expect, it } from 'vitest';
import {
  canRecordEvent,
  computeProgress,
  nextExternalStep,
  pendingRequirementsOf,
  PROGRESS_STEPS,
  requirementsOf,
  statusFromEvents,
} from './progress.js';
import type { EventKind, WorkflowEvent } from './progress.js';

let n = 0;
function ev(kind: EventKind, extra: Partial<WorkflowEvent> = {}): WorkflowEvent {
  n += 1;
  return { id: `e${n}`, at: `2026-11-21T10:00:${String(n % 60).padStart(2, '0')}Z`, kind, actor: 'system', title: kind, ...extra };
}
const docReq = { id: 'req-doc', label: 'Passport copy', kind: 'document' as const, docTypeId: 'passport' };
const infoReq = { id: 'req-info', label: 'Annual turnover (AED)', kind: 'information' as const };

describe('service-specific steps', () => {
  it('gives each service its own steps and labels', () => {
    const company = PROGRESS_STEPS.company_registration.map((s) => s.kind);
    const finance = PROGRESS_STEPS.working_capital_finance.map((s) => s.kind);
    expect(company).toContain('submitted');
    expect(company).not.toContain('preparation_started');
    expect(finance).toContain('preparation_started');
    expect(finance).not.toContain('submitted');
    expect(PROGRESS_STEPS.company_registration[2]?.label).toBe('Documents ready');
    expect(PROGRESS_STEPS.working_capital_finance[2]?.label).toBe('Documents and information received');
  });
});

describe('computeProgress', () => {
  it('marks nothing complete when no events exist and makes the first step current', () => {
    const p = computeProgress('company_registration', []);
    expect(p.completedCount).toBe(0);
    expect(p.fraction).toBe(0);
    expect(p.steps[0]?.state).toBe('current');
    expect(p.steps.slice(1).every((s) => s.state === 'upcoming')).toBe(true);
  });

  it('completes a step only when its own event exists', () => {
    const events = [ev('request_understood'), ev('details_confirmed')];
    const p = computeProgress('company_registration', events);
    expect(p.steps.map((s) => s.state)).toEqual(['complete', 'complete', 'current', 'upcoming', 'upcoming', 'upcoming']);
    expect(p.completedCount).toBe(2);
    expect(p.current?.kind).toBe('requirements_complete');
  });

  it('never counts requirement events as a completed step', () => {
    const events = [ev('request_understood'), ev('details_confirmed'), ev('requirement_requested', { requirement: docReq })];
    const p = computeProgress('company_registration', events);
    expect(p.steps.find((s) => s.kind === 'requirements_complete')?.state).toBe('current');
    expect(p.completedCount).toBe(2);
  });

  it('records when and by whom a completed step happened', () => {
    const e = ev('request_understood', { actor: 'user' });
    const step = computeProgress('company_registration', [e]).steps[0];
    expect(step).toMatchObject({ state: 'complete', at: e.at, actor: 'user' });
  });

  it('reports 100% only when every step has an event', () => {
    const events = PROGRESS_STEPS.company_registration.map((s) => ev(s.kind));
    const p = computeProgress('company_registration', events);
    expect(p.fraction).toBe(1);
    expect(p.current).toBeNull();
  });

  it('flags an inconsistent log instead of hiding it', () => {
    const p = computeProgress('company_registration', [ev('request_understood'), ev('under_review')]);
    expect(p.consistent).toBe(false);
  });

  it('counts exactly as many complete steps as milestone events, for every prefix of a valid history', () => {
    const history = PROGRESS_STEPS.working_capital_finance.map((s) => ev(s.kind));
    history.forEach((_, i) => {
      const p = computeProgress('working_capital_finance', history.slice(0, i + 1));
      expect(p.completedCount).toBe(i + 1);
      expect(p.consistent).toBe(true);
    });
  });
});

describe('requirements', () => {
  it('derives outstanding requirements from the event order', () => {
    const events = [ev('requirement_requested', { requirement: docReq }), ev('requirement_requested', { requirement: infoReq })];
    expect(pendingRequirementsOf(events).map((r) => r.id)).toEqual(['req-doc', 'req-info']);

    const after = [...events, ev('requirement_provided', { requirementId: 'req-doc' })];
    const list = requirementsOf(after);
    expect(list.find((r) => r.id === 'req-doc')).toMatchObject({ done: true });
    expect(pendingRequirementsOf(after).map((r) => r.id)).toEqual(['req-info']);
  });

  it('keeps the answer given for an information requirement', () => {
    const events = [
      ev('requirement_requested', { requirement: infoReq }),
      ev('requirement_provided', { requirementId: 'req-info', value: '2,400,000' }),
    ];
    expect(requirementsOf(events)[0]).toMatchObject({ done: true, value: '2,400,000' });
  });

  it('ignores a provided event that matches nothing', () => {
    expect(requirementsOf([ev('requirement_provided', { requirementId: 'ghost' })])).toEqual([]);
  });
});

describe('statusFromEvents', () => {
  it('follows the events, with outstanding documents and information taking priority', () => {
    expect(statusFromEvents([])).toBe('request_understood');
    expect(statusFromEvents([ev('request_understood'), ev('preparation_started')])).toBe('preparation');
    expect(statusFromEvents([ev('submitted')])).toBe('submitted');
    expect(statusFromEvents([ev('submitted'), ev('under_review')])).toBe('under_review');
    expect(statusFromEvents([ev('completed')])).toBe('completed');

    const waitingDoc = [ev('submitted'), ev('requirement_requested', { requirement: docReq })];
    expect(statusFromEvents(waitingDoc)).toBe('documents_pending');
    const waitingInfo = [ev('submitted'), ev('requirement_requested', { requirement: infoReq })];
    expect(statusFromEvents(waitingInfo)).toBe('information_required');
    expect(statusFromEvents([ev('requirement_requested', { requirement: docReq }), ev('requirement_requested', { requirement: infoReq })])).toBe(
      'documents_pending',
    );
  });
});

describe('canRecordEvent', () => {
  const base = [ev('request_understood')];

  it('enforces the order of steps', () => {
    expect(canRecordEvent('company_registration', [], { kind: 'details_confirmed' }).ok).toBe(false);
    expect(canRecordEvent('company_registration', base, { kind: 'details_confirmed' }).ok).toBe(true);
    expect(canRecordEvent('company_registration', base, { kind: 'submitted' })).toMatchObject({ ok: false });
    expect(canRecordEvent('company_registration', base, { kind: 'completed' })).toMatchObject({ ok: false });
  });

  it('refuses to record a step twice', () => {
    expect(canRecordEvent('company_registration', base, { kind: 'request_understood' })).toMatchObject({
      ok: false,
      reason: 'That step was already recorded.',
    });
  });

  it('refuses steps that belong to the other service', () => {
    const events = [ev('request_understood'), ev('details_confirmed'), ev('requirements_complete')];
    expect(canRecordEvent('company_registration', events, { kind: 'preparation_started' }).ok).toBe(false);
    expect(canRecordEvent('working_capital_finance', events, { kind: 'submitted' }).ok).toBe(false);
    expect(canRecordEvent('working_capital_finance', events, { kind: 'preparation_started' }).ok).toBe(true);
  });

  it('blocks the documents gate and later steps while something is outstanding', () => {
    const events = [ev('request_understood'), ev('details_confirmed'), ev('requirement_requested', { requirement: docReq })];
    expect(canRecordEvent('company_registration', events, { kind: 'requirements_complete' })).toMatchObject({ ok: false });
    const provided = [...events, ev('requirement_provided', { requirementId: 'req-doc' })];
    expect(canRecordEvent('company_registration', provided, { kind: 'requirements_complete' }).ok).toBe(true);
  });

  it('only accepts a requirement once and only while it is outstanding', () => {
    const asked = [...base, ev('requirement_requested', { requirement: docReq })];
    expect(canRecordEvent('company_registration', asked, { kind: 'requirement_requested', requirement: docReq }).ok).toBe(false);
    expect(canRecordEvent('company_registration', asked, { kind: 'requirement_provided', requirementId: 'req-doc' }).ok).toBe(true);
    expect(canRecordEvent('company_registration', asked, { kind: 'requirement_provided', requirementId: 'nope' }).ok).toBe(false);
    const done = [...asked, ev('requirement_provided', { requirementId: 'req-doc' })];
    expect(canRecordEvent('company_registration', done, { kind: 'requirement_provided', requirementId: 'req-doc' }).ok).toBe(false);
  });

  it('requires a requirement to be described', () => {
    expect(canRecordEvent('company_registration', base, { kind: 'requirement_requested' }).ok).toBe(false);
    expect(canRecordEvent('company_registration', [], { kind: 'requirement_requested', requirement: docReq }).ok).toBe(false);
  });

  it('closes the application after completion', () => {
    const closed = PROGRESS_STEPS.company_registration.map((s) => ev(s.kind));
    expect(canRecordEvent('company_registration', closed, { kind: 'requirement_requested', requirement: docReq })).toMatchObject({
      ok: false,
    });
  });
});

describe('nextExternalStep', () => {
  it('offers under review, then completed, and only once the application is ready for them', () => {
    const notReady = [ev('request_understood'), ev('details_confirmed')];
    expect(nextExternalStep('company_registration', notReady)).toBeNull();

    const submitted = [...notReady, ev('requirements_complete'), ev('submitted')];
    expect(nextExternalStep('company_registration', submitted)?.kind).toBe('under_review');
    expect(nextExternalStep('company_registration', [...submitted, ev('under_review')])?.kind).toBe('completed');
    expect(nextExternalStep('company_registration', [...submitted, ev('under_review'), ev('completed')])).toBeNull();
  });

  it('offers nothing while a requirement is outstanding', () => {
    const waiting = [
      ev('request_understood'),
      ev('details_confirmed'),
      ev('requirements_complete'),
      ev('submitted'),
      ev('requirement_requested', { requirement: docReq }),
    ];
    expect(nextExternalStep('company_registration', waiting)).toBeNull();
  });
});
