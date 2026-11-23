import { describe, expect, it } from 'vitest';
import {
  agentFor,
  companyBody,
  createTestApp,
  financeBody,
  jpeg,
  pdf,
  signUp,
  upload,
  uploadRequiredCompanyDocuments,
} from './test/helpers.js';

const stepStates = (application: { progress: { steps: Array<{ kind: string; state: string }> } }) =>
  application.progress.steps.map((s) => `${s.kind}:${s.state}`);

describe('creating a company registration', () => {
  it('records a document-pending application when no documents are on record', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const res = await agent.post('/api/applications').send(companyBody()).expect(201);
    const application = res.body.application;

    expect(application.id).toMatch(/^REG-\d{4}-\d{6}$/);
    expect(application).toMatchObject({ service: 'company_registration', title: 'Company Registration', subtitle: 'Vinith Media', status: 'documents_pending' });
    expect(stepStates(application)).toEqual([
      'request_understood:complete',
      'details_confirmed:complete',
      'requirements_complete:current',
      'submitted:upcoming',
      'under_review:upcoming',
      'completed:upcoming',
    ]);
    expect(application.requirements.map((r: { docTypeId: string; done: boolean }) => [r.docTypeId, r.done])).toEqual([
      ['passport', false],
      ['emirates_id', false],
      ['proof_of_address', false],
    ]);
    expect(application.submittedAt).toBeNull();
    expect(application.nextAction).toEqual({ text: 'Upload passport copy', needsAction: true });
    expect(application.events.map((e: { kind: string }) => e.kind)).toEqual([
      'request_understood',
      'details_confirmed',
      'requirement_requested',
      'requirement_requested',
      'requirement_requested',
    ]);
  });

  it('submits straight away when the documents are already stored', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    await uploadRequiredCompanyDocuments(agent);
    const { application } = (await agent.post('/api/applications').send(companyBody()).expect(201)).body;
    expect(application.status).toBe('submitted');
    expect(stepStates(application).slice(0, 4)).toEqual([
      'request_understood:complete',
      'details_confirmed:complete',
      'requirements_complete:complete',
      'submitted:complete',
    ]);
    expect(application.submittedAt).not.toBeNull();
  });

  it('creates a business profile for the new company', async () => {
    const { app, repos } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    await agent.post('/api/applications').send(companyBody()).expect(201);
    const user = (await repos.users.findByEmail('a@example.com'))!;
    const record = (await repos.applications.listByUser(user.id))[0]!;
    const profile = await repos.businessProfiles.getById(user.id, record.businessProfileId!);
    expect(profile).toMatchObject({ kind: 'new_company', name: 'Vinith Media', registrationType: 'free_zone', jurisdictionId: 'shams', shareholders: 1 });
  });

  it('keeps the application, its events and its cached status in agreement', async () => {
    const { app, repos } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const { application } = (await agent.post('/api/applications').send(companyBody()).expect(201)).body;
    const user = (await repos.users.findByEmail('a@example.com'))!;
    const record = (await repos.applications.findByReference(user.id, application.id))!;
    expect(record.status).toBe(application.status);
    expect(await repos.events.listByApplication(record.id)).toHaveLength(application.events.length);
  });

  describe('validation', () => {
    const post = async (body: unknown) => {
      const { app } = await createTestApp();
      const agent = await signUp(app, 'a@example.com');
      return agent.post('/api/applications').send(body as object);
    };

    it('rejects missing and invalid fields with a 400 that names them', async () => {
      const res = await post(companyBody({ companyName: 'A', shareholders: 0, activity: '' })).then((r) => r.body);
      const paths = res.error.details.map((d: { path: string }) => d.path);
      expect(paths).toEqual(expect.arrayContaining(['company.companyName', 'company.shareholders', 'company.activity']));
    });

    it('rejects an unknown service and an empty body', async () => {
      await post({ service: 'tax_refund' }).then((r) => expect(r.status).toBe(400));
      await post({}).then((r) => expect(r.status).toBe(400));
    });

    it('rejects extra fields such as a status or a date, so they cannot be forced', async () => {
      await post({ ...companyBody(), status: 'completed' }).then((r) => expect(r.status).toBe(400));
      await post(companyBody({ createdAt: '2020-01-01' })).then((r) => expect(r.status).toBe(400));
    });

    it('rejects a jurisdiction that does not belong to the registration type', async () => {
      const res = await post(companyBody({ jurisdictionId: 'dubai-mainland', packageId: 'dubai-mainland-starter' }));
      expect(res.status).toBe(422);
      expect(res.body.error.message).toContain('jurisdiction');
    });

    it('rejects a package from a different jurisdiction, and one that does not exist', async () => {
      expect((await post(companyBody({ packageId: 'dmcc-starter' }))).status).toBe(422);
      expect((await post(companyBody({ packageId: 'made-up' }))).status).toBe(422);
      expect((await post(companyBody({ jurisdictionId: 'made-up' }))).status).toBe(422);
    });

    it('rejects an invalid registration type', async () => {
      expect((await post(companyBody({ registrationType: 'galaxy' }))).status).toBe(400);
    });

    it('rejects an oversized description', async () => {
      expect((await post(companyBody({ description: 'x'.repeat(501) }))).status).toBe(400);
    });
  });
});

