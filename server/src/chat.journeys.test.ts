import { RESTRICTED_REPLY } from '@tajir/shared';
import { describe, expect, it, vi } from 'vitest';
import { applicationsOf, Chat, toBusinessDetails } from './chat.test-support.js';
import { createTestApp, pdf, signUp, upload, uploadRequiredCompanyDocuments } from './test/helpers.js';

/**
 * The whole conversation flow over the HTTP API with no AI key: the deterministic mock.
 * The same flows run with a scripted model in chat.ai.test.ts.
 */

async function startCompanyChat() {
  const ctx = await createTestApp();
  const agent = await signUp(ctx.app, 'a@example.com');
  const chat = await Chat.start(agent);
  return { ...ctx, agent, chat };
}

describe('company setup with the built-in rules', () => {
  it('walks Free Zone setup from the first message to a recorded application', async () => {
    const { agent, chat, repos } = await startCompanyChat();
    await uploadRequiredCompanyDocuments(agent);
    const create = vi.spyOn(repos.applications, 'create');

    await chat.say('Start a company');
    expect(chat.workflow).toMatchObject({ type: 'company_registration', step: 'registration_type' });
    expect(chat.kinds).toContain('options');

    await chat.select('registration_type', 'free_zone', 'Free Zone');
    expect(chat.workflow.step).toBe('jurisdiction');
    await chat.select('jurisdiction', 'shams', 'Shams');
    expect(chat.workflow.step).toBe('business_details');

    await chat.say('Media & Marketing');
    await chat.say('Vinith Media');
    await chat.say('1');
    await chat.say('Skip');
    expect(chat.workflow).toMatchObject({ step: 'package_selection', company: { companyName: 'Vinith Media', activity: 'Media & Marketing', shareholders: 1 } });
    expect(chat.kinds).toContain('options');

    await chat.select('package_selection', 'shams-starter');
    expect(chat.workflow.step).toBe('review');
    expect(chat.kinds).toContain('summary');

    // Nothing is recorded until the user confirms.
    expect(create).not.toHaveBeenCalled();
    expect(await applicationsOf(agent)).toHaveLength(0);

    await chat.confirm();
    expect(create).toHaveBeenCalledTimes(1);
    expect(chat.workflow.step).toBe('submitted');
    const [app] = await applicationsOf(agent);
    expect(app).toMatchObject({ service: 'company_registration', status: 'submitted' });
    expect(app!.id).toMatch(/^REG-\d{4}-\d{6}$/);
    // The reply names the reference of the record that really was created.
    expect(chat.text).toContain(app!.id);
    expect(chat.mode).toBe('rules');
  });

  it('waits for documents when the vault is missing one, and says so honestly', async () => {
    const { agent, chat } = await startCompanyChat();
    await toBusinessDetails(chat);
    for (const answer of ['General Trading', 'Gulf Star', '2', 'Skip']) await chat.say(answer);
    await chat.select('package_selection', 'shams-starter');
    await chat.confirm();
    const [app] = await applicationsOf(agent);
    expect(app!.status).toBe('documents_pending');
    expect(app!.requirements.some((r) => r.kind === 'document' && !r.done)).toBe(true);
  });

  it('keeps the business information across messages and across a reload', async () => {
    const { chat } = await startCompanyChat();
    await toBusinessDetails(chat);
    await chat.say('Consulting');
    await chat.say('Desert Rose Consulting');
    const stored = await chat.stored();
    expect(stored.workflow).toMatchObject({ type: 'company_registration', step: 'business_details', company: { activity: 'Consulting', companyName: 'Desert Rose Consulting', jurisdictionId: 'shams' } });
    expect(stored.quickReplies).toEqual(chat.quickReplies);
    expect(stored.messages.length).toBeGreaterThan(8);
  });

  it('refuses choices that do not belong, without losing the draft', async () => {
    const { agent, chat, repos } = await startCompanyChat();
    const create = vi.spyOn(repos.applications, 'create');
    await chat.say('Start a company');
    await chat.select('registration_type', 'free_zone');

    // A jurisdiction of another registration type.
    await chat.select('jurisdiction', 'dubai-mainland');
    expect(chat.workflow).toMatchObject({ step: 'jurisdiction', company: { registrationType: 'free_zone' } });
    // A made-up id.
    await chat.select('jurisdiction', 'atlantis');
    expect(chat.workflow.step).toBe('jurisdiction');
    // A card from a later step, and a confirmation long before the review.
    await chat.select('package_selection', 'shams-starter');
    expect(chat.workflow.step).toBe('jurisdiction');
    await chat.confirm();
    expect(chat.workflow.step).toBe('jurisdiction');
    await chat.select('jurisdiction', 'shams');
    // A package of another jurisdiction.
    await chat.say('Consulting');
    await chat.say('Desert Rose');
    await chat.say('1');
    await chat.say('Skip');
    await chat.select('package_selection', 'dmcc-starter');
    expect(chat.workflow.step).toBe('package_selection');
    expect(create).not.toHaveBeenCalled();
    expect(await applicationsOf(agent)).toHaveLength(0);
  });

  it('does not take a question for an answer, and never answers it with an invented fact', async () => {
    const { chat } = await startCompanyChat();
    await toBusinessDetails(chat);
    await chat.say('How much does it cost?');
    expect(chat.workflow.company.activity).toBeUndefined();
    expect(chat.workflow.company.companyName).toBeUndefined();
    expect(chat.text).toContain(RESTRICTED_REPLY);

    await chat.say('What activities are available?');
    expect(chat.workflow.company.activity).toBeUndefined();
    expect(chat.workflow.step).toBe('business_details');
  });

  it('will not submit twice from one conversation', async () => {
    const { agent, chat } = await startCompanyChat();
    await toBusinessDetails(chat);
    for (const answer of ['Consulting', 'Desert Rose', '1', 'Skip']) await chat.say(answer);
    await chat.select('package_selection', 'shams-starter');
    await chat.confirm();
    await chat.confirm();
    await chat.say('confirm and submit');
    expect(await applicationsOf(agent)).toHaveLength(1);
  });

  it('starts over cleanly after a submission', async () => {
    const { chat } = await startCompanyChat();
    await toBusinessDetails(chat);
    for (const answer of ['Consulting', 'Desert Rose', '1', 'Skip']) await chat.say(answer);
    await chat.select('package_selection', 'shams-starter');
    await chat.confirm();
    await chat.say('Start a company');
    expect(chat.workflow).toMatchObject({ type: 'company_registration', step: 'registration_type', company: {} });
    expect(chat.workflow.company.companyName).toBeUndefined();
  });
});

