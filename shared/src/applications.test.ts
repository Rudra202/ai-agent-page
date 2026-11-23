import { describe, expect, it } from 'vitest';
import {
  buildCompanyApplication,
  buildFinanceApplication,
  detailRowsOf,
  generateReference,
  nextAction,
  pendingOf,
  progressOf,
  provideRequirement,
  recordEvent,
  settleApplication,
  simulateNext,
  statusOf,
  submittedAtOf,
  updatedAtOf,
  WorkflowError,
} from './applications.js';
import type { Application, BuildContext } from './applications.js';

const NOW = new Date('2026-11-21T10:00:00Z');
const SAMPLE_VAULT = ['passport', 'emirates_id', 'proof_of_address', 'trade_licence', 'tenancy_contract'].map((typeId) => ({ typeId }));

let counter = 0;
function ctx(overrides: Partial<BuildContext> = {}, now = NOW): BuildContext {
  return {
    now,
    newId: () => `id-${(counter += 1)}`,
    documents: SAMPLE_VAULT,
    existingIds: [],
    random: () => 0.123456,
    ...overrides,
  };
}
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const freeZone = {
  registrationType: 'free_zone' as const,
  jurisdictionId: 'shams',
  packageId: 'shams-starter',
  companyName: 'Vinith Media',
  activity: 'Media & Marketing',
  category: 'Media & Advertising',
  description: '',
  shareholders: 1,
};
const offshore = { ...freeZone, registrationType: 'offshore' as const, jurisdictionId: 'rak-offshore', packageId: 'rak-offshore-starter' };
const finance = { amount: 350000, purpose: 'Inventory' };

const kinds = (app: Application) => app.events.map((e) => e.kind);
const stepStates = (app: Application) => progressOf(app).steps.map((s) => `${s.kind}:${s.state}`);

describe('company registration with every document on record', () => {
  const app = buildCompanyApplication(freeZone, ctx());

  it('records exactly the events that happened', () => {
    expect(kinds(app)).toEqual(['request_understood', 'details_confirmed', 'requirements_complete', 'submitted']);
    expect(app.events.find((e) => e.kind === 'details_confirmed')?.actor).toBe('user');
    expect(app.id).toBe('REG-2026-123456');
  });

  it('shows four of six steps done and nothing the authority has not done', () => {
    expect(stepStates(app)).toEqual([
      'request_understood:complete',
      'details_confirmed:complete',
      'requirements_complete:complete',
      'submitted:complete',
      'under_review:current',
      'completed:upcoming',
    ]);
    expect(progressOf(app).fraction).toBeCloseTo(4 / 6);
    expect(statusOf(app)).toBe('submitted');
    expect(submittedAtOf(app)).toBe(NOW.toISOString());
  });

  it('can only be advanced beyond submission by the labelled simulation, in order', () => {
    const review = simulateNext(app, ctx({}, at(5)))!;
    expect(review.step.kind).toBe('under_review');
    expect(review.app.events.at(-1)).toMatchObject({ kind: 'under_review', actor: 'simulation', title: 'Under review (simulated)' });
    expect(statusOf(review.app)).toBe('under_review');

    const done = simulateNext(review.app, ctx({}, at(10)))!;
    expect(done.step.kind).toBe('completed');
    expect(statusOf(done.app)).toBe('completed');
    expect(progressOf(done.app).fraction).toBe(1);
    expect(simulateNext(done.app, ctx())).toBeNull();
  });
});

