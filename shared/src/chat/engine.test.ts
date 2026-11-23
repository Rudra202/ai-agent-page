import { describe, expect, it } from 'vitest';
import { detailRowsOf, pendingOf, provideRequirement, requirementsOfApp, statusOf } from '../applications.js';
import { classify, parseAmount, startClarification, uploadAcknowledgement } from './engine.js';
import { companyJourneyUntilReview, NOW, Session } from './engine.test-support.js';
import { INITIAL_WORKFLOW } from './types.js';

describe('intent classification', () => {
  it('recognises the main journeys', () => {
    expect(classify('Start a company')).toBe('start_company');
    expect(classify('I want to register a new business')).toBe('start_company');
    expect(classify('Working Capital Finance')).toBe('working_capital');
    expect(classify('Check registration status')).toBe('status');
    expect(classify('Where can I upload it?')).toBe('upload_help');
    expect(classify('renew my ejari')).toBe('unsupported');
    expect(classify('gibberish xyz')).toBe('unknown');
    expect(classify('introduce yourself')).toBe('about');
    expect(classify('Who are you?')).toBe('about');
    expect(classify('what is Tajir')).toBe('about');
  });

  it('parses amounts', () => {
    expect(parseAmount('350000')).toBe(350000);
    expect(parseAmount('AED 350,000')).toBe(350000);
    expect(parseAmount('250k')).toBe(250000);
    expect(parseAmount('1.5m')).toBe(1_500_000);
    expect(parseAmount('lots')).toBeNull();
  });
});