describe('the company journey with a missing document', () => {
  it('waits, accepts the upload, then submits, and only the simulation can finish it', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const body = companyBody({ registrationType: 'offshore', jurisdictionId: 'rak-offshore', packageId: 'rak-offshore-starter' });
    await uploadRequiredCompanyDocuments(agent);
    const created = (await agent.post('/api/applications').send(body).expect(201)).body.application;

    // The offshore type needs proof of source of funds, which was not uploaded.
    expect(created.status).toBe('documents_pending');
    expect(created.requirements.filter((r: { done: boolean }) => !r.done).map((r: { docTypeId: string }) => r.docTypeId)).toEqual(['source_of_funds']);
    expect(created.simulation.available).toBe(false);
    await agent.patch(`/api/applications/${created.id}`).send({ action: 'simulate_next' }).expect(409);

    const uploaded = await upload(
      agent,
      { buffer: pdf('funds'), filename: 'funds.pdf' },
      { typeId: 'source_of_funds', applicationId: created.id, requirementId: 'req-source_of_funds' },
    ).expect(201);
    expect(uploaded.body.application.status).toBe('submitted');
    expect(stepStates(uploaded.body.application).slice(0, 4)).toEqual([
      'request_understood:complete',
      'details_confirmed:complete',
      'requirements_complete:complete',
      'submitted:complete',
    ]);
    expect(uploaded.body.application.events.find((e: { kind: string }) => e.kind === 'requirement_provided')).toMatchObject({
      actor: 'user',
      detail: 'funds.pdf',
    });

    const review = (await agent.patch(`/api/applications/${created.id}`).send({ action: 'simulate_next' }).expect(200)).body.application;
    expect(review.status).toBe('under_review');
    expect(review.events.at(-1)).toMatchObject({ kind: 'under_review', actor: 'simulation', title: 'Under review (simulated)' });
    const done = (await agent.patch(`/api/applications/${created.id}`).send({ action: 'simulate_next' }).expect(200)).body.application;
    expect(done.status).toBe('completed');
    expect(done.progress.fraction).toBe(1);
    expect(done.simulation.available).toBe(false);
    await agent.patch(`/api/applications/${created.id}`).send({ action: 'simulate_next' }).expect(409);
  });
});

