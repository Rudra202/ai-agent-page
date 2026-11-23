import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createProviderChain } from './ai/chain.js';
import { rulesProvider } from './ai/types.js';
import type { LlmProvider } from './ai/types.js';
import { waitingApp } from './waitingApp.js';

const model = (name: string): LlmProvider => ({ kind: 'llm', name, interpret: async () => { throw new Error('not used'); } });

describe('the server while its database is not connected', () => {
  const reasonText = 'The database is not connected. Add this IP in Atlas.';
  const app = (reason = () => reasonText) => waitingApp(createProviderChain([model('gemini'), model('openai')]), 'local', reason);

  it('says the database is unavailable instead of pretending to work', async () => {
    const res = await request(app()).get('/api/health').expect(200);
    expect(res.body).toMatchObject({ status: 'degraded', db: 'unavailable', ai: 'gemini', aiBackup: 'openai', storage: 'local', detail: reasonText });
  });

  it.each([
    ['GET', '/api/auth/me'],
    ['POST', '/api/auth/login'],
    ['POST', '/api/auth/register'],
    ['GET', '/api/applications'],
    ['GET', '/api/documents'],
    ['POST', '/api/documents/upload'],
    ['POST', '/api/conversations'],
    ['POST', '/api/conversations/abc/messages'],
  ])('refuses %s %s with 503 and the reason, and stores nothing', async (method, path) => {
    const res = await (request(app()) as unknown as Record<string, (p: string) => request.Test>)[method.toLowerCase()]!(path).send({ email: 'a@b.co', password: 'x' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { message: reasonText } });
  });

  it('reports the built-in rules when no model is configured', async () => {
    const res = await request(waitingApp(rulesProvider, 'local', () => reasonText)).get('/api/health');
    expect(res.body).toMatchObject({ ai: 'rules', aiBackup: null });
  });

  it('reads the reason each time, so a changed reason is picked up', async () => {
    let reason = 'first';
    const instance = app(() => reason);
    expect((await request(instance).get('/api/applications')).body.error.message).toBe('first');
    reason = 'second';
    expect((await request(instance).get('/api/applications')).body.error.message).toBe('second');
  });

  it('does not leak the framework or serve anything outside the API', async () => {
    const res = await request(app()).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    await request(app()).get('/secrets.txt').expect(404);
  });
});