describe('company registration journey', () => {
  it('walks every step in order and creates a submitted application', () => {
    const s = new Session();
    s.send('Start a company');
    expect(s.workflow).toMatchObject({ type: 'company_registration', step: 'registration_type' });

    s.send({ type: 'select', step: 'registration_type', cardId: 'free_zone' });
    expect(s.workflow.step).toBe('jurisdiction');
    expect(s.last.quickReplies).toContain('Show me popular free zones');

    s.send('Show me popular free zones');
    const cards = s.last.replies.find((r) => r.kind === 'options');
    expect(cards && cards.kind === 'options' && cards.cards.map((c) => c.id)).toEqual(['dmcc', 'ifza', 'shams']);

    s.send({ type: 'select', step: 'jurisdiction', cardId: 'shams' });
    expect(s.workflow.step).toBe('business_details');
    expect(s.text).toContain('Shams');

    s.send('Media & Marketing');
    expect(s.workflow.company.category).toBe('Media & Advertising');
    s.send('Vinith Media');
    s.send('1');
    s.send('Skip');
    expect(s.workflow.step).toBe('package_selection');

    s.send({ type: 'select', step: 'package_selection', cardId: 'shams-starter' });
    expect(s.workflow.step).toBe('review');
    const summary = s.last.replies.find((r) => r.kind === 'summary');
    expect(summary && summary.kind === 'summary' && summary.problems).toEqual([]);

    const before = s.applications.length;
    s.send({ type: 'confirm', step: 'review' });
    expect(s.workflow.step).toBe('submitted');
    expect(s.applications).toHaveLength(before + 1);

    const created = s.applications[0];
    expect(created).toMatchObject({ service: 'company_registration', subtitle: 'Vinith Media' });
    expect(created && statusOf(created)).toBe('submitted');
    expect(created?.id).toMatch(/^REG-2026-\d{6}$/);
    expect(s.created).toBe(created?.id);
    expect(s.text).toContain('Prototype');
  });

  it('accepts typed answers as well as card selections', () => {
    const s = new Session();
    s.send('start a company');
    s.send('free zone');
    s.send('shams');
    expect(s.workflow.company).toMatchObject({ registrationType: 'free_zone', jurisdictionId: 'shams' });
  });

  it('re-asks on incomplete or invalid answers without moving on', () => {
    const s = new Session();
    s.send('Start a company');
    s.send('blue');
    expect(s.workflow.step).toBe('registration_type');

    s.send('Free Zone');
    s.send('Shams');
    s.send('Consulting');
    s.send('A');
    expect(s.workflow.company.companyName).toBeUndefined();
    expect(s.text).toContain('at least 2');

    s.send('Acme Consulting');
    s.send('zero');
    expect(s.workflow.company.shareholders).toBeUndefined();
    s.send('banana');
    expect(s.text).toContain('whole number');
    s.send('25');
    expect(s.text).toContain('Up to 20');
    s.send('2');
    expect(s.workflow.company.shareholders).toBe(2);
  });

  it('does not read a company name as a command', () => {
    const s = new Session();
    s.send('Start a company');
    s.send('Free Zone');
    s.send('Shams');
    s.send('General Trading');
    s.send('Finance Hub');
    expect(s.workflow.type).toBe('company_registration');
    expect(s.workflow.company.companyName).toBe('Finance Hub');
  });

  it('ignores a card from an earlier step and a confirmation before review', () => {
    const s = new Session();
    s.send('Start a company');
    s.send({ type: 'select', step: 'registration_type', cardId: 'free_zone' });
    const afterType = s.workflow;

    s.send({ type: 'select', step: 'registration_type', cardId: 'offshore' });
    expect(s.workflow).toEqual(afterType);
    expect(s.text).toContain('no longer available');

    const apps = s.applications.length;
    s.send({ type: 'confirm', step: 'review' });
    expect(s.workflow).toEqual(afterType);
    expect(s.applications).toHaveLength(apps);
  });

  it('rejects a jurisdiction that belongs to another registration type', () => {
    const s = new Session();
    s.send('Start a company');
    s.send({ type: 'select', step: 'registration_type', cardId: 'free_zone' });
    s.send({ type: 'select', step: 'jurisdiction', cardId: 'dubai-mainland' });
    expect(s.workflow.step).toBe('jurisdiction');
    expect(s.workflow.company.jurisdictionId).toBeUndefined();
  });

  it('rejects a package from a different jurisdiction', () => {
    const s = new Session();
    s.send('Start a company');
    s.send('Free Zone');
    s.send('Shams');
    s.send('Consulting');
    s.send('Acme');
    s.send('1');
    s.send('Skip');
    s.send({ type: 'select', step: 'package_selection', cardId: 'dmcc-starter' });
    expect(s.workflow.step).toBe('package_selection');
    expect(s.workflow.company.packageId).toBeUndefined();
  });

  it('confirms by typing as well as by button', () => {
    const s = new Session();
    companyJourneyUntilReview(s);
    s.send('yes, I confirm and approve - please submit');
    expect(s.workflow.step).toBe('submitted');
  });

  it('marks the application as waiting for documents when the vault lacks one', () => {
    const s = new Session();
    companyJourneyUntilReview(s, 'Offshore', 'rak-offshore');
    s.send({ type: 'confirm', step: 'review' });
    const created = s.applications[0];
    expect(created && statusOf(created)).toBe('documents_pending');
    expect(created && pendingOf(created).map((r) => r.docTypeId)).toEqual(['source_of_funds']);
    expect(s.last.replies.some((r) => r.kind === 'upload')).toBe(true);
  });

  it('can start over after submission and does not reuse the old draft', () => {
    const s = new Session();
    companyJourneyUntilReview(s);
    s.send({ type: 'confirm', step: 'review' });
    s.send('Start a company');
    expect(s.workflow).toMatchObject({ type: 'company_registration', step: 'registration_type', company: {} });
  });
});

describe('working capital finance workflow', () => {
  it('records a request and flags the missing bank statement and turnover', () => {
    const s = new Session();
    s.send('Working Capital Finance');
    expect(s.workflow).toMatchObject({ type: 'working_capital_finance', step: 'business_profile' });
    expect(s.text).toContain('does not offer, price or approve');

    s.send('Yes, use ABC Trading LLC');
    expect(s.workflow.step).toBe('financing_need');
    s.send('abc');
    expect(s.workflow.finance.amount).toBeUndefined();
    s.send('AED 350,000');
    expect(s.workflow.finance.amount).toBe(350000);
    s.send('Inventory');
    expect(s.workflow.step).toBe('documents');
    expect(s.text).toContain('6-month bank statement');
    s.send('Continue');
    expect(s.workflow.step).toBe('review');

    s.send({ type: 'confirm', step: 'review' });
    const created = s.applications[0];
    expect(created).toMatchObject({ service: 'working_capital_finance' });
    expect(created && statusOf(created)).toBe('documents_pending');
    expect(created?.id).toMatch(/^FIN-2026-\d{6}$/);
    expect(created && requirementsOfApp(created).map((r) => r.kind)).toEqual(['document', 'information']);
    expect(s.text).toContain('does not offer, price or approve');
  });

  it('rejects a zero amount', () => {
    const s = new Session();
    s.send('Working Capital Finance');
    s.send('yes');
    s.send('0');
    expect(s.workflow.finance.amount).toBeUndefined();
    expect(s.text).toContain('above zero');
  });
});

