import { INITIAL_WORKFLOW } from '@tajir/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Orchestrator } from './services/orchestrator.js';
import { MAX_MESSAGES_PER_CONVERSATION } from './services/conversations.js';
import { createTestApp, signUp } from './test/helpers.js';

describe('conversations', () => {
  it('creates, lists and reads conversations', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const created = (await agent.post('/api/conversations').send({}).expect(201)).body.conversation;
    expect(created).toMatchObject({ title: 'New chat', status: 'active' });

    const named = (await agent.post('/api/conversations').send({ title: 'Company setup' }).expect(201)).body.conversation;
    const listed = (await agent.get('/api/conversations').expect(200)).body.conversations;
    expect(listed.map((c: { id: string }) => c.id).sort()).toEqual([created.id, named.id].sort());

    const read = (await agent.get(`/api/conversations/${created.id}`).expect(200)).body;
    expect(read.conversation.id).toBe(created.id);
    // A new chat opens with the assistant's welcome and the starting quick replies.
    expect(read.messages.map((m: { role: string; kind: string }) => `${m.role}:${m.kind}`)).toEqual(['assistant:text']);
    expect(read.quickReplies).toContain('Start a company');
    expect(read.workflow).toMatchObject({ type: null, step: 'intent' });
  });

  it('accepts an empty creation body but rejects unknown fields and long titles', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    await agent.post('/api/conversations').expect(201);
    await agent.post('/api/conversations').send({ title: 'x'.repeat(121) }).expect(400);
    await agent.post('/api/conversations').send({ title: 'ok', userId: 'someone-else' }).expect(400);
  });

  it('stores the user message and the assistant reply in order, and names the chat after the first message', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const { id } = (await agent.post('/api/conversations').send({}).expect(201)).body.conversation;

    const res = await agent.post(`/api/conversations/${id}/messages`).send({ text: '  Start a company  ' }).expect(201);
    expect(res.body.messages[0]).toMatchObject({ role: 'user', kind: 'text', text: 'Start a company' });
    expect(res.body.messages.slice(1).every((m: { role: string }) => m.role === 'assistant')).toBe(true);
    expect(res.body.messages.length).toBeGreaterThan(1);
    expect(res.body.conversation.title).toBe('Start a company');

    await agent.post(`/api/conversations/${id}/messages`).send({ text: 'Second message' }).expect(201);
    const read = (await agent.get(`/api/conversations/${id}`).expect(200)).body;
    expect(read.messages.map((m: { text: string | null }) => m.text).filter((t: string | null) => t === 'Start a company' || t === 'Second message')).toEqual(['Start a company', 'Second message']);
    // The title is set once and not rewritten by later messages.
    expect(read.conversation.title).toBe('Start a company');
  });

  it('puts the most recently used conversation first', async () => {
    let tick = 0;
    const { app } = await createTestApp({ clock: () => new Date(Date.UTC(2026, 10, 21, 10, 0, tick++)) });
    const agent = await signUp(app, 'a@example.com');
    const first = (await agent.post('/api/conversations').send({ title: 'First' }).expect(201)).body.conversation;
    const second = (await agent.post('/api/conversations').send({ title: 'Second' }).expect(201)).body.conversation;
    await agent.post(`/api/conversations/${first.id}/messages`).send({ text: 'hello' }).expect(201);
    const listed = (await agent.get('/api/conversations').expect(200)).body.conversations;
    expect(listed.map((c: { id: string }) => c.id)).toEqual([first.id, second.id]);
  });

  it.each([
    ['empty text', { text: '' }],
    ['blank text', { text: '    ' }],
    ['text over 500 characters', { text: 'x'.repeat(501) }],
    ['a missing field', {}],
    ['a non-string', { text: 42 }],
    ['an unknown field', { text: 'hi', role: 'assistant' }],
    ['text and an action together', { text: 'hi', action: { type: 'confirm', step: 'review' } }],
    ['an unknown action', { action: { type: 'delete_everything' } }],
    ['an unknown step', { action: { type: 'confirm', step: 'approved' } }],
    ['a malformed application reference', { action: { type: 'clarify', applicationId: '../../etc/passwd' } }],
    ['an extra field on an action', { action: { type: 'confirm', step: 'review', status: 'approved' } }],
  ])('rejects %s', async (_label, body) => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const { id } = (await agent.post('/api/conversations').send({}).expect(201)).body.conversation;
    await agent.post(`/api/conversations/${id}/messages`).send(body).expect(400);
    // Nothing was stored except the welcome message.
    expect((await agent.get(`/api/conversations/${id}`).expect(200)).body.messages).toHaveLength(1);
  });

  it("never reveals or writes to another user's conversation", async () => {
    const { app } = await createTestApp();
    const alice = await signUp(app, 'alice@example.com');
    const bob = await signUp(app, 'bob@example.com');
    const { id } = (await alice.post('/api/conversations').send({}).expect(201)).body.conversation;
    await alice.post(`/api/conversations/${id}/messages`).send({ text: 'private' }).expect(201);

    await bob.get(`/api/conversations/${id}`).expect(404);
    await bob.post(`/api/conversations/${id}/messages`).send({ text: 'intrusion' }).expect(404);
    expect((await bob.get('/api/conversations').expect(200)).body.conversations).toEqual([]);
    const messages = (await alice.get(`/api/conversations/${id}`).expect(200)).body.messages;
    expect(messages.map((m: { text: string }) => m.text)).not.toContain('intrusion');
  });

  it('treats unknown and malformed ids as not found', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    await agent.get('/api/conversations/not-an-id').expect(404);
    await agent.get('/api/conversations/0123456789abcdef01234567').expect(404);
    await agent.post('/api/conversations/not-an-id/messages').send({ text: 'hi' }).expect(404);
  });

  it('caps the length of one conversation', async () => {
    const { app, repos } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const { id } = (await agent.post('/api/conversations').send({}).expect(201)).body.conversation;
    const user = (await repos.users.findByEmail('a@example.com'))!;
    for (let i = 0; i < MAX_MESSAGES_PER_CONVERSATION; i += 1) {
      await repos.messages.append({ conversationId: id, userId: user.id, role: 'user', kind: 'text', text: String(i) });
    }
    await agent.post(`/api/conversations/${id}/messages`).send({ text: 'one too many' }).expect(409);
  });
});

