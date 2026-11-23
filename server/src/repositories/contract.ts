import type { WorkflowEvent } from '@tajir/shared';
import { describe, expect, it } from 'vitest';
import { DuplicateError } from './errors.js';
import type { Repositories } from './types.js';

export interface ContractHarness {
  repos: Repositories;
  cleanup: () => Promise<void>;
}

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 21, 10, minutes, 0));

const event = (over: Partial<WorkflowEvent> & Pick<WorkflowEvent, 'kind'>, minutes = 0): WorkflowEvent => ({
  id: `ev-${Math.random().toString(36).slice(2)}`,
  at: at(minutes).toISOString(),
  actor: 'system',
  title: over.kind,
  ...over,
});

/**
 * The behaviour every repository implementation must have. It runs against the
 * in-memory implementation on every test run and against MongoDB Atlas in the
 * integration run, so the in-memory stand-in is proven to behave like the real one.
 */
export function describeRepositoryContract(name: string, make: () => Promise<ContractHarness>): void {
  describe(`repository contract: ${name}`, () => {
    async function withRepos<T>(run: (repos: Repositories) => Promise<T>): Promise<T> {
      const harness = await make();
      try {
        return await run(harness.repos);
      } finally {
        await harness.cleanup();
      }
    }

    const newUser = (repos: Repositories, email: string, name = 'Test User') =>
      repos.users.create({ name, email, passwordHash: 'hash-' + email });

    describe('users', () => {
      it('creates users with a normalised email and never exposes the password hash through findById', () =>
        withRepos(async ({ users }) => {
          const created = await users.create({ name: 'Ahmed', email: '  Ahmed@Example.COM ', passwordHash: 'secret-hash' });
          expect(created.email).toBe('ahmed@example.com');
          expect(created).not.toHaveProperty('passwordHash');

          const byId = await users.findById(created.id);
          expect(byId).toMatchObject({ id: created.id, name: 'Ahmed', email: 'ahmed@example.com' });
          expect(byId).not.toHaveProperty('passwordHash');

          const byEmail = await users.findByEmail('AHMED@example.com');
          expect(byEmail?.passwordHash).toBe('secret-hash');
        }));

      it('rejects a second account with the same email, whatever the case', () =>
        withRepos(async ({ users }) => {
          await users.create({ name: 'A', email: 'dup@example.com', passwordHash: 'h' });
          await expect(users.create({ name: 'B', email: 'DUP@example.com', passwordHash: 'h' })).rejects.toThrow(DuplicateError);
          await expect(users.create({ name: 'B', email: 'dup@example.com', passwordHash: 'h' })).rejects.toMatchObject({ field: 'email' });
        }));

      it('returns null for unknown users and for ids that are not valid', () =>
        withRepos(async ({ users }) => {
          expect(await users.findByEmail('nobody@example.com')).toBeNull();
          expect(await users.findById('not-an-id')).toBeNull();
          expect(await users.findById('0123456789abcdef01234567')).toBeNull();
        }));
    });

    describe('business profiles', () => {
      it('finds the oldest existing company and keeps profiles private to their owner', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const b = await newUser(repos, 'b@example.com');
          const first = await repos.businessProfiles.create({ userId: a.id, kind: 'existing_company', name: 'ABC Trading LLC' });
          await repos.businessProfiles.create({ userId: a.id, kind: 'new_company', name: 'Vinith Media', registrationType: 'free_zone', shareholders: 2 });
          await repos.businessProfiles.create({ userId: a.id, kind: 'existing_company', name: 'Second Co' });

          expect((await repos.businessProfiles.findPrimaryCompany(a.id))?.id).toBe(first.id);
          expect(await repos.businessProfiles.findPrimaryCompany(b.id)).toBeNull();
          expect(await repos.businessProfiles.getById(a.id, first.id)).toMatchObject({ name: 'ABC Trading LLC' });
          expect(await repos.businessProfiles.getById(b.id, first.id)).toBeNull();
          expect(await repos.businessProfiles.getById(a.id, 'nope')).toBeNull();
        }));

      it('keeps optional new-company details', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const profile = await repos.businessProfiles.create({
            userId: a.id,
            kind: 'new_company',
            name: 'Vinith Media',
            registrationType: 'free_zone',
            jurisdictionId: 'shams',
            packageId: 'shams-starter',
            activity: 'Media & Marketing',
            category: 'Media & Advertising',
            description: 'Studio',
            shareholders: 2,
          });
          expect(await repos.businessProfiles.getById(a.id, profile.id)).toMatchObject({
            registrationType: 'free_zone',
            jurisdictionId: 'shams',
            shareholders: 2,
          });
        }));
    });

    describe('services', () => {
      const def = (name: string) => ({
        slug: 'company_registration' as const,
        type: 'company_registration' as const,
        name,
        description: 'Sample',
        steps: [{ kind: 'request_understood', label: 'Request understood' }],
        config: { jurisdictions: ['shams'] },
        sample: true,
      });

      it('upserts by slug, keeping the same id, and finds by id or slug', () =>
        withRepos(async ({ services }) => {
          const first = await services.upsert(def('Company Registration'));
          const second = await services.upsert(def('Company Registration v2'));
          expect(second.id).toBe(first.id);
          expect(second.name).toBe('Company Registration v2');
          expect(await services.list()).toHaveLength(1);
          expect((await services.findByIdOrSlug(first.id))?.slug).toBe('company_registration');
          expect((await services.findByIdOrSlug('company_registration'))?.id).toBe(first.id);
          expect(await services.findByIdOrSlug('unknown')).toBeNull();
          expect((await services.findByIdOrSlug('company_registration'))?.config).toEqual({ jurisdictions: ['shams'] });
        }));
    });

    describe('conversations and messages', () => {
      it('lists most recently active first and only the owner can read or change them', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const b = await newUser(repos, 'b@example.com');
          const one = await repos.conversations.create({ userId: a.id, title: 'One', workflow: { step: 'intent' } });
          const two = await repos.conversations.create({ userId: a.id, title: 'Two', workflow: {} });
          await repos.conversations.update(a.id, one.id, { lastMessageAt: at(30) });
          await repos.conversations.update(a.id, two.id, { lastMessageAt: at(10) });

          expect((await repos.conversations.list(a.id, 10)).map((c) => c.title)).toEqual(['One', 'Two']);
          expect(await repos.conversations.list(a.id, 1)).toHaveLength(1);
          expect(await repos.conversations.list(b.id, 10)).toEqual([]);
          expect(await repos.conversations.get(b.id, one.id)).toBeNull();
          expect(await repos.conversations.update(b.id, one.id, { title: 'Hijack' })).toBeNull();
          expect((await repos.conversations.get(a.id, one.id))?.title).toBe('One');
        }));

      it('persists workflow state', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const c = await repos.conversations.create({ userId: a.id, title: 'C', workflow: { type: null, step: 'intent' } });
          const updated = await repos.conversations.update(a.id, c.id, { workflow: { type: 'company_registration', step: 'jurisdiction', company: { registrationType: 'free_zone' } } });
          expect(updated?.workflow).toEqual({ type: 'company_registration', step: 'jurisdiction', company: { registrationType: 'free_zone' } });
          expect((await repos.conversations.get(a.id, c.id))?.workflow).toMatchObject({ step: 'jurisdiction' });
        }));

      it('stores and updates the quick replies, and does not share them between conversations', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const plain = await repos.conversations.create({ userId: a.id, title: 'Plain', workflow: {} });
          expect(plain.quickReplies).toEqual([]);
          const withReplies = await repos.conversations.create({ userId: a.id, title: 'With', workflow: {}, quickReplies: ['Start a company', 'Explore'] });
          expect((await repos.conversations.get(a.id, withReplies.id))?.quickReplies).toEqual(['Start a company', 'Explore']);
          await repos.conversations.update(a.id, withReplies.id, { quickReplies: ['Mainland'] });
          expect((await repos.conversations.get(a.id, withReplies.id))?.quickReplies).toEqual(['Mainland']);
          await repos.conversations.update(a.id, withReplies.id, { quickReplies: [] });
          expect((await repos.conversations.get(a.id, withReplies.id))?.quickReplies).toEqual([]);
          expect((await repos.conversations.get(a.id, plain.id))?.quickReplies).toEqual([]);
        }));

      it('returns the latest messages oldest first, scoped to the owner', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const b = await newUser(repos, 'b@example.com');
          const c = await repos.conversations.create({ userId: a.id, title: 'C', workflow: {} });
          for (const text of ['one', 'two', 'three', 'four']) {
            await repos.messages.append({ conversationId: c.id, userId: a.id, role: 'user', kind: 'text', text });
          }
          await repos.messages.append({ conversationId: c.id, userId: a.id, role: 'assistant', kind: 'status', payload: { applicationId: 'REG-2026-000001' } });

          expect((await repos.messages.list(a.id, c.id, 3)).map((m) => m.text ?? m.kind)).toEqual(['three', 'four', 'status']);
          expect(await repos.messages.count(a.id, c.id)).toBe(5);
          expect(await repos.messages.list(b.id, c.id, 10)).toEqual([]);
          expect(await repos.messages.count(b.id, c.id)).toBe(0);
          const last = (await repos.messages.list(a.id, c.id, 1))[0];
          expect(last).toMatchObject({ role: 'assistant', kind: 'status', payload: { applicationId: 'REG-2026-000001' } });
        }));
    });

    describe('applications', () => {
      const base = (userId: string, reference: string, over: Record<string, unknown> = {}) => ({
        userId,
        reference,
        service: 'company_registration' as const,
        title: 'Company Registration',
        subtitle: 'Vinith Media',
        details: [{ label: 'Company name', value: 'Vinith Media' }],
        status: 'submitted' as const,
        lastEventAt: at(0),
        ...over,
      });

      it('creates applications with unique references and finds them only for the owner', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const b = await newUser(repos, 'b@example.com');
          const created = await repos.applications.create(base(a.id, 'REG-2026-000001'));
          expect(created).toMatchObject({ reference: 'REG-2026-000001', userId: a.id, status: 'submitted' });
          expect(created.details).toEqual([{ label: 'Company name', value: 'Vinith Media' }]);

          await expect(repos.applications.create(base(b.id, 'REG-2026-000001'))).rejects.toMatchObject({ field: 'reference' });
          expect((await repos.applications.findByReference(a.id, 'REG-2026-000001'))?.id).toBe(created.id);
          expect(await repos.applications.findByReference(b.id, 'REG-2026-000001')).toBeNull();
          expect(await repos.applications.findByReference(a.id, 'REG-2026-999999')).toBeNull();
        }));

      it('lists by most recent activity and filters by status', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const b = await newUser(repos, 'b@example.com');
          await repos.applications.create(base(a.id, 'REG-2026-000001', { status: 'completed', lastEventAt: at(1) }));
          await repos.applications.create(base(a.id, 'REG-2026-000002', { status: 'documents_pending', lastEventAt: at(30) }));
          await repos.applications.create(base(a.id, 'FIN-2026-000003', { service: 'working_capital_finance', status: 'preparation', lastEventAt: at(20) }));
          await repos.applications.create(base(b.id, 'REG-2026-000004'));

          expect((await repos.applications.listByUser(a.id)).map((x) => x.reference)).toEqual(['REG-2026-000002', 'FIN-2026-000003', 'REG-2026-000001']);
          expect((await repos.applications.listByUser(a.id, { statuses: ['documents_pending', 'information_required'] })).map((x) => x.reference)).toEqual(['REG-2026-000002']);
          expect(await repos.applications.listByUser(a.id, { statuses: [] })).toEqual([]);
          expect(await repos.applications.listByUser('not-an-id')).toEqual([]);
        }));

      it('updates the status cache only for the owner', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const b = await newUser(repos, 'b@example.com');
          const app = await repos.applications.create(base(a.id, 'REG-2026-000001'));
          await repos.applications.updateCache(b.id, app.id, { status: 'completed', lastEventAt: at(50) });
          expect((await repos.applications.findByReference(a.id, app.reference))?.status).toBe('submitted');
          await repos.applications.updateCache(a.id, app.id, { status: 'under_review', lastEventAt: at(40) });
          expect(await repos.applications.findByReference(a.id, app.reference)).toMatchObject({ status: 'under_review', lastEventAt: at(40) });
          await expect(repos.applications.updateCache(a.id, 'nope', { status: 'completed', lastEventAt: at(1) })).resolves.toBeUndefined();
        }));
    });

    describe('application events', () => {
      async function setup(repos: Repositories, reference = 'REG-2026-000001') {
        const user = await newUser(repos, `${reference.toLowerCase()}@example.com`);
        const app = await repos.applications.create({
          userId: user.id,
          reference,
          service: 'company_registration',
          title: 't',
          subtitle: 's',
          details: [],
          status: 'request_understood',
          lastEventAt: at(0),
        });
        return { user, app };
      }

      it('returns events in the order they were recorded and keeps every field', () =>
        withRepos(async (repos) => {
          const { user, app } = await setup(repos);
          const requirement = { id: 'req-passport', label: 'Passport copy', kind: 'document' as const, docTypeId: 'passport' };
          const events: WorkflowEvent[] = [
            event({ kind: 'request_understood', detail: 'Company Registration' }, 0),
            event({ kind: 'details_confirmed', actor: 'user' }, 1),
            event({ kind: 'requirement_requested', requirement }, 2),
            event({ kind: 'requirement_provided', actor: 'user', requirementId: 'req-passport', value: 'x', detail: 'passport.pdf' }, 3),
          ];
          for (const e of events) await repos.events.append({ applicationId: app.id, userId: user.id, event: e });

          const stored = await repos.events.listByApplication(app.id);
          expect(stored.map((e) => e.kind)).toEqual(['request_understood', 'details_confirmed', 'requirement_requested', 'requirement_provided']);
          expect(stored[0]).toEqual(events[0]);
          expect(stored[2]).toEqual(events[2]);
          expect(stored[3]).toEqual(events[3]);
        }));

      it('refuses to record the same step twice, which also protects against concurrent requests', () =>
        withRepos(async (repos) => {
          const { user, app } = await setup(repos);
          const requirement = { id: 'req-a', label: 'A', kind: 'document' as const, docTypeId: 'passport' };
          await repos.events.append({ applicationId: app.id, userId: user.id, event: event({ kind: 'request_understood' }) });
          await repos.events.append({ applicationId: app.id, userId: user.id, event: event({ kind: 'requirement_requested', requirement }) });
          await repos.events.append({ applicationId: app.id, userId: user.id, event: event({ kind: 'requirement_provided', requirementId: 'req-a' }) });

          await expect(repos.events.append({ applicationId: app.id, userId: user.id, event: event({ kind: 'request_understood' }) })).rejects.toThrow(DuplicateError);
          await expect(repos.events.append({ applicationId: app.id, userId: user.id, event: event({ kind: 'requirement_requested', requirement }) })).rejects.toThrow(DuplicateError);
          await expect(repos.events.append({ applicationId: app.id, userId: user.id, event: event({ kind: 'requirement_provided', requirementId: 'req-a' }) })).rejects.toThrow(DuplicateError);
          expect(await repos.events.listByApplication(app.id)).toHaveLength(3);

          const results = await Promise.allSettled([
            repos.events.append({ applicationId: app.id, userId: user.id, event: event({ kind: 'submitted' }) }),
            repos.events.append({ applicationId: app.id, userId: user.id, event: event({ kind: 'submitted' }) }),
            repos.events.append({ applicationId: app.id, userId: user.id, event: event({ kind: 'submitted' }) }),
          ]);
          expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
          expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
          expect((await repos.events.listByApplication(app.id)).filter((e) => e.kind === 'submitted')).toHaveLength(1);
        }));

      it('allows the same milestone on different applications', () =>
        withRepos(async (repos) => {
          const one = await setup(repos, 'REG-2026-000001');
          const two = await setup(repos, 'REG-2026-000002');
          await repos.events.append({ applicationId: one.app.id, userId: one.user.id, event: event({ kind: 'request_understood' }) });
          await repos.events.append({ applicationId: two.app.id, userId: two.user.id, event: event({ kind: 'request_understood' }) });
          expect(await repos.events.listByApplication(one.app.id)).toHaveLength(1);
          expect(await repos.events.listByApplication(two.app.id)).toHaveLength(1);
        }));

      it('lists events for several applications at once, including applications with none', () =>
        withRepos(async (repos) => {
          const one = await setup(repos, 'REG-2026-000001');
          const two = await setup(repos, 'REG-2026-000002');
          await repos.events.append({ applicationId: one.app.id, userId: one.user.id, event: event({ kind: 'request_understood' }, 0) });
          await repos.events.append({ applicationId: one.app.id, userId: one.user.id, event: event({ kind: 'details_confirmed' }, 1) });
          const map = await repos.events.listByApplications([one.app.id, two.app.id, 'not-an-id']);
          expect(map.get(one.app.id)?.map((e) => e.kind)).toEqual(['request_understood', 'details_confirmed']);
          expect(map.get(two.app.id)).toEqual([]);
          expect(map.get('not-an-id')).toEqual([]);
          expect(await repos.events.listByApplication('not-an-id')).toEqual([]);
        }));
    });

    describe('documents', () => {
      const doc = (userId: string, over: Record<string, unknown> = {}) => ({
        userId,
        typeId: 'passport',
        originalName: 'passport.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1234,
        sha256: 'a'.repeat(64),
        storageKey: `${userId}/abc.pdf`,
        storageProvider: 'local',
        ...over,
      });

      it('stores metadata, lists newest first and keeps documents private to their owner', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const b = await newUser(repos, 'b@example.com');
          const first = await repos.documents.create(doc(a.id, { originalName: 'first.pdf' }));
          const second = await repos.documents.create(doc(a.id, { originalName: 'second.pdf', typeId: 'emirates_id' }));
          await repos.documents.create(doc(b.id));

          expect(first).toMatchObject({ userId: a.id, sha256: 'a'.repeat(64), storageProvider: 'local' });
          expect((await repos.documents.listByUser(a.id, 10)).map((d) => d.id)).toEqual([second.id, first.id]);
          expect(await repos.documents.listByUser(a.id, 1)).toHaveLength(1);
          expect(await repos.documents.countByUser(a.id)).toBe(2);
          expect(await repos.documents.countByUser(b.id)).toBe(1);
          expect(await repos.documents.countByUser('not-an-id')).toBe(0);
        }));

      it('deletes a record only for its owner', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const b = await newUser(repos, 'b@example.com');
          const created = await repos.documents.create(doc(a.id));
          expect(await repos.documents.delete(b.id, created.id)).toBe(false);
          expect(await repos.documents.countByUser(a.id)).toBe(1);
          expect(await repos.documents.delete(a.id, created.id)).toBe(true);
          expect(await repos.documents.delete(a.id, created.id)).toBe(false);
          expect(await repos.documents.delete(a.id, 'not-an-id')).toBe(false);
          expect(await repos.documents.countByUser(a.id)).toBe(0);
        }));

      it('lists the documents of one application for its owner only', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const b = await newUser(repos, 'b@example.com');
          const app = await repos.applications.create({
            userId: a.id,
            reference: 'REG-2026-000001',
            service: 'company_registration',
            title: 't',
            subtitle: 's',
            details: [],
            status: 'documents_pending',
            lastEventAt: at(0),
          });
          await repos.documents.create(doc(a.id, { applicationId: app.id, requirementId: 'req-passport' }));
          await repos.documents.create(doc(a.id));

          const forApp = await repos.documents.listByApplication(a.id, app.id);
          expect(forApp).toHaveLength(1);
          expect(forApp[0]).toMatchObject({ applicationId: app.id, requirementId: 'req-passport' });
          expect(await repos.documents.listByApplication(b.id, app.id)).toEqual([]);
          expect(await repos.documents.listByApplication(a.id, 'not-an-id')).toEqual([]);
        }));

      it('starts as uploaded with no AI step, and the worker can change only processing fields', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const created = await repos.documents.create(doc(a.id));
          expect(created).toMatchObject({ processingStatus: 'uploaded', aiStatus: 'not_requested', retryCount: 0 });
          expect(created.updatedAt).toBeInstanceOf(Date);

          const updated = await repos.documents.update(created.id, { processingStatus: 'processing', retryCount: 1 });
          expect(updated).toMatchObject({ processingStatus: 'processing', retryCount: 1, userId: a.id, sha256: 'a'.repeat(64) });

          const done = await repos.documents.update(created.id, { processingStatus: 'completed', aiStatus: 'skipped', detectedType: 'passport', errorMessage: 'old', processedAt: at(5) });
          expect(done).toMatchObject({ processingStatus: 'completed', aiStatus: 'skipped', detectedType: 'passport', errorMessage: 'old' });
          // null clears a field.
          const cleared = await repos.documents.update(created.id, { errorMessage: null, processedAt: null });
          expect(cleared?.errorMessage).toBeUndefined();
          expect(cleared?.processedAt).toBeUndefined();
          expect(cleared?.detectedType).toBe('passport');

          expect(await repos.documents.update('not-an-id', { retryCount: 2 })).toBeNull();
          expect(await repos.documents.update('0123456789abcdef01234567', { retryCount: 2 })).toBeNull();
        }));

      it('finds a document by id for its owner only, and for the system', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const b = await newUser(repos, 'b@example.com');
          const created = await repos.documents.create(doc(a.id));
          expect((await repos.documents.findById(a.id, created.id))?.id).toBe(created.id);
          expect(await repos.documents.findById(b.id, created.id)).toBeNull();
          expect(await repos.documents.findById(a.id, 'not-an-id')).toBeNull();
          expect(await repos.documents.findById('not-an-id', created.id)).toBeNull();
          expect((await repos.documents.findByIdForSystem(created.id))?.userId).toBe(a.id);
          expect(await repos.documents.findByIdForSystem('not-an-id')).toBeNull();
        }));

      it('pages, filters and searches, always inside the owner’s documents', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const b = await newUser(repos, 'b@example.com');
          const names = ['alpha.pdf', 'Beta (copy).pdf', 'gamma.png', 'delta.pdf', 'epsilon.pdf'];
          const created = [];
          for (const [i, name] of names.entries()) {
            created.push(await repos.documents.create(doc(a.id, { originalName: name, typeId: i === 2 ? 'emirates_id' : 'passport' })));
          }
          await repos.documents.create(doc(b.id, { originalName: 'alpha.pdf' }));
          await repos.documents.update(created[0]!.id, { processingStatus: 'completed' });

          const page1 = await repos.documents.query(a.id, { page: 1, pageSize: 2 });
          expect(page1.total).toBe(5);
          expect(page1.items.map((d) => d.originalName)).toEqual(['epsilon.pdf', 'delta.pdf']);
          const page3 = await repos.documents.query(a.id, { page: 3, pageSize: 2 });
          expect(page3.items.map((d) => d.originalName)).toEqual(['alpha.pdf']);
          expect((await repos.documents.query(a.id, { page: 9, pageSize: 2 })).items).toEqual([]);

          expect((await repos.documents.query(a.id, { page: 1, pageSize: 10, status: 'completed' })).items.map((d) => d.originalName)).toEqual(['alpha.pdf']);
          expect((await repos.documents.query(a.id, { page: 1, pageSize: 10, typeId: 'emirates_id' })).items.map((d) => d.originalName)).toEqual(['gamma.png']);
          expect((await repos.documents.query(a.id, { page: 1, pageSize: 10, search: 'ALPHA' })).total).toBe(1);
          // Search text is matched literally, never as a pattern.
          expect((await repos.documents.query(a.id, { page: 1, pageSize: 10, search: '(copy)' })).items.map((d) => d.originalName)).toEqual(['Beta (copy).pdf']);
          expect((await repos.documents.query(a.id, { page: 1, pageSize: 10, search: '.*' })).total).toBe(0);
          expect((await repos.documents.query(a.id, { page: 1, pageSize: 10, applicationId: 'not-an-id' })).total).toBe(0);
          expect((await repos.documents.query('not-an-id', { page: 1, pageSize: 10 })).total).toBe(0);
        }));

      it('hides a deleted document at once, keeps it listed for cleanup, and removes the record for good', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const b = await newUser(repos, 'b@example.com');
          const created = await repos.documents.create(doc(a.id));
          expect(await repos.documents.markDeleted(b.id, created.id)).toBeNull();
          expect(await repos.documents.markDeleted(a.id, 'not-an-id')).toBeNull();

          const marked = await repos.documents.markDeleted(a.id, created.id);
          expect(marked?.deletedAt).toBeInstanceOf(Date);
          expect(await repos.documents.markDeleted(a.id, created.id)).toBeNull();

          expect(await repos.documents.findById(a.id, created.id)).toBeNull();
          expect(await repos.documents.findByIdForSystem(created.id)).toBeNull();
          expect(await repos.documents.listByUser(a.id, 10)).toEqual([]);
          expect((await repos.documents.query(a.id, { page: 1, pageSize: 10 })).total).toBe(0);
          expect(await repos.documents.countByUser(a.id)).toBe(0);
          expect(await repos.documents.update(created.id, { retryCount: 3 })).toBeNull();

          expect((await repos.documents.listDeleted(10)).map((d) => d.id)).toEqual([created.id]);
          expect(await repos.documents.removeRecord(created.id)).toBe(true);
          expect(await repos.documents.removeRecord(created.id)).toBe(false);
          expect(await repos.documents.listDeleted(10)).toEqual([]);
        }));
    });

    describe('finding a document by its content', () => {
      it('finds the same content for the same user only, and not a deleted one', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const b = await newUser(repos, 'b@example.com');
          const make = (userId: string, name: string, sha256: string) => repos.documents.create({ userId, typeId: 'passport', originalName: name, mimeType: 'application/pdf', sizeBytes: 1, sha256, storageKey: `${userId}/${name}`, storageProvider: 'gridfs' });
          const first = await make(a.id, 'first.pdf', 'c'.repeat(64));
          await make(a.id, 'second.pdf', 'c'.repeat(64));
          await make(b.id, 'theirs.pdf', 'd'.repeat(64));
          expect((await repos.documents.findBySha256(a.id, 'c'.repeat(64)))?.id).toBe(first.id);
          // Someone else's content is not found, even though it exists.
          expect(await repos.documents.findBySha256(a.id, 'd'.repeat(64))).toBeNull();
          expect(await repos.documents.findBySha256('not-an-id', 'c'.repeat(64))).toBeNull();
          expect(await repos.documents.findBySha256(a.id, 'not-a-hash')).toBeNull();
          await repos.documents.markDeleted(a.id, first.id);
          expect((await repos.documents.findBySha256(a.id, 'c'.repeat(64)))?.originalName).toBe('second.pdf');
        }));
    });

    describe('moving a document file between storages', () => {
      const make = (repos: Repositories, userId: string, name: string, over: Record<string, unknown> = {}) =>
        repos.documents.create({ userId, typeId: 'passport', originalName: name, mimeType: 'application/pdf', sizeBytes: 1, sha256: 'a'.repeat(64), storageKey: `${userId}/${name}`, storageProvider: 'local', ...over });

      it('lists the live documents in a storage, and leaves out deleted ones', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const b = await newUser(repos, 'b@example.com');
          await make(repos, a.id, 'one.pdf');
          await make(repos, b.id, 'two.pdf');
          await make(repos, a.id, 'in-gridfs.pdf', { storageProvider: 'gridfs' });
          const gone = await make(repos, a.id, 'gone.pdf');
          await repos.documents.markDeleted(a.id, gone.id);
          expect((await repos.documents.listByStorageProvider('local', 10)).map((d) => d.originalName)).toEqual(['one.pdf', 'two.pdf']);
          expect((await repos.documents.listByStorageProvider('gridfs', 10)).map((d) => d.originalName)).toEqual(['in-gridfs.pdf']);
          expect(await repos.documents.listByStorageProvider('local', 1)).toHaveLength(1);
          expect(await repos.documents.listByStorageProvider('s3', 10)).toEqual([]);
        }));

      it('points a document at its new file only if it still points at the old one, and remembers where it was', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const d = await make(repos, a.id, 'one.pdf');
          const from = { provider: 'local', key: d.storageKey };
          const to = { provider: 'gridfs', key: '0123456789abcdef01234567' };
          const moved = await repos.documents.repointStorage(d.id, from, to, from);
          expect(moved).toMatchObject({ storageProvider: 'gridfs', storageKey: to.key, previousStorage: from, sha256: 'a'.repeat(64), originalName: 'one.pdf' });
          // A second attempt from the old place does nothing: it has already moved.
          expect(await repos.documents.repointStorage(d.id, from, { provider: 'gridfs', key: 'ffffffffffffffffffffffff' }, from)).toBeNull();
          expect((await repos.documents.findById(a.id, d.id))?.storageKey).toBe(to.key);
          // Moving back clears the memory of where it was.
          const back = await repos.documents.repointStorage(d.id, to, from, null);
          expect(back).toMatchObject({ storageProvider: 'local', storageKey: from.key });
          expect(back?.previousStorage).toBeUndefined();
        }));

      it('does not touch a deleted document or an unknown one', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const d = await make(repos, a.id, 'one.pdf');
          await repos.documents.markDeleted(a.id, d.id);
          const from = { provider: 'local', key: d.storageKey };
          expect(await repos.documents.repointStorage(d.id, from, { provider: 'gridfs', key: 'x' }, from)).toBeNull();
          expect(await repos.documents.repointStorage('not-an-id', from, { provider: 'gridfs', key: 'x' }, from)).toBeNull();
          expect(await repos.documents.repointStorage('0123456789abcdef01234567', from, { provider: 'gridfs', key: 'x' }, from)).toBeNull();
        }));

      it('lets only one of several simultaneous moves win', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const d = await make(repos, a.id, 'one.pdf');
          const from = { provider: 'local', key: d.storageKey };
          const results = await Promise.all(['0123456789abcdef01234561', '0123456789abcdef01234562', '0123456789abcdef01234563'].map((key) => repos.documents.repointStorage(d.id, from, { provider: 'gridfs', key }, from)));
          expect(results.filter((r) => r !== null)).toHaveLength(1);
        }));
    });

    describe('finding documents that stopped moving', () => {
      it('lists live documents in a status that have not changed since a time, oldest first', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const make = (name: string) => repos.documents.create({ userId: a.id, typeId: 'passport', originalName: name, mimeType: 'application/pdf', sizeBytes: 1, sha256: 'a'.repeat(64), storageKey: name, storageProvider: 'gridfs' });
          const first = await make('first.pdf');
          await new Promise((resolve) => setTimeout(resolve, 15));
          const second = await make('second.pdf');
          const done = await make('done.pdf');
          await repos.documents.update(done.id, { processingStatus: 'completed' });
          const deleted = await make('deleted.pdf');
          await repos.documents.markDeleted(a.id, deleted.id);

          const future = new Date(Date.now() + 60_000);
          expect((await repos.documents.listByStatus('uploaded', future, 10)).map((d) => d.originalName)).toEqual(['first.pdf', 'second.pdf']);
          expect((await repos.documents.listByStatus('completed', future, 10)).map((d) => d.originalName)).toEqual(['done.pdf']);
          expect(await repos.documents.listByStatus('failed', future, 10)).toEqual([]);
          expect(await repos.documents.listByStatus('uploaded', future, 1)).toHaveLength(1);
          // Nothing is older than a time in the past.
          expect(await repos.documents.listByStatus('uploaded', new Date(first.updatedAt.getTime() - 1), 10)).toEqual([]);
          expect((await repos.documents.listByStatus('uploaded', new Date(second.updatedAt.getTime()), 10)).map((d) => d.originalName)).toEqual(['first.pdf']);
        }));
    });

    describe('document extractions and chunks', () => {
      const base = (documentId: string, userId: string, over: Record<string, unknown> = {}) => ({
        documentId,
        userId,
        sourceSha256: 'b'.repeat(64),
        text: 'Trade licence number 123',
        textLength: 24,
        truncated: false,
        pageCount: 1,
        method: 'pdf_text' as const,
        detectedType: 'trade_licence',
        confidence: 'high' as const,
        structured: null,
        ai: { status: 'not_requested' as const },
        ...over,
      });
      const newDoc = (repos: Repositories, userId: string) =>
        repos.documents.create({ userId, typeId: 'trade_licence', originalName: 'licence.pdf', mimeType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64), storageKey: 'k', storageProvider: 'gridfs' });

      it('saves one extraction per document, replacing the earlier one', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const d = await newDoc(repos, a.id);
          const first = await repos.extractions.save(base(d.id, a.id));
          expect(first).toMatchObject({ documentId: d.id, userId: a.id, method: 'pdf_text', text: 'Trade licence number 123' });
          const second = await repos.extractions.save(base(d.id, a.id, { text: 'new text', textLength: 8, method: 'ocr' }));
          expect(second.id).toBe(first.id);
          expect((await repos.extractions.findByDocument(a.id, d.id))?.text).toBe('new text');
          expect((await repos.extractions.findByDocument(a.id, d.id))?.method).toBe('ocr');
        }));

      it('shows an extraction only to its owner', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const b = await newUser(repos, 'b@example.com');
          const d = await newDoc(repos, a.id);
          await repos.extractions.save(base(d.id, a.id));
          expect(await repos.extractions.findByDocument(b.id, d.id)).toBeNull();
          expect(await repos.extractions.findByDocument(a.id, 'not-an-id')).toBeNull();
          expect((await repos.extractions.findByDocumentForSystem(d.id))?.userId).toBe(a.id);
          expect(await repos.extractions.findByDocumentForSystem('not-an-id')).toBeNull();
          expect(await repos.extractions.listByUser(b.id, 10)).toEqual([]);
        }));

      it('stores what AI understood without touching the text, and lists extractions without their text', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const d = await newDoc(repos, a.id);
          await repos.extractions.save(base(d.id, a.id));
          const updated = await repos.extractions.setUnderstanding(d.id, {
            structured: { licenceNumber: '123', expiry: null },
            ai: { status: 'completed', provider: 'gemini', model: 'm', at: at(3) },
            detectedType: 'trade_licence',
          });
          expect(updated?.structured).toEqual({ licenceNumber: '123', expiry: null });
          expect(updated?.ai).toMatchObject({ status: 'completed', provider: 'gemini', model: 'm' });
          expect(updated?.text).toBe('Trade licence number 123');

          const listed = await repos.extractions.listByUser(a.id, 10);
          expect(listed).toHaveLength(1);
          expect(listed[0]).toMatchObject({ documentId: d.id, detectedType: 'trade_licence', structured: { licenceNumber: '123', expiry: null } });
          expect(listed[0]).not.toHaveProperty('text');
          expect(await repos.extractions.setUnderstanding('0123456789abcdef01234567', { structured: null, ai: { status: 'failed' } })).toBeNull();
        }));

      it('saves chunks in order, replaces them, and only returns the owner’s', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const b = await newUser(repos, 'b@example.com');
          const d1 = await newDoc(repos, a.id);
          const d2 = await newDoc(repos, a.id);
          const other = await newDoc(repos, b.id);
          await repos.extractions.saveChunks(d1.id, a.id, [{ text: 'one', page: 1 }, { text: 'two', page: 2 }, { text: 'three' }]);
          await repos.extractions.saveChunks(d2.id, a.id, [{ text: 'other doc' }]);
          await repos.extractions.saveChunks(other.id, b.id, [{ text: 'someone else' }]);

          const all = await repos.extractions.listChunks(a.id, { limit: 100 });
          expect(all.map((c) => c.text).sort()).toEqual(['one', 'other doc', 'three', 'two']);
          const one = await repos.extractions.listChunks(a.id, { documentIds: [d1.id], limit: 100 });
          expect(one.map((c) => c.text)).toEqual(['one', 'two', 'three']);
          expect(one.map((c) => c.index)).toEqual([0, 1, 2]);
          expect(one[0]?.page).toBe(1);
          expect(one[2]?.page).toBeUndefined();
          expect(await repos.extractions.listChunks(a.id, { documentIds: [d1.id], limit: 2 })).toHaveLength(2);
          // Another user's document id yields nothing, even when asked for by name.
          expect(await repos.extractions.listChunks(a.id, { documentIds: [other.id], limit: 100 })).toEqual([]);
          expect(await repos.extractions.listChunks(a.id, { documentIds: ['not-an-id'], limit: 100 })).toEqual([]);

          await repos.extractions.saveChunks(d1.id, a.id, [{ text: 'replaced' }]);
          expect((await repos.extractions.listChunks(a.id, { documentIds: [d1.id], limit: 100 })).map((c) => c.text)).toEqual(['replaced']);
        }));

      it('deletes the extraction and the chunks of a document together, and nothing else', () =>
        withRepos(async (repos) => {
          const a = await newUser(repos, 'a@example.com');
          const d1 = await newDoc(repos, a.id);
          const d2 = await newDoc(repos, a.id);
          for (const d of [d1, d2]) {
            await repos.extractions.save(base(d.id, a.id));
            await repos.extractions.saveChunks(d.id, a.id, [{ text: 'x' }]);
          }
          await repos.extractions.deleteByDocument(d1.id);
          expect(await repos.extractions.findByDocument(a.id, d1.id)).toBeNull();
          expect(await repos.extractions.listChunks(a.id, { documentIds: [d1.id], limit: 10 })).toEqual([]);
          expect(await repos.extractions.findByDocument(a.id, d2.id)).not.toBeNull();
          expect(await repos.extractions.listChunks(a.id, { documentIds: [d2.id], limit: 10 })).toHaveLength(1);
          await expect(repos.extractions.deleteByDocument('not-an-id')).resolves.toBeUndefined();
        }));
    });

    describe('document processing jobs', () => {
      const newDoc = async (repos: Repositories, email: string) => {
        const user = await newUser(repos, email);
        const d = await repos.documents.create({ userId: user.id, typeId: 'passport', originalName: 'p.pdf', mimeType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64), storageKey: 'k', storageProvider: 'gridfs' });
        return { user, d };
      };
      const opts = (minutes = 0, maxAttempts = 3) => ({ maxAttempts, now: at(minutes) });

      it('queues a document once: a second request returns the same job', () =>
        withRepos(async (repos) => {
          const { user, d } = await newDoc(repos, 'a@example.com');
          const first = await repos.jobs.enqueue(d.id, user.id, opts());
          expect(first.created).toBe(true);
          expect(first.job).toMatchObject({ documentId: d.id, userId: user.id, status: 'queued', attempts: 0, maxAttempts: 3 });
          const second = await repos.jobs.enqueue(d.id, user.id, opts(1));
          expect(second.created).toBe(false);
          expect(second.job.id).toBe(first.job.id);
          expect((await repos.jobs.findByDocument(d.id))?.id).toBe(first.job.id);
        }));

      it('creates exactly one job when many requests arrive together', () =>
        withRepos(async (repos) => {
          const { user, d } = await newDoc(repos, 'a@example.com');
          const results = await Promise.all(Array.from({ length: 8 }, () => repos.jobs.enqueue(d.id, user.id, opts())));
          expect(results.filter((r) => r.created)).toHaveLength(1);
          expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
        }));

      it('lets only one worker take a job, and only when it is due', () =>
        withRepos(async (repos) => {
          const { user, d } = await newDoc(repos, 'a@example.com');
          await repos.jobs.enqueue(d.id, user.id, opts(10));
          expect(await repos.jobs.claim('w1', 60_000, at(5))).toBeNull();
          const claimed = await repos.jobs.claim('w1', 60_000, at(10));
          expect(claimed).toMatchObject({ documentId: d.id, status: 'processing', attempts: 1, lockToken: 'w1' });
          expect(await repos.jobs.claim('w2', 60_000, at(10))).toBeNull();
        }));

      it('lets exactly one of several simultaneous workers win', () =>
        withRepos(async (repos) => {
          const { user, d } = await newDoc(repos, 'a@example.com');
          await repos.jobs.enqueue(d.id, user.id, opts());
          const claims = await Promise.all(['w1', 'w2', 'w3', 'w4', 'w5'].map((w) => repos.jobs.claim(w, 60_000, at(1))));
          expect(claims.filter((c) => c !== null)).toHaveLength(1);
          expect((await repos.jobs.findByDocument(d.id))?.attempts).toBe(1);
        }));

      it('takes the oldest due job first', () =>
        withRepos(async (repos) => {
          const one = await newDoc(repos, 'a@example.com');
          const two = await newDoc(repos, 'b@example.com');
          await repos.jobs.enqueue(two.d.id, two.user.id, opts(5));
          await repos.jobs.enqueue(one.d.id, one.user.id, opts(2));
          expect((await repos.jobs.claim('w', 60_000, at(10)))?.documentId).toBe(one.d.id);
          expect((await repos.jobs.claim('w', 60_000, at(10)))?.documentId).toBe(two.d.id);
        }));

      it('completes a job only for the worker that holds it', () =>
        withRepos(async (repos) => {
          const { user, d } = await newDoc(repos, 'a@example.com');
          const { job } = await repos.jobs.enqueue(d.id, user.id, opts());
          await repos.jobs.claim('w1', 60_000, at(1));
          expect(await repos.jobs.complete(job.id, 'someone-else', at(2), 'done')).toBe(false);
          expect((await repos.jobs.findByDocument(d.id))?.status).toBe('processing');
          expect(await repos.jobs.complete(job.id, 'w1', at(2), 'done')).toBe(true);
          expect(await repos.jobs.complete(job.id, 'w1', at(3), 'again')).toBe(false);
          const done = await repos.jobs.findByDocument(d.id);
          expect(done?.status).toBe('completed');
          expect(done?.lockToken).toBeUndefined();
          expect(done?.history.map((h) => h.status)).toEqual(['queued', 'processing', 'completed']);
        }));

      it('retries after a failure with a delay, then gives up when the attempts run out', () =>
        withRepos(async (repos) => {
          const { user, d } = await newDoc(repos, 'a@example.com');
          const { job } = await repos.jobs.enqueue(d.id, user.id, opts(0, 2));

          await repos.jobs.claim('w1', 60_000, at(1));
          expect(await repos.jobs.fail(job.id, 'wrong-token', at(2), 'boom', at(4))).toBeNull();
          const retrying = await repos.jobs.fail(job.id, 'w1', at(2), 'boom', at(4));
          expect(retrying).toMatchObject({ status: 'retrying', lastError: 'boom' });
          expect(retrying?.lockToken).toBeUndefined();
          // Not before the retry time.
          expect(await repos.jobs.claim('w1', 60_000, at(3))).toBeNull();
          const second = await repos.jobs.claim('w1', 60_000, at(4));
          expect(second?.attempts).toBe(2);

          // The last attempt cannot retry, even if a retry time is given.
          const failed = await repos.jobs.fail(job.id, 'w1', at(5), 'boom again', at(9));
          expect(failed).toMatchObject({ status: 'failed', lastError: 'boom again' });
          expect(await repos.jobs.claim('w1', 60_000, at(20))).toBeNull();
        }));

      it('fails at once when no retry time is given', () =>
        withRepos(async (repos) => {
          const { user, d } = await newDoc(repos, 'a@example.com');
          const { job } = await repos.jobs.enqueue(d.id, user.id, opts());
          await repos.jobs.claim('w1', 60_000, at(1));
          expect((await repos.jobs.fail(job.id, 'w1', at(2), 'unsupported file'))?.status).toBe('failed');
        }));

      it('takes a job back when the worker holding it died (its lease ran out)', () =>
        withRepos(async (repos) => {
          const { user, d } = await newDoc(repos, 'a@example.com');
          await repos.jobs.enqueue(d.id, user.id, opts());
          await repos.jobs.claim('w1', 60_000, at(1));
          expect(await repos.jobs.claim('w2', 60_000, at(1))).toBeNull();
          expect((await repos.jobs.listRecoverable(at(1), 10))).toEqual([]);
          expect((await repos.jobs.listRecoverable(at(5), 10)).map((j) => j.documentId)).toEqual([d.id]);
          const taken = await repos.jobs.claim('w2', 60_000, at(5));
          expect(taken).toMatchObject({ lockToken: 'w2', attempts: 2 });
          // The first worker can no longer finish it.
          expect(await repos.jobs.complete(taken!.id, 'w1', at(6), 'late')).toBe(false);
        }));

      it('puts a finished or failed job back in the queue, as the same record', () =>
        withRepos(async (repos) => {
          const { user, d } = await newDoc(repos, 'a@example.com');
          const { job } = await repos.jobs.enqueue(d.id, user.id, opts());
          await repos.jobs.claim('w1', 60_000, at(1));
          await repos.jobs.fail(job.id, 'w1', at(2), 'unreadable');
          const again = await repos.jobs.enqueue(d.id, user.id, opts(3, 5));
          expect(again.created).toBe(false);
          expect(again.job).toMatchObject({ id: job.id, status: 'queued', attempts: 0, maxAttempts: 5 });
          expect(again.job.lastError).toBeUndefined();
          expect(again.job.history.at(-1)?.status).toBe('requeued');
        }));

      it('lists waiting jobs for recovery, and removes a document’s job', () =>
        withRepos(async (repos) => {
          const one = await newDoc(repos, 'a@example.com');
          const two = await newDoc(repos, 'b@example.com');
          await repos.jobs.enqueue(one.d.id, one.user.id, opts(30));
          const queued = await repos.jobs.enqueue(two.d.id, two.user.id, opts(0));
          // Waiting jobs are listed whatever their time.
          expect((await repos.jobs.listRecoverable(at(1), 10)).map((j) => j.documentId).sort()).toEqual([one.d.id, two.d.id].sort());
          await repos.jobs.claim('w1', 60_000, at(1));
          await repos.jobs.complete(queued.job.id, 'w1', at(2), 'done');
          expect((await repos.jobs.listRecoverable(at(3), 10)).map((j) => j.documentId)).toEqual([one.d.id]);
          await repos.jobs.deleteByDocument(one.d.id);
          expect(await repos.jobs.findByDocument(one.d.id)).toBeNull();
          expect(await repos.jobs.findByDocument('not-an-id')).toBeNull();
          await expect(repos.jobs.deleteByDocument('not-an-id')).resolves.toBeUndefined();
        }));

      it('keeps the job history short', () =>
        withRepos(async (repos) => {
          const { user, d } = await newDoc(repos, 'a@example.com');
          await repos.jobs.enqueue(d.id, user.id, opts(0, 100));
          for (let i = 0; i < 25; i += 1) {
            const claimed = await repos.jobs.claim('w', 60_000, at(i));
            await repos.jobs.fail(claimed!.id, 'w', at(i), `try ${i}`, at(i));
          }
          const job = await repos.jobs.findByDocument(d.id);
          expect(job!.history.length).toBeLessThanOrEqual(30);
          expect(job!.history.at(-1)?.note).toBe('try 24');
        }));
    });
  });
}