describe('the working capital journey', () => {
  it('needs the document and the information before preparation, and records no submission', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const created = (await agent.post('/api/applications').send(financeBody()).expect(201)).body.application;

    expect(created).toMatchObject({ id: expect.stringMatching(/^FIN-/), service: 'working_capital_finance', subtitle: 'AED 350,000', status: 'documents_pending' });
    expect(created.details).toEqual(expect.arrayContaining([{ label: 'Business', value: 'ABC Trading LLC' }]));
    expect(created.progress.steps.map((s: { kind: string }) => s.kind)).not.toContain('submitted');
    expect(created.submittedAt).toBeNull();
    expect(created.requirements.map((r: { kind: string }) => r.kind)).toEqual(['document', 'information']);

    // A document alone is not enough.
    const afterDoc = (
      await upload(agent, { buffer: pdf('s'), filename: 'statement.pdf' }, { typeId: 'bank_statement_6m', applicationId: created.id, requirementId: 'req-bank_statement_6m' }).expect(201)
    ).body.application;
    expect(afterDoc.status).toBe('information_required');
    expect(afterDoc.events.map((e: { kind: string }) => e.kind)).not.toContain('preparation_started');

    const afterInfo = (await agent.patch(`/api/applications/${created.id}`).send({ action: 'provide_information', requirementId: 'req-info-0', value: 'AED 2,400,000' }).expect(200)).body.application;
    expect(afterInfo.status).toBe('preparation');
    expect(afterInfo.events.slice(-3).map((e: { kind: string }) => e.kind)).toEqual(['requirement_provided', 'requirements_complete', 'preparation_started']);
    expect(afterInfo.details.at(-1)).toEqual({ label: 'Annual turnover (AED)', value: 'AED 2,400,000' });
    expect(stepStates(afterInfo).slice(0, 4)).toEqual([
      'request_understood:complete',
      'details_confirmed:complete',
      'requirements_complete:complete',
      'preparation_started:complete',
    ]);
  });

  it('uses the user company name, and falls back to their own name when there is none', async () => {
    const { app } = await createTestApp();
    const bare = agentFor(app);
    await bare.post('/api/auth/register').send({ name: 'Sara Khan', email: 'sara@example.com', password: 'a long enough password' }).expect(201);
    const application = (await bare.post('/api/applications').send(financeBody()).expect(201)).body.application;
    expect(application.details[0]).toEqual({ label: 'Business', value: 'Sara Khan' });
  });

  it.each([{ amount: 0 }, { amount: -5 }, { amount: 1.5 }, { amount: 200_000_000 }, { amount: '350000' }, { purpose: '' }, { purpose: 'x'.repeat(121) }])(
    'rejects invalid finance input %j',
    async (overrides) => {
      const { app } = await createTestApp();
      const agent = await signUp(app, 'a@example.com');
      await agent.post('/api/applications').send(financeBody(overrides)).expect(400);
    },
  );
});

describe('updating an application', () => {
  async function financeApplication() {
    const { app, ...rest } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const created = (await agent.post('/api/applications').send(financeBody()).expect(201)).body.application;
    return { app, agent, created, ...rest };
  }

  it('refuses a status, a date or any unknown field, so they cannot be set directly', async () => {
    const { agent, created } = await financeApplication();
    const patch = (body: object) => agent.patch(`/api/applications/${created.id}`).send(body);
    await patch({ status: 'completed' }).expect(400);
    await patch({ action: 'provide_information', requirementId: 'req-info-0', value: 'x', status: 'completed' }).expect(400);
    await patch({ action: 'set_status', status: 'completed' }).expect(400);
    await patch({}).expect(400);
  });

  it('refuses to provide a document through the information action', async () => {
    const { agent, created } = await financeApplication();
    const res = await agent.patch(`/api/applications/${created.id}`).send({ action: 'provide_information', requirementId: 'req-bank_statement_6m', value: 'trust me' }).expect(422);
    expect(res.body.error.message).toContain('uploading');
    const after = (await agent.get(`/api/applications/${created.id}`).expect(200)).body.application;
    expect(after.events).toHaveLength(created.events.length);
  });

  it('refuses unknown requirements, repeated answers and invalid values', async () => {
    const { agent, created } = await financeApplication();
    const patch = (body: object) => agent.patch(`/api/applications/${created.id}`).send(body);
    await patch({ action: 'provide_information', requirementId: 'req-nope', value: 'x' }).expect(404);
    await patch({ action: 'provide_information', requirementId: 'req-info-0', value: '' }).expect(400);
    await patch({ action: 'provide_information', requirementId: 'req-info-0', value: 'x'.repeat(121) }).expect(400);
    await patch({ action: 'provide_information', requirementId: 'req-info-0', value: '2,400,000' }).expect(200);
    await patch({ action: 'provide_information', requirementId: 'req-info-0', value: 'again' }).expect(409);
  });

  it('refuses the simulation when it is switched off, as it is in production', async () => {
    const { app } = await createTestApp({ config: { simulationEnabled: false } });
    const agent = await signUp(app, 'a@example.com');
    await uploadRequiredCompanyDocuments(agent);
    const created = (await agent.post('/api/applications').send(companyBody()).expect(201)).body.application;
    expect(created.simulation).toEqual({ available: false, nextStep: null });
    await agent.patch(`/api/applications/${created.id}`).send({ action: 'simulate_next' }).expect(403);
  });
});