describe('the assistant seam', () => {
  const orchestrator = (reply: Orchestrator['reply']): Orchestrator => ({ reply });
  const initial = () => ({ ...INITIAL_WORKFLOW, company: {}, finance: {} });
  const trace = { mode: 'rules' as const, provider: 'rules', applied: [], ignored: [], effects: 0, latencyMs: 0 };

  it('keeps the user message and returns 502 when the assistant fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app } = await createTestApp({
      orchestrator: orchestrator(async () => {
        throw new Error('model offline');
      }),
    });
    const agent = await signUp(app, 'a@example.com');
    const { id } = (await agent.post('/api/conversations').send({}).expect(201)).body.conversation;
    const res = await agent.post(`/api/conversations/${id}/messages`).send({ text: 'hello' }).expect(502);
    expect(res.body.error.message).toBe('The assistant is unavailable right now. Your message was saved.');
    expect(JSON.stringify(res.body)).not.toContain('model offline');
    const messages = (await agent.get(`/api/conversations/${id}`).expect(200)).body.messages;
    expect(messages.map((m: { role: string; text: string }) => [m.role, m.text]).filter(([role]: string[]) => role === 'user')).toEqual([['user', 'hello']]);
    expect(messages.filter((m: { role: string }) => m.role === 'assistant')).toHaveLength(1);
    error.mockRestore();
  });

  it('refuses to store an invalid reply from the assistant', async () => {
    const { app } = await createTestApp({
      orchestrator: orchestrator(async () => ({ messages: [{ kind: 'delete_everything' as never, text: 'x' }], workflow: initial(), quickReplies: [], trace })),
    });
    const agent = await signUp(app, 'a@example.com');
    const { id } = (await agent.post('/api/conversations').send({}).expect(201)).body.conversation;
    await agent.post(`/api/conversations/${id}/messages`).send({ text: 'hello' }).expect(502);
    const messages = (await agent.get(`/api/conversations/${id}`).expect(200)).body.messages;
    // Only the welcome and the user's own message are stored: the invalid reply was refused.
    expect(messages.map((m: { role: string }) => m.role)).toEqual(['assistant', 'user']);
  });

  it('stores the workflow state the backend returns, not anything the client sends', async () => {
    const { app } = await createTestApp({
      orchestrator: orchestrator(async () => ({
        messages: [{ kind: 'text', text: 'Which type of company?' }],
        workflow: { type: 'company_registration', step: 'registration_type', company: {}, finance: {} },
        quickReplies: ['Mainland'],
        trace,
      })),
    });
    const agent = await signUp(app, 'a@example.com');
    const { id } = (await agent.post('/api/conversations').send({}).expect(201)).body.conversation;
    await agent.post(`/api/conversations/${id}/messages`).send({ text: 'Start a company' }).expect(201);
    await agent.post(`/api/conversations/${id}/messages`).send({ text: 'x', workflow: { step: 'submitted' } }).expect(400);
    expect((await agent.get(`/api/conversations/${id}`)).body.workflow).toMatchObject({ type: 'company_registration', step: 'registration_type' });
  });

  it('answers with a safe fallback from the deterministic rules, without any AI call', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const { id } = (await agent.post('/api/conversations').send({}).expect(201)).body.conversation;
    const res = await agent.post(`/api/conversations/${id}/messages`).send({ text: 'anything' }).expect(201);
    expect(res.body.messages[1]).toMatchObject({ role: 'assistant', kind: 'text' });
    expect(res.body.messages[1].text).toContain('did not quite get that');
    expect(res.body.assistant.mode).toBe('rules');
  });
});