describe('company registration with a missing document', () => {
  const created = buildCompanyApplication(offshore, ctx());

  it('does not mark documents or submission as done while a document is missing', () => {
    expect(kinds(created)).toEqual(['request_understood', 'details_confirmed', 'requirement_requested']);
    expect(stepStates(created)).toEqual([
      'request_understood:complete',
      'details_confirmed:complete',
      'requirements_complete:current',
      'submitted:upcoming',
      'under_review:upcoming',
      'completed:upcoming',
    ]);
    expect(statusOf(created)).toBe('documents_pending');
    expect(submittedAtOf(created)).toBeUndefined();
    expect(pendingOf(created).map((r) => r.docTypeId)).toEqual(['source_of_funds']);
    expect(nextAction(created)).toEqual({ text: 'Upload proof of source of funds', needsAction: true });
  });

  it('cannot be simulated forward while the document is missing', () => {
    expect(simulateNext(created, ctx())).toBeNull();
  });

  it('completes documents and submits only after the document is provided', () => {
    const after = provideRequirement(created, 'req-source_of_funds', ctx({}, at(3)), { actor: 'user', detail: 'funds.pdf' });
    expect(kinds(after)).toEqual([
      'request_understood',
      'details_confirmed',
      'requirement_requested',
      'requirement_provided',
      'requirements_complete',
      'submitted',
    ]);
    expect(after.events.find((e) => e.kind === 'requirement_provided')).toMatchObject({
      actor: 'user',
      detail: 'funds.pdf',
      title: 'Document recorded: Proof of source of funds',
    });
    expect(statusOf(after)).toBe('submitted');
    expect(submittedAtOf(after)).toBe(at(3).toISOString());
    expect(updatedAtOf(after)).toBe(at(3).toISOString());
    expect(progressOf(after).completedCount).toBe(4);
  });

  it('then continues to completion with the simulation', () => {
    let app = provideRequirement(created, 'req-source_of_funds', ctx({}, at(3)), { actor: 'user' });
    app = simulateNext(app, ctx({}, at(4)))!.app;
    app = simulateNext(app, ctx({}, at(5)))!.app;
    expect(statusOf(app)).toBe('completed');
    expect(progressOf(app).consistent).toBe(true);
    expect(app.events.filter((e) => e.actor === 'simulation').map((e) => e.kind)).toEqual(['under_review', 'completed']);
  });

  it('refuses to provide something that is not outstanding or to provide it twice', () => {
    expect(() => provideRequirement(created, 'nope', ctx(), { actor: 'user' })).toThrow(WorkflowError);
    const after = provideRequirement(created, 'req-source_of_funds', ctx(), { actor: 'user' });
    expect(() => provideRequirement(after, 'req-source_of_funds', ctx(), { actor: 'user' })).toThrow(WorkflowError);
  });
});

describe('working capital finance', () => {
  const created = buildFinanceApplication(finance, 'ABC Trading LLC', ctx());

  it('has finance steps and records a request, not a submission', () => {
    expect(created.id).toBe('FIN-2026-123456');
    expect(created.subtitle).toBe('AED 350,000');
    expect(kinds(created)).toEqual(['request_understood', 'details_confirmed', 'requirement_requested', 'requirement_requested']);
    expect(progressOf(created).steps.map((s) => s.label)).toEqual([
      'Request understood',
      'Request confirmed',
      'Documents and information received',
      'Preparation',
      'Under review',
      'Completed',
    ]);
    expect(progressOf(created).completedCount).toBe(2);
    expect(submittedAtOf(created)).toBeUndefined();
  });

  it('asks for the bank statement first, then the information, and only then prepares', () => {
    expect(statusOf(created)).toBe('documents_pending');
    const afterDoc = provideRequirement(created, 'req-bank_statement_6m', ctx({}, at(1)), { actor: 'user', detail: 'statement.pdf' });
    expect(statusOf(afterDoc)).toBe('information_required');
    expect(kinds(afterDoc)).not.toContain('requirements_complete');
    expect(kinds(afterDoc)).not.toContain('preparation_started');
    expect(progressOf(afterDoc).completedCount).toBe(2);

    const afterInfo = provideRequirement(afterDoc, 'req-info-0', ctx({}, at(2)), { actor: 'user', value: 'AED 2,400,000' });
    expect(kinds(afterInfo).slice(-3)).toEqual(['requirement_provided', 'requirements_complete', 'preparation_started']);
    expect(statusOf(afterInfo)).toBe('preparation');
    expect(progressOf(afterInfo).completedCount).toBe(4);
    expect(detailRowsOf(afterInfo).at(-1)).toEqual({ label: 'Annual turnover (AED)', value: 'AED 2,400,000' });
  });

  it('reaches completion only through simulated review steps and never records "submitted"', () => {
    let app = provideRequirement(created, 'req-bank_statement_6m', ctx({}, at(1)), { actor: 'user' });
    app = provideRequirement(app, 'req-info-0', ctx({}, at(2)), { actor: 'user', value: '1' });
    app = simulateNext(app, ctx({}, at(3)))!.app;
    app = simulateNext(app, ctx({}, at(4)))!.app;
    expect(statusOf(app)).toBe('completed');
    expect(kinds(app)).not.toContain('submitted');
    expect(app.events.at(-1)?.title).toBe('Completed (simulated)');
  });

  it('skips the document request when the statement is already on record', () => {
    const withStatement = buildFinanceApplication(finance, 'ABC', ctx({ documents: [...SAMPLE_VAULT, { typeId: 'bank_statement_6m' }] }));
    expect(pendingOf(withStatement).map((r) => r.kind)).toEqual(['information']);
    expect(statusOf(withStatement)).toBe('information_required');
  });
});

