import { describe, expect, it } from 'vitest';
import type { AiProvider, GenerateRequest, LlmProvider } from './ai/types.js';
import { Chat } from './chat.test-support.js';
import { NOT_FOUND_REPLY } from './documentChat/answer.js';
import { createExtractionProcessor } from './extraction/pipeline.js';
import { createDocumentJobs } from './jobs/documentJobs.js';
import { createMemoryRepositories } from './repositories/memory.js';
import { createMemoryStorage } from './storage/memory.js';
import { buildPdf, TRADE_LICENCE_LINES } from './test/files.js';
import { createTestApp, pdf, signUp, upload } from './test/helpers.js';

async function appWithDocuments(ai?: AiProvider) {
  const repos = createMemoryRepositories();
  const storage = createMemoryStorage();
  const jobs = createDocumentJobs({
    repos,
    processor: createExtractionProcessor({ repos, storageFor: (name) => (name === storage.name ? storage : undefined), ocr: null, maxBytes: 1024 * 1024 }),
    log: () => undefined,
  });
  const ctx = await createTestApp({ repos, storage, documentJobs: jobs, ai });
  return { ...ctx, jobs };
}

const licence = () => buildPdf([{ lines: TRADE_LICENCE_LINES }]);

describe('asking the chat about your own documents', () => {
  it('answers from the document, names it, and changes nothing about the conversation', async () => {
    const { app, jobs } = await appWithDocuments();
    const agent = await signUp(app, 'a@example.com');
    await upload(agent, { buffer: licence(), filename: 'Trade Licence 2026.pdf' }, { typeId: 'trade_licence' }).expect(201);
    await jobs.drain();

    const chat = await Chat.start(agent);
    const before = JSON.stringify(chat.workflow);
    await chat.say('What is the expiry date on my trade licence?');
    expect(chat.text).toContain('31/01/2027');
    expect(chat.last[0]!.payload).toEqual({ sources: [{ documentId: expect.any(String), name: 'Trade Licence 2026.pdf', page: 1 }] });
    // No application was created, and the guided flow is exactly where it was.
    expect(JSON.stringify(chat.workflow)).toBe(before);
    expect((await agent.get('/api/applications').expect(200)).body.applications).toEqual([]);
  });

  it('says it could not find what the documents do not hold', async () => {
    const { app, jobs } = await appWithDocuments();
    const agent = await signUp(app, 'a@example.com');
    await upload(agent, { buffer: licence(), filename: 'licence.pdf' }, { typeId: 'trade_licence' }).expect(201);
    await jobs.drain();
    const chat = await Chat.start(agent);
    await chat.say('What is the rent in my tenancy contract?');
    expect(chat.text).toBe(NOT_FOUND_REPLY);
    expect(chat.last[0]!.payload).toBeNull();
  });

  it('lists what has been uploaded and how far each is', async () => {
    const { app, jobs } = await appWithDocuments();
    const agent = await signUp(app, 'a@example.com');
    await upload(agent, { buffer: licence(), filename: 'licence.pdf' }, { typeId: 'trade_licence' }).expect(201);
    await jobs.drain();
    await upload(agent, { buffer: pdf('another'), filename: 'second.pdf' }, { typeId: 'other' }).expect(201);
    const chat = await Chat.start(agent);
    await chat.say('Which documents have I uploaded?');
    expect(chat.text).toContain('licence.pdf (read)');
    expect(chat.text).toContain('second.pdf (waiting to be read)');
  });

  it('says what an application is still waiting for', async () => {
    const { app } = await appWithDocuments();
    const agent = await signUp(app, 'a@example.com');
    await upload(agent, { buffer: pdf('x'), filename: 'x.pdf' }, { typeId: 'other' }).expect(201);
    const created = (await agent.post('/api/applications').send({ service: 'company_registration', company: { registrationType: 'free_zone', jurisdictionId: 'shams', packageId: 'shams-starter', companyName: 'Vinith Media', activity: 'Media & Marketing', category: 'Media & Advertising', shareholders: 1 } }).expect(201)).body.application;
    const chat = await Chat.start(agent);
    await chat.say('Which documents are still needed?');
    expect(chat.text).toContain('Passport copy');
    expect(chat.text).toContain(created.id);
  });

  it('keeps a guided step where it was, and does not take a company name for a question', async () => {
    const { app } = await appWithDocuments();
    const agent = await signUp(app, 'a@example.com');
    const chat = await Chat.start(agent);
    await chat.say('I want to register a company');
    const step = chat.workflow.step;
    await chat.say('Which documents have I uploaded?');
    expect(chat.workflow.step).toBe(step);
    expect(chat.text).toContain("haven't uploaded any documents");
    // An ordinary message in the flow still goes the ordinary way.
    await chat.say('Passport Services LLC');
    expect(chat.text).not.toContain('uploaded');
  });

  it('does not take questions about requirements for questions about your documents', async () => {
    const { app, jobs } = await appWithDocuments();
    const agent = await signUp(app, 'a@example.com');
    await upload(agent, { buffer: licence(), filename: 'licence.pdf' }, { typeId: 'trade_licence' }).expect(201);
    await jobs.drain();
    const chat = await Chat.start(agent);
    await chat.say('What documents do I need for a free zone company?');
    expect(chat.text).not.toBe(NOT_FOUND_REPLY);
    expect(chat.text).not.toContain('licence.pdf');
    expect(chat.last[0]!.payload).toBeNull();
  });

  it('never shows one user another user’s documents', async () => {
    const { app, jobs } = await appWithDocuments();
    const alice = await signUp(app, 'alice@example.com');
    const bob = await signUp(app, 'bob@example.com');
    await upload(alice, { buffer: licence(), filename: 'alices-licence.pdf' }, { typeId: 'trade_licence' }).expect(201);
    await jobs.drain();
    const bobChat = await Chat.start(bob);
    await bobChat.say('What is the licence number in my trade licence?');
    expect(bobChat.text).toContain("haven't uploaded any documents");
    expect(bobChat.text).not.toContain('1234567');
    await bobChat.say('Which documents have I uploaded?');
    expect(bobChat.text).not.toContain('alices-licence');
  });

  it('with a model, the model writes the answer from excerpts only, and is never asked to interpret the question as a workflow turn', async () => {
    const seen: GenerateRequest[] = [];
    let interprets = 0;
    const ai: LlmProvider = {
      kind: 'llm',
      name: 'gemini',
      label: 'gemini (m)',
      interpret: async () => { interprets += 1; throw new Error('should not be asked'); },
      generate: async (r) => (seen.push(r), { found: true, answer: 'The licence shows an expiry date of 31/01/2027.', citations: [1] }),
    };
    const { app, jobs } = await appWithDocuments(ai);
    const agent = await signUp(app, 'a@example.com');
    await upload(agent, { buffer: licence(), filename: 'licence.pdf' }, { typeId: 'trade_licence' }).expect(201);
    await jobs.drain();
    // The document was read by the model too (its reading ran as part of processing), so start counting from here.
    seen.length = 0;
    const chat = await Chat.start(agent);
    await chat.say('When does my trade licence expire?');
    expect(chat.text).toBe('The licence shows an expiry date of 31/01/2027. (from licence.pdf)');
    expect(chat.mode).toBe('ai');
    expect(interprets).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.schemaName).toBe('document_answer');
  });
});