describe('clarifications', () => {
  it('asks for the missing document and shows where to upload it', () => {
    const s = new Session();
    const app = s.applications.find((a) => a.id === 'FIN-2026-050123');
    expect(app).toBeDefined();
    const started = startClarification(app!);
    expect(started.replies[0]).toMatchObject({ kind: 'text' });
    expect((started.replies[0] as { text: string }).text).toContain('latest 6-month bank statement');
    s.workflow = started.workflow;

    s.send('Where can I upload it?');
    expect(s.text).toContain('upload option below');
    expect(s.last.replies.some((r) => r.kind === 'upload')).toBe(true);
  });

  it('saves a typed answer for an information request and keeps the application waiting on the document', () => {
    const s = new Session();
    s.send('Working Capital Finance');
    s.send('yes');
    s.send('100000');
    s.send('Equipment');
    s.send('continue');
    s.send({ type: 'confirm', step: 'review' });
    const app = s.applications[0]!;

    const clarification = startClarification(app);
    s.workflow = clarification.workflow;
    s.send('AED 2,400,000');
    const updated = s.applications[0]!;
    expect(requirementsOfApp(updated).find((r) => r.kind === 'information')?.done).toBe(true);
    expect(detailRowsOf(updated).some((d) => d.value === 'AED 2,400,000')).toBe(true);
    // The bank statement is still outstanding, so the application keeps waiting for it.
    expect(statusOf(updated)).toBe('documents_pending');
    expect(s.text).toContain('saved');
  });

  it('acknowledges an upload and says when nothing is outstanding', () => {
    const s = new Session();
    const app = s.applications.find((a) => a.id === 'FIN-2026-050123')!;
    // Provide the one outstanding requirement through the real workflow, then acknowledge it.
    const done = provideRequirement(app, 'req-bank_statement_6m', { now: NOW, newId: () => 'ev-x' }, { actor: 'user' });
    const ack = uploadAcknowledgement(INITIAL_WORKFLOW, done, 'Latest 6-month bank statement');
    expect(JSON.stringify(ack.replies)).toContain('everything we need');
    expect(JSON.stringify(ack.replies)).toContain("stored on this prototype's server");
  });
});

describe('general conversation', () => {
  it('shows the latest applications for a status check', () => {
    const s = new Session();
    s.send('Check registration status');
    const list = s.last.replies.find((r) => r.kind === 'status_list');
    expect(list && list.kind === 'status_list' && list.applicationIds).toHaveLength(3);
  });

  it('is honest about journeys the prototype does not cover', () => {
    const s = new Session();
    s.send('Open a bank account');
    expect(s.text).toContain("isn't part of this prototype");
  });

  it('falls back safely on input it cannot understand', () => {
    const s = new Session();
    s.send('asdf qwer');
    expect(s.last.replies[0]).toMatchObject({ kind: 'text' });
    expect(s.last.quickReplies.length).toBeGreaterThan(0);
    expect(s.workflow).toEqual(INITIAL_WORKFLOW);
  });
});

describe('introducing itself', () => {
  it('answers "introduce yourself" and "who are you" with a fixed introduction, not "I did not get that"', () => {
    for (const question of ['introduce yourself', 'Who are you?', 'tell me about Tajir']) {
      const s = new Session();
      s.send(question);
      expect(s.text, question).toContain("I'm Tajir");
      expect(s.text, question).toContain('nothing is filed with any authority or lender');
      expect(s.text, question).not.toContain('did not quite get that');
      expect(s.last.quickReplies).toContain('Start a company');
    }
  });

  it('does not take over an answer typed into a free-text step', () => {
    const s = new Session();
    s.send('Start a company');
    s.send('Free Zone');
    s.send('Shams');
    s.send('Consulting');
    // A company can be called anything, including "Who Are You Trading".
    s.send('Who Are You Trading');
    expect(s.workflow.company.companyName).toBe('Who Are You Trading');
  });
});