describe('recordEvent', () => {
  const fresh: Application = { id: 'REG-2026-000001', service: 'company_registration', title: 't', subtitle: 's', details: [], events: [] };

  it('rejects an event that is out of order, without changing the application', () => {
    expect(() => recordEvent(fresh, { kind: 'completed', actor: 'system', title: 'x' }, ctx())).toThrow('must happen first');
    expect(fresh.events).toEqual([]);
  });

  it('rejects anything after completion', () => {
    let app = buildCompanyApplication(freeZone, ctx());
    app = simulateNext(app, ctx())!.app;
    app = simulateNext(app, ctx())!.app;
    expect(() => recordEvent(app, { kind: 'requirement_requested', actor: 'system', title: 'x', requirement: { id: 'r', label: 'l', kind: 'document' } }, ctx())).toThrow(
      'already completed',
    );
  });
});

describe('invariants', () => {
  it('keeps progress consistent and tied to events for every state a journey passes through', () => {
    let app = buildFinanceApplication(finance, 'ABC', ctx());
    const states: Application[] = [app];
    app = provideRequirement(app, 'req-bank_statement_6m', ctx(), { actor: 'user' });
    states.push(app);
    app = provideRequirement(app, 'req-info-0', ctx(), { actor: 'user', value: 'x' });
    states.push(app);
    while (true) {
      const next = simulateNext(app, ctx());
      if (!next) break;
      app = next.app;
      states.push(app);
    }
    for (const state of states) {
      const progress = progressOf(state);
      expect(progress.consistent).toBe(true);
      for (const step of progress.steps) {
        const hasEvent = state.events.some((e) => e.kind === step.kind);
        expect(step.state === 'complete').toBe(hasEvent);
      }
    }
  });
});

describe('generateReference', () => {
  it('uses the prefix, year and six digits', () => {
    expect(generateReference('REG', [], NOW, () => 0.000123)).toBe('REG-2026-000123');
    expect(generateReference('FIN', [], NOW, () => 0.5)).toBe('FIN-2026-500000');
  });

  it('never returns an id that already exists, and gives up instead of looping forever', () => {
    const values = [0.1, 0.1, 0.2];
    let i = 0;
    expect(generateReference('REG', ['REG-2026-100000'], NOW, () => values[i++] ?? 0.9)).toBe('REG-2026-200000');
    expect(() => generateReference('REG', ['REG-2026-500000'], NOW, () => 0.5)).toThrow();
  });
});

describe('nextAction', () => {
  it('describes the status when nothing is pending', () => {
    const app = buildCompanyApplication(freeZone, ctx());
    expect(nextAction(app)).toEqual({ text: 'Submitted. Nothing needed from you right now', needsAction: false });
  });
});

describe('settleApplication', () => {
  it('finishes an interrupted cascade and does nothing when there is nothing left to do', () => {
    const created = buildCompanyApplication(offshore, ctx());
    // Simulate a crash after the requirement was provided but before the follow-on steps were saved.
    const interrupted = recordEvent(
      created,
      { kind: 'requirement_provided', actor: 'user', title: 'Document recorded', requirementId: 'req-source_of_funds' },
      ctx({}, at(2)),
    );
    expect(kinds(interrupted)).not.toContain('submitted');
    expect(statusOf(interrupted)).toBe('request_understood');

    const healed = settleApplication(interrupted, ctx({}, at(3)));
    expect(kinds(healed).slice(-2)).toEqual(['requirements_complete', 'submitted']);
    expect(statusOf(healed)).toBe('submitted');
    expect(settleApplication(healed, ctx({}, at(4)))).toBe(healed);
  });

  it('does not submit anything while a requirement is outstanding', () => {
    const created = buildCompanyApplication(offshore, ctx());
    expect(settleApplication(created, ctx())).toBe(created);
  });
});
