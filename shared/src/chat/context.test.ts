import { describe, expect, it } from 'vitest';
import { buildInterpretContext, expectedField, MAX_HISTORY_CHARS, MAX_HISTORY_ITEMS } from './context.js';
import { companyJourneyUntilReview, Session, USER } from './engine.test-support.js';
import type { HistoryItem } from './context.js';

describe('what the model is told', () => {
  it('contains no personal details of the user', () => {
    const s = new Session();
    const ctx = buildInterpretContext(s.workflow, s.ctx(), [{ role: 'user', text: 'hello' }]);
    const json = JSON.stringify(ctx);
    expect(json).not.toContain(USER.name);
    expect(json).not.toContain(USER.firstName);
    expect(json).not.toContain(USER.company);
    expect(json).not.toMatch(/@|token|password|secret|api[_-]?key/i);
  });

  it('lists the choices the model may pick from, with their ids', () => {
    const ctx = buildInterpretContext(new Session().workflow, new Session().ctx());
    expect(ctx.allowed.registrationTypes.map((t) => t.id)).toEqual(['mainland', 'free_zone', 'offshore']);
    expect(ctx.allowed.jurisdictions.map((j) => j.id)).toEqual(expect.arrayContaining(['shams', 'ifza', 'dmcc', 'rak-offshore']));
    expect(ctx.allowed.jurisdictions.find((j) => j.id === 'shams')).toMatchObject({ registrationType: 'free_zone', aliases: expect.arrayContaining(['shams']) });
    expect(ctx.allowed.packages.map((p) => p.id)).toContain('shams-starter');
    expect(ctx.allowed.activities).toContain('Media & Marketing');
  });

  it('keeps only the business facts collected so far', () => {
    const s = new Session();
    s.send('Start a company');
    s.send({ type: 'select', step: 'registration_type', cardId: 'free_zone' });
    s.send({ type: 'select', step: 'jurisdiction', cardId: 'shams' });
    s.send('Media & Marketing');
    expect(buildInterpretContext(s.workflow, s.ctx()).collected).toEqual({
      registrationType: 'free_zone',
      jurisdictionId: 'shams',
      activity: 'Media & Marketing',
    });
    s.send('Vinith Media');
    s.send('2');
    expect(buildInterpretContext(s.workflow, s.ctx()).collected).toMatchObject({ companyName: 'Vinith Media', shareholders: 2 });
  });

  it('holds finance facts too', () => {
    const s = new Session();
    s.send('Working Capital Finance');
    s.send('yes');
    s.send('350000');
    s.send('Inventory');
    expect(buildInterpretContext(s.workflow, s.ctx()).collected).toEqual({ financeAmount: 350000, financePurpose: 'Inventory' });
  });

  it('carries over what has been said, trimmed and bounded', () => {
    const long = 'word '.repeat(200);
    const history: HistoryItem[] = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: i === 13 ? long : `message ${i}` }));
    history.splice(2, 0, { role: 'user', text: '   ' });
    const { recent } = buildInterpretContext(new Session().workflow, new Session().ctx(), history);
    expect(recent).toHaveLength(MAX_HISTORY_ITEMS);
    expect(recent.at(-1)!.text.length).toBeLessThanOrEqual(MAX_HISTORY_CHARS);
    expect(recent.some((r) => r.text.trim() === '')).toBe(false);
    expect(recent[0]!.text).toBe('message 4');
  });
});

describe('what the workflow is waiting for', () => {
  const at = (setup: (s: Session) => void) => {
    const s = new Session();
    setup(s);
    return { s, field: expectedField(s.workflow, s.ctx()) };
  };

  it('names the field for each company step', () => {
    expect(at(() => undefined).field).toBeNull();
    expect(at((s) => s.send('Start a company')).field).toBe('registrationType');
    expect(at((s) => { s.send('Start a company'); s.send('Free Zone'); }).field).toBe('jurisdictionId');
    expect(at((s) => { s.send('Start a company'); s.send('Free Zone'); s.send('Shams'); }).field).toBe('activity');
    expect(at((s) => { s.send('Start a company'); s.send('Free Zone'); s.send('Shams'); s.send('Consulting'); }).field).toBe('companyName');
    expect(at((s) => companyJourneyUntilReview(s)).field).toBe('confirmation');
  });

  it('names the field for each finance step', () => {
    expect(at((s) => s.send('Working Capital Finance')).field).toBe('affirmative');
    expect(at((s) => { s.send('Working Capital Finance'); s.send('yes'); }).field).toBe('financeAmount');
    expect(at((s) => { s.send('Working Capital Finance'); s.send('yes'); s.send('100000'); }).field).toBe('financePurpose');
  });

  it('puts the open question into the context and lists outstanding requirements for a clarification', () => {
    const s = new Session();
    s.send('Start a company');
    expect(buildInterpretContext(s.workflow, s.ctx()).expecting.question).toContain('Which type of company');

    const fin = s.applications.find((a) => a.id === 'FIN-2026-050123')!;
    s.workflow = { type: null, step: 'intent', company: {}, finance: {}, clarificationApplicationId: fin.id };
    expect(buildInterpretContext(s.workflow, s.ctx()).pendingRequirements).toEqual(['Latest 6-month bank statement']);
  });
});