describe('working capital finance with the built-in rules', () => {
  async function recordedRequest() {
    const ctx = await startCompanyChat();
    const { chat, agent } = ctx;
    await chat.say('Working Capital Finance');
    expect(chat.text).toContain('does not offer, price or approve');
    await chat.say('Yes, use ABC Trading LLC');
    await chat.say('AED 350,000');
    await chat.say('Inventory');
    expect(chat.workflow.step).toBe('documents');
    await chat.say('Continue');
    expect(chat.workflow.step).toBe('review');
    await chat.confirm();
    const [app] = await applicationsOf(agent);
    return { ...ctx, application: app! };
  }

  it('records a request, flags what is missing and never offers terms', async () => {
    const { application: app, chat } = await recordedRequest();
    expect(app).toMatchObject({ service: 'working_capital_finance', status: 'documents_pending' });
    expect(app.id).toMatch(/^FIN-\d{4}-\d{6}$/);
    expect(app.requirements.map((r) => r.kind)).toEqual(['document', 'information']);
    expect(chat.text).toContain(app.id);
    expect(chat.text).toContain('does not offer, price or approve');
    expect(chat.everything).not.toMatch(/interest|APR|approved for|you qualify/i);
  });

  it('rejects an amount of zero and a non-number', async () => {
    const { chat, agent } = await startCompanyChat();
    await chat.say('Working Capital Finance');
    await chat.say('yes');
    await chat.say('0');
    expect(chat.workflow.finance.amount).toBeUndefined();
    await chat.say('abc');
    expect(chat.workflow.finance.amount).toBeUndefined();
    expect(await applicationsOf(agent)).toHaveLength(0);
  });

  it('resolves a missing information item through the clarification flow, via the validated service', async () => {
    const { application: app, chat, agent } = await recordedRequest();
    await chat.act({ type: 'clarify', applicationId: app.id });
    expect(chat.workflow.clarificationApplicationId).toBe(app.id);
    expect(chat.kinds).toContain('upload');

    await chat.say('AED 2,400,000');
    const [updated] = await applicationsOf(agent);
    expect(updated!.requirements.find((r) => r.kind === 'information')?.done).toBe(true);
    // The bank statement is still outstanding, so the request keeps waiting for it.
    expect(updated!.status).toBe('documents_pending');
  });

  it('acknowledges an upload only when the document really is on record', async () => {
    const { application: app, chat, agent } = await recordedRequest();
    await chat.act({ type: 'clarify', applicationId: app.id });

    const claim = { type: 'uploaded', applicationId: app.id, requirementId: 'req-bank_statement_6m' };
    await chat.act(claim);
    expect(chat.text).toContain('cannot see that document');
    expect(chat.text).not.toContain('recorded your');

    await upload(agent, { buffer: pdf('s'), filename: 'statement.pdf' }, { typeId: 'bank_statement_6m', applicationId: app.id, requirementId: 'req-bank_statement_6m' }).expect(201);
    await chat.act(claim);
    expect(chat.text).toContain("stored on this prototype's server");
  });

  it("will not open another user's application in a chat", async () => {
    const { application, app } = await recordedRequest();
    const bob = await signUp(app, 'bob@example.com');
    const bobChat = await Chat.start(bob);
    await bobChat.act({ type: 'clarify', applicationId: application.id }, 404);
    await bobChat.act({ type: 'uploaded', applicationId: application.id, requirementId: 'req-bank_statement_6m' }, 404);
  });
});

