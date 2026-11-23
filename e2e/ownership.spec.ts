import { expect, PASSWORD, test, uniqueEmail } from './fixtures';

/** A browser with no session. (Contexts made inside a test otherwise start with the test account's cookie.) */
const SIGNED_OUT = { cookies: [], origins: [] };

/** One person's data is invisible to another person and to a visitor, in the pages and in the API. */
test('another account and a visitor cannot see or change someone else\'s data', async ({ browser, baseURL, account }) => {
  const origin = { Origin: baseURL ?? '' };

  // The owner has an application, a document and a conversation.
  const owner = await browser.newContext({ baseURL, storageState: account.state as never });
  const created = await owner.request.post('/api/applications', { data: { service: 'working_capital_finance', finance: { amount: 120000, purpose: 'Payroll' } } });
  expect(created.status()).toBe(201);
  const reference = (await created.json()).application.id as string;
  const statusBefore = (await created.json()).application.status as string;
  const pdf = Buffer.from(['%PDF-1.4', '% owner file', '%%EOF'].join('\n'));
  // A stored document that is not tied to an application. (The shared account may already have the
  // document a new request would ask for, so nothing here depends on a requirement being open.)
  const uploaded = await owner.request.post('/api/documents/upload', {
    multipart: { typeId: 'passport', file: { name: 'owner.pdf', mimeType: 'application/pdf', buffer: pdf } },
  });
  expect(uploaded.status()).toBe(201);
  const documentId = (await uploaded.json()).document.id as string;
  const conversations = (await (await owner.request.get('/api/conversations')).json()).conversations as Array<{ id: string }>;
  const conversationId = conversations[0]?.id ?? (await (await owner.request.post('/api/conversations', { data: {} })).json()).conversation.id;

  // A second person signs up in a separate browser.
  const intruder = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
  const signUp = await intruder.request.post('/api/auth/register', { data: { name: 'Omar Farouk', email: uniqueEmail('intruder'), password: PASSWORD }, headers: origin });
  expect(signUp.status()).toBe(201);
  const page = await intruder.newPage();

  // Pages: the application is simply not found, and the lists are empty.
  await page.goto(`/applications/${reference}`);
  await expect(page.getByText('Application not found')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('120,000');
  await page.goto('/applications');
  await expect(page.getByText('No applications yet')).toBeVisible();
  await page.goto('/documents');
  await expect(page.getByText('No documents yet')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('owner.pdf');

  // API: every route answers "not found" for someone else's records, and refuses writes.
  const api = intruder.request;
  expect((await api.get(`/api/applications/${reference}`)).status()).toBe(404);
  expect((await api.get(`/api/applications/${reference}/documents`)).status()).toBe(404);
  expect((await api.patch(`/api/applications/${reference}`, { data: { action: 'simulate_next' } })).status()).toBe(404);
  expect((await api.patch(`/api/applications/${reference}`, { data: { action: 'provide_information', requirementId: 'req-annual_turnover', value: 'x' } })).status()).toBe(404);
  expect((await api.get(`/api/conversations/${conversationId}`)).status()).toBe(404);
  expect((await api.post(`/api/conversations/${conversationId}/messages`, { data: { text: 'hello' } })).status()).toBe(404);
  expect((await api.patch(`/api/conversations/${conversationId}/draft`, { data: { company: { companyName: 'Hijacked' } } })).status()).toBe(404);
  expect((await (await api.get('/api/documents')).json()).documents).toEqual([]);
  expect((await (await api.get('/api/applications')).json()).applications).toEqual([]);
  // The owner's document file and details: not found, whichever way they are asked for.
  for (const suffix of ['', '/status', '/view', '/download']) {
    expect((await api.get(`/api/documents/${documentId}${suffix}`)).status(), `document${suffix}`).toBe(404);
  }
  expect((await api.post(`/api/documents/${documentId}/reprocess`)).status()).toBe(404);
  expect((await api.delete(`/api/documents/${documentId}`)).status()).toBe(404);
  // A forged document id in a chat action reaches nothing either.
  const conversation = (await (await api.post('/api/conversations', { data: {} })).json()).conversation.id as string;
  expect((await api.post(`/api/conversations/${conversation}/messages`, { data: { action: { type: 'document_uploaded', documentId } } })).status()).toBe(404);
  // Uploading a document "for" the owner's application is refused too.
  const hijack = await api.post('/api/documents/upload', {
    multipart: { typeId: 'bank_statement_6m', applicationId: reference, requirementId: 'req-bank_statement_6m', file: { name: 'x.pdf', mimeType: 'application/pdf', buffer: pdf } },
  });
  expect(hijack.status()).toBe(404);
  // A forged id in a chat action reaches nothing either.
  const clarify = await api.post(`/api/conversations/${(await (await api.post('/api/conversations', { data: {} })).json()).conversation.id}/messages`, { data: { action: { type: 'clarify', applicationId: reference } } });
  expect(clarify.status()).toBe(404);

  // A visitor with no session gets nothing.
  const visitor = await browser.newContext({ baseURL, storageState: SIGNED_OUT });
  for (const url of ['/api/applications', `/api/applications/${reference}`, '/api/documents', `/api/documents/${documentId}`, `/api/documents/${documentId}/download`, `/api/documents/${documentId}/view`, '/api/conversations', '/api/auth/me']) {
    expect((await visitor.request.get(url)).status(), url).toBe(401);
  }
  expect((await visitor.request.post('/api/documents/upload', { multipart: { typeId: 'passport', file: { name: 'a.pdf', mimeType: 'application/pdf', buffer: pdf } } })).status()).toBe(401);

  // The owner still has everything, unchanged.
  const mine = (await (await owner.request.get(`/api/applications/${reference}`)).json()).application;
  expect(mine.status).toBe(statusBefore);
  expect(mine.details.some((d: { value: string }) => d.value === 'Hijacked')).toBe(false);
  expect(((await (await owner.request.get('/api/documents')).json()).documents as Array<{ id: string }>).some((d) => d.id === documentId)).toBe(true);
  // ...including the file itself, which the intruder's attempts did not touch.
  const stillThere = await owner.request.get(`/api/documents/${documentId}/download`);
  expect(stillThere.status()).toBe(200);
  expect((await stillThere.body()).subarray(0, 5).toString()).toBe('%PDF-');

  await Promise.all([owner.close(), intruder.close(), visitor.close()]);
});

test('a request from another website is refused', async ({ page, baseURL }) => {
  await page.goto('/dashboard');
  const refused = await page.request.post('/api/conversations', { data: {}, headers: { Origin: 'http://evil.example' } });
  expect(refused.status()).toBe(403);
  const own = await page.request.post('/api/conversations', { data: {}, headers: { Origin: baseURL ?? '' } });
  expect(own.status()).toBe(201);
});