describe('attaching a document in the chat', () => {
  it('acknowledges it with a card that follows its progress', async () => {
    const { app } = await appWithDocuments();
    const agent = await signUp(app, 'a@example.com');
    const doc = (await upload(agent, { buffer: licence(), filename: 'licence.pdf' }, { typeId: 'trade_licence' }).expect(201)).body.document;
    const chat = await Chat.start(agent);
    const before = JSON.stringify(chat.workflow);
    await chat.act({ type: 'document_uploaded', documentId: doc.id });
    expect(chat.last.map((m) => m.kind)).toEqual(['document', 'text']);
    expect(chat.last[0]!.payload).toEqual({ documentId: doc.id, name: 'licence.pdf', typeLabel: 'Trade licence', status: 'queued' });
    expect(chat.last[1]!.text).toContain('licence.pdf');
    expect(JSON.stringify(chat.workflow)).toBe(before);

    // It is stored with the conversation, so it is still there when the chat is opened again.
    const reopened = (await agent.get(`/api/conversations/${chat.id}`).expect(200)).body.messages;
    expect(reopened.some((m: { kind: string }) => m.kind === 'document')).toBe(true);
  });

  it('refuses a document that is not the user’s, one that does not exist, and a malformed id', async () => {
    const { app } = await appWithDocuments();
    const alice = await signUp(app, 'alice@example.com');
    const bob = await signUp(app, 'bob@example.com');
    const doc = (await upload(alice, { buffer: licence(), filename: 'licence.pdf' }, { typeId: 'trade_licence' }).expect(201)).body.document;
    const chat = await Chat.start(bob);
    await chat.act({ type: 'document_uploaded', documentId: doc.id }, 404);
    await chat.act({ type: 'document_uploaded', documentId: 'f0f0f0f0-0000-0000-0000-000000000000' }, 404);
    await chat.act({ type: 'document_uploaded', documentId: '../../etc/passwd' }, 400);
    await chat.act({ type: 'document_uploaded', documentId: 'abc', extra: 1 }, 400);
  });
});