describe('editing the draft from the review screen', () => {
  async function atReview() {
    const ctx = await startCompanyChat();
    await toBusinessDetails(ctx.chat);
    for (const answer of ['Consulting', 'Desert Rose', '1', 'Skip']) await ctx.chat.say(answer);
    await ctx.chat.select('package_selection', 'shams-starter');
    return ctx;
  }
  const patch = (agent: { patch: (url: string) => { send: (body: object) => any } }, id: string, company: object) =>
    agent.patch(`/api/conversations/${id}/draft`).send({ company });

  it('changes a field, keeps the draft valid and stores it', async () => {
    const { agent, chat } = await atReview();
    const res = await patch(agent, chat.id, { companyName: 'Desert Rose Consulting' }).expect(200);
    expect(res.body.workflow).toMatchObject({ step: 'review', company: { companyName: 'Desert Rose Consulting', packageId: 'shams-starter' } });
    expect((await chat.stored()).workflow.company.companyName).toBe('Desert Rose Consulting');
  });

  it('sends the user back to the right step when a choice that others depend on changes', async () => {
    const { agent, chat } = await atReview();
    const res = await patch(agent, chat.id, { jurisdictionId: 'ifza' }).expect(200);
    expect(res.body.workflow.step).toBe('package_selection');
    expect(res.body.workflow.company.packageId).toBeUndefined();
    const changed = await patch(agent, chat.id, { registrationType: 'offshore' }).expect(200);
    expect(changed.body.workflow).toMatchObject({ step: 'jurisdiction' });
    expect(changed.body.workflow.company.jurisdictionId).toBeUndefined();
  });

  it.each([
    ['an unknown field', { companyName: 'Desert Rose', status: 'approved' }, 400],
    ['an invalid value', { shareholders: 0 }, 400],
    ['an empty edit', {}, 400],
    ['a jurisdiction that does not exist', { jurisdictionId: 'atlantis' }, 422],
    ['a jurisdiction of another registration type', { jurisdictionId: 'dubai-mainland' }, 422],
    ['a package of another jurisdiction', { packageId: 'dmcc-starter' }, 422],
  ])('refuses %s without changing anything', async (_label, company, status) => {
    const { agent, chat } = await atReview();
    const before = (await chat.stored()).workflow;
    await patch(agent, chat.id, company).expect(status);
    expect((await chat.stored()).workflow).toEqual(before);
  });

  it('cannot move the step or write other state', async () => {
    const { agent, chat } = await atReview();
    await agent.patch(`/api/conversations/${chat.id}/draft`).send({ company: { companyName: 'Desert Rose' }, workflow: { step: 'submitted' } }).expect(400);
    await agent.patch(`/api/conversations/${chat.id}/draft`).send({ step: 'submitted' }).expect(400);
  });

  it('refuses an edit when there is nothing in progress or after submission', async () => {
    const fresh = await startCompanyChat();
    await patch(fresh.agent, fresh.chat.id, { companyName: 'Desert Rose' }).expect(409);

    const { agent, chat } = await atReview();
    await chat.confirm();
    await patch(agent, chat.id, { companyName: 'Changed After Submit' }).expect(409);
    expect(await applicationsOf(agent)).toHaveLength(1);
  });

  it("is private to the conversation's owner", async () => {
    const { app, chat } = await atReview();
    const bob = await signUp(app, 'bob@example.com');
    await patch(bob, chat.id, { companyName: 'Hijacked Ltd' }).expect(404);
    expect((await chat.stored()).workflow.company.companyName).toBe('Desert Rose');
    const anonymous = (await import('supertest')).default(app);
    await anonymous.patch(`/api/conversations/${chat.id}/draft`).send({ company: { companyName: 'x2' } }).expect(401);
  });
});
