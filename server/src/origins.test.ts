import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { isAllowedOrigin, normaliseOrigin, parseClientOrigins } from './middleware/origins.js';
import { agentFor, createTestApp, PASSWORD, signUp } from './test/helpers.js';

describe('reading the CLIENT_ORIGIN setting', () => {
  it('accepts one origin, with or without a trailing slash', () => {
    expect(parseClientOrigins('http://localhost:5173', 'production')).toEqual(['http://localhost:5173']);
    expect(parseClientOrigins('https://app.example.com/', 'production')).toEqual(['https://app.example.com']);
  });

  it('accepts several, separated by commas, ignoring blanks and repeats', () => {
    expect(parseClientOrigins(' https://a.example.com , https://b.example.com,, https://a.example.com/ ', 'production')).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('adds the other spelling of a local address in development, on the same port only', () => {
    expect(parseClientOrigins('http://localhost:5173', 'development').sort()).toEqual(['http://127.0.0.1:5173', 'http://localhost:5173']);
    expect(parseClientOrigins('http://127.0.0.1:3000', 'test').sort()).toEqual(['http://127.0.0.1:3000', 'http://localhost:3000']);
  });

  it('does not add anything in production, and never widens the port or the scheme', () => {
    expect(parseClientOrigins('http://localhost:5173', 'production')).toEqual(['http://localhost:5173']);
    const dev = parseClientOrigins('http://localhost:5173', 'development');
    expect(dev.some((o) => o.endsWith(':5174'))).toBe(false);
    expect(dev.some((o) => o.startsWith('https:'))).toBe(false);
    expect(parseClientOrigins('https://app.example.com', 'development')).toEqual(['https://app.example.com']);
  });

  it.each([
    ['a path', 'http://localhost:5173/app'],
    ['a query', 'http://localhost:5173/?x=1'],
    ['a login', 'http://user:pw@localhost:5173'],
    ['a wildcard', '*'],
    ['a wildcard host', 'https://*.example.com'],
    ['another scheme', 'ftp://example.com'],
    ['nothing at all', '   '],
    ['not a URL', 'localhost:5173 please'],
  ])('refuses %s instead of guessing', (_label, value) => {
    expect(() => parseClientOrigins(value, 'development')).toThrow(/CLIENT_ORIGIN/);
  });

  it('normalises an origin and rejects anything that is not one', () => {
    expect(normaliseOrigin('HTTP://LocalHost:5173/')).toBe('http://localhost:5173');
    expect(normaliseOrigin('http://localhost:5173/path')).toBeNull();
    expect(normaliseOrigin('null')).toBeNull();
  });

  it('matches exactly: no prefixes, no subdomains, no other ports', () => {
    const allowed = ['http://localhost:5173'];
    expect(isAllowedOrigin('http://localhost:5173', allowed)).toBe(true);
    for (const other of ['http://localhost:51730', 'http://localhost:5174', 'http://localhost:5173.evil.example', 'http://evil.localhost:5173', 'https://localhost:5173', 'null', '']) {
      expect(isAllowedOrigin(other, allowed), other).toBe(false);
    }
    expect(isAllowedOrigin(undefined, allowed)).toBe(false);
  });
});

describe('the API with the real origin rules', () => {
  const LOCAL = 'http://localhost:5173';
  const TWIN = 'http://127.0.0.1:5173';

  it('accepts writes from the website at either spelling of the local address, with a session', async () => {
    const { app } = await createTestApp();
    for (const origin of [LOCAL, TWIN]) {
      const agent = agentFor(app);
      await agent.post('/api/auth/register').set('Origin', origin).send({ name: 'Test User', email: `${origin.includes('127') ? 'a' : 'b'}@example.com`, password: PASSWORD }).expect(201);
      const conversation = (await agent.post('/api/conversations').set('Origin', origin).send({}).expect(201)).body;
      await agent.post(`/api/conversations/${conversation.conversation.id}/messages`).set('Origin', origin).send({ text: 'hello' }).expect(201);
    }
  });

  it('signs in from the website too', async () => {
    const { app } = await createTestApp();
    await signUp(app, 'login@example.com');
    const agent = agentFor(app);
    await agent.post('/api/auth/login').set('Origin', TWIN).send({ email: 'login@example.com', password: PASSWORD }).expect(200);
    await agent.post('/api/auth/login').set('Origin', LOCAL).send({ email: 'login@example.com', password: 'wrong password' }).expect(401);
  });

  it.each([
    ['another port on localhost', 'http://localhost:5174'],
    ['another port on 127.0.0.1', 'http://127.0.0.1:5175'],
    ['another website', 'https://evil.example'],
    ['a look-alike host', 'http://localhost.evil.example:5173'],
    ['https on the same host', 'https://localhost:5173'],
    ['a null origin', 'null'],
  ])('refuses a write from %s, even with a valid session', async (_label, origin) => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'a@example.com');
    const res = await agent.post('/api/conversations').set('Origin', origin).send({}).expect(403);
    expect(res.body.error.message).toContain('Origin not allowed');
    await agent.post('/api/auth/login').set('Origin', origin).send({ email: 'a@example.com', password: PASSWORD }).expect(403);
  });

  it('says in development which address the page is on and which are accepted', async () => {
    const { app } = await createTestApp();
    const res = await request(app).post('/api/auth/login').set('Origin', 'http://localhost:5174').send({ email: 'a@example.com', password: 'x' }).expect(403);
    expect(res.body.error.message).toContain('http://localhost:5174');
    expect(res.body.error.message).toContain('http://localhost:5173');
    expect(res.body.error.message).toContain('CLIENT_ORIGIN');
  });

  it('keeps the refusal short in production and does not list the accepted origins', async () => {
    const { app } = await createTestApp({ config: { nodeEnv: 'production', clientOrigins: ['https://app.example.com'] } });
    const res = await request(app).post('/api/auth/login').set('Origin', 'https://evil.example').send({ email: 'a@example.com', password: 'x' }).expect(403);
    expect(res.body.error.message).toBe('Origin not allowed');
    expect(JSON.stringify(res.body)).not.toContain('app.example.com');
  });

  describe('CORS headers and preflight', () => {
    it('names only the page that asked, only if it is on the list, and allows its cookie', async () => {
      const { app } = await createTestApp();
      for (const origin of [LOCAL, TWIN]) {
        const res = await request(app).get('/api/health').set('Origin', origin);
        expect(res.headers['access-control-allow-origin']).toBe(origin);
        expect(res.headers['access-control-allow-credentials']).toBe('true');
      }
    });

    it('never answers with a wildcard, and gives other pages no permission at all', async () => {
      const { app } = await createTestApp();
      for (const origin of ['http://localhost:5174', 'https://evil.example', undefined]) {
        const req = request(app).get('/api/health');
        const res = origin ? await req.set('Origin', origin) : await req;
        expect(res.headers['access-control-allow-origin']).not.toBe('*');
        if (origin) expect(res.headers['access-control-allow-origin']).toBeUndefined();
      }
    });

    it('answers the preflight for a chat POST from the website, with credentials and the headers it needs', async () => {
      const { app } = await createTestApp();
      const res = await request(app)
        .options('/api/conversations/abc/messages')
        .set('Origin', LOCAL)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type')
        .expect(204);
      expect(res.headers['access-control-allow-origin']).toBe(LOCAL);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
      expect(res.headers['access-control-allow-headers']?.toLowerCase()).toContain('content-type');
    });

    it('gives a preflight from another page no permission', async () => {
      const { app } = await createTestApp();
      for (const origin of ['http://localhost:5174', 'https://evil.example']) {
        const res = await request(app).options('/api/conversations/abc/messages').set('Origin', origin).set('Access-Control-Request-Method', 'POST');
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      }
    });
  });

  it('still lets scripts and tools without an Origin header through, because they are not browser pages', async () => {
    const { app } = await createTestApp();
    await signUp(app, 'script@example.com');
    await request(app).post('/api/auth/login').send({ email: 'script@example.com', password: PASSWORD }).expect(200);
  });
});