describe('listing and reading', () => {
  it('lists the newest activity first and filters like the Activity screen', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    await uploadRequiredCompanyDocuments(agent);
    const submitted = (await agent.post('/api/applications').send(companyBody()).expect(201)).body.application;
    const waiting = (await agent.post('/api/applications').send(financeBody()).expect(201)).body.application;

    const all = (await agent.get('/api/applications').expect(200)).body.applications;
    expect(all.map((a: { id: string }) => a.id)).toEqual([waiting.id, submitted.id]);

    const ids = async (filter: string) => (await agent.get(`/api/applications?filter=${filter}`).expect(200)).body.applications.map((a: { id: string }) => a.id);
    expect(await ids('needs_action')).toEqual([waiting.id]);
    expect(await ids('in_progress')).toEqual([submitted.id]);
    expect(await ids('completed')).toEqual([]);
    await agent.get('/api/applications?filter=everything').expect(400);
    await agent.get('/api/applications?unknown=1').expect(400);

    await agent.patch(`/api/applications/${submitted.id}`).send({ action: 'simulate_next' }).expect(200);
    await agent.patch(`/api/applications/${submitted.id}`).send({ action: 'simulate_next' }).expect(200);
    expect(await ids('completed')).toEqual([submitted.id]);
  });

  it('returns the same derived view when reading one application', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const created = (await agent.post('/api/applications').send(financeBody()).expect(201)).body.application;
    const read = (await agent.get(`/api/applications/${created.id}`).expect(200)).body.application;
    expect(read).toEqual(created);
  });

  it('treats a malformed or unknown reference as not found', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    await agent.get('/api/applications/REG-2026-999999').expect(404);
    await agent.get('/api/applications/not-a-reference').expect(404);
    await agent.get('/api/applications/%7B%22%24ne%22%3Anull%7D').expect(404);
    await agent.patch('/api/applications/nope').send({ action: 'simulate_next' }).expect(404);
    await agent.get('/api/applications/nope/documents').expect(404);
  });
});

describe('ownership', () => {
  it("never reveals or changes another user's application", async () => {
    const { app, storage } = await createTestApp();
    const alice = await signUp(app, 'alice@example.com');
    const bob = await signUp(app, 'bob@example.com');
    const created = (await alice.post('/api/applications').send(financeBody()).expect(201)).body.application;

    await bob.get(`/api/applications/${created.id}`).expect(404);
    await bob.get(`/api/applications/${created.id}/documents`).expect(404);
    await bob.patch(`/api/applications/${created.id}`).send({ action: 'provide_information', requirementId: 'req-info-0', value: 'x' }).expect(404);
    await bob.patch(`/api/applications/${created.id}`).send({ action: 'simulate_next' }).expect(404);
    expect((await bob.get('/api/applications').expect(200)).body.applications).toEqual([]);

    // Uploading against someone else's application is refused before any file is stored.
    const before = storage.keys().length;
    await upload(bob, { buffer: pdf(), filename: 's.pdf' }, { typeId: 'bank_statement_6m', applicationId: created.id, requirementId: 'req-bank_statement_6m' }).expect(404);
    expect(storage.keys()).toHaveLength(before);

    const untouched = (await alice.get(`/api/applications/${created.id}`).expect(200)).body.application;
    expect(untouched.events).toHaveLength(created.events.length);
  });

  it("does not count another user's documents as being on record", async () => {
    const { app } = await createTestApp();
    const alice = await signUp(app, 'alice@example.com');
    const bob = await signUp(app, 'bob@example.com');
    await uploadRequiredCompanyDocuments(alice);
    const mine = (await bob.post('/api/applications').send(companyBody()).expect(201)).body.application;
    expect(mine.status).toBe('documents_pending');
  });
});

describe('concurrency', () => {
  it('records a requirement only once when the same upload arrives twice at the same time', async () => {
    const { app, storage } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const created = (await agent.post('/api/applications').send(financeBody()).expect(201)).body.application;
    const send = () =>
      upload(agent, { buffer: pdf('same'), filename: 'statement.pdf' }, { typeId: 'bank_statement_6m', applicationId: created.id, requirementId: 'req-bank_statement_6m' });

    const results = await Promise.all([send(), send(), send()]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(2);

    const after = (await agent.get(`/api/applications/${created.id}`).expect(200)).body.application;
    expect(after.events.filter((e: { kind: string }) => e.kind === 'requirement_provided')).toHaveLength(1);
    // The losers' files were removed again, so no orphans remain.
    expect(storage.keys()).toHaveLength(1);
    const docs = (await agent.get(`/api/applications/${created.id}/documents`).expect(200)).body.documents;
    expect(docs).toHaveLength(1);
  });

  it('records a simulated step only once under concurrent requests', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    await uploadRequiredCompanyDocuments(agent);
    const created = (await agent.post('/api/applications').send(companyBody()).expect(201)).body.application;
    const results = await Promise.all([1, 2, 3].map(() => agent.patch(`/api/applications/${created.id}`).send({ action: 'simulate_next' })));
    const ok = results.filter((r) => r.status === 200).length;
    const after = (await agent.get(`/api/applications/${created.id}`).expect(200)).body.application;
    expect(after.events.filter((e: { kind: string }) => e.kind === 'under_review')).toHaveLength(1);
    expect(ok).toBeGreaterThanOrEqual(1);
    expect(after.progress.consistent).toBe(true);
  });
});

describe('progress always matches the events', () => {
  it('shows a step as complete only if an event of that kind exists, at every point of a journey', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const created = (await agent.post('/api/applications').send(financeBody()).expect(201)).body.application;
    const check = (application: { events: Array<{ kind: string }>; progress: { consistent: boolean; steps: Array<{ kind: string; state: string }> } }) => {
      expect(application.progress.consistent).toBe(true);
      for (const step of application.progress.steps) {
        expect(step.state === 'complete').toBe(application.events.some((e) => e.kind === step.kind));
      }
    };
    check(created);
    const one = (await upload(agent, { buffer: jpeg(), filename: 's.jpg' }, { typeId: 'bank_statement_6m', applicationId: created.id, requirementId: 'req-bank_statement_6m' }).expect(201)).body.application;
    check(one);
    const two = (await agent.patch(`/api/applications/${created.id}`).send({ action: 'provide_information', requirementId: 'req-info-0', value: '1' }).expect(200)).body.application;
    check(two);
    check((await agent.patch(`/api/applications/${created.id}`).send({ action: 'simulate_next' }).expect(200)).body.application);
    check((await agent.patch(`/api/applications/${created.id}`).send({ action: 'simulate_next' }).expect(200)).body.application);
  });
});
