import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AUTH_COOKIE } from './middleware/auth.js';
import { agentFor, createTestApp, PASSWORD, signUp, testConfig } from './test/helpers.js';

const register = (agent: ReturnType<typeof agentFor>, body: Record<string, unknown>) => agent.post('/api/auth/register').send(body);
const valid = { name: 'Ahmed Al Mansoori', email: 'ahmed@example.com', password: PASSWORD, company: 'ABC Trading LLC' };

describe('registration', () => {
  it('creates an account, signs the user in with a secure cookie, and never returns the password hash', async () => {
    const { app, repos } = await createTestApp();
    const res = await register(agentFor(app), valid).expect(201);

    expect(res.body.user).toMatchObject({ name: 'Ahmed Al Mansoori', email: 'ahmed@example.com', company: 'ABC Trading LLC' });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);

    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith(`${AUTH_COOKIE}=`))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=\d+/);

    // The password is stored only as a bcrypt hash.
    const stored = await repos.users.findByEmail('ahmed@example.com');
    expect(stored?.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(stored?.passwordHash).not.toContain(PASSWORD);
    expect((await repos.businessProfiles.findPrimaryCompany(stored!.id))?.name).toBe('ABC Trading LLC');
  });

  it('marks the cookie Secure when configured for production', async () => {
    const { app } = await createTestApp({ config: { cookieSecure: true } });
    const res = await register(agentFor(app), valid).expect(201);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/Secure/i);
  });

  it('normalises the email, so the same address in another case is a duplicate', async () => {
    const { app } = await createTestApp();
    await register(agentFor(app), valid).expect(201);
    const again = await register(agentFor(app), { ...valid, email: ' AHMED@Example.COM ' }).expect(409);
    expect(again.body.error.message).toBe('An account with this email already exists');
  });

  it.each([
    ['a short password', { password: 'short1' }, 'password'],
    ['a password longer than bcrypt can use', { password: 'x'.repeat(73) }, 'password'],
    ['a common password', { password: 'password1' }, 'password'],
    ['a password equal to the email', { email: 'ahmed@example.com', password: 'ahmed@example.com' }, 'password'],
    ['an invalid email', { email: 'not-an-email' }, 'email'],
    ['a missing name', { name: '' }, 'name'],
    ['an overlong company', { company: 'x'.repeat(121) }, 'company'],
  ])('rejects %s', async (_label, overrides, field) => {
    const { app } = await createTestApp();
    const res = await register(agentFor(app), { ...valid, ...overrides }).expect(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(field);
  });

  it('rejects unknown fields instead of ignoring them', async () => {
    const { app } = await createTestApp();
    const res = await register(agentFor(app), { ...valid, isAdmin: true }).expect(400);
    expect(res.body.error.message).toBe('Validation failed');
  });
});

describe('sign in', () => {
  it('signs in with the right password and sets a new session', async () => {
    const { app } = await createTestApp();
    await signUp(app, 'ahmed@example.com');
    const agent = agentFor(app);
    const res = await agent.post('/api/auth/login').send({ email: 'AHMED@example.com', password: PASSWORD }).expect(200);
    expect(res.body.user).toMatchObject({ email: 'ahmed@example.com', company: 'ABC Trading LLC' });
    await agent.get('/api/auth/me').expect(200);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const { app } = await createTestApp();
    await signUp(app, 'ahmed@example.com');
    const wrong = await agentFor(app).post('/api/auth/login').send({ email: 'ahmed@example.com', password: 'not the password' }).expect(401);
    const unknown = await agentFor(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: PASSWORD }).expect(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.message).toBe('Invalid email or password');
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('limits repeated attempts for the same account', async () => {
    const { app } = await createTestApp({ limits: { login: 3 } });
    await signUp(app, 'ahmed@example.com');
    const attempt = () => agentFor(app).post('/api/auth/login').send({ email: 'ahmed@example.com', password: 'wrong password' });
    for (let i = 0; i < 3; i += 1) await attempt().expect(401);
    const blocked = await attempt().expect(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    // A different account is not affected.
    await agentFor(app).post('/api/auth/login').send({ email: 'other@example.com', password: 'wrong password' }).expect(401);
  });
});

describe('the session', () => {
  it('returns the current user, and 401 without a session', async () => {
    const { app } = await createTestApp();
    await agentFor(app).get('/api/auth/me').expect(401);
    const agent = await signUp(app, 'ahmed@example.com');
    const res = await agent.get('/api/auth/me').expect(200);
    expect(res.body.user.email).toBe('ahmed@example.com');
  });

  it('ends the session on sign out', async () => {
    const { app } = await createTestApp();
    const agent = await signUp(app, 'ahmed@example.com');
    const out = await agent.post('/api/auth/logout').expect(204);
    expect((out.headers['set-cookie'] as unknown as string[])[0]).toMatch(new RegExp(`${AUTH_COOKIE}=;`));
    await agent.get('/api/auth/me').expect(401);
  });

  it('rejects tokens that are forged, tampered with, expired or signed with another algorithm', async () => {
    const { app, repos } = await createTestApp();
    await signUp(app, 'ahmed@example.com');
    const user = (await repos.users.findByEmail('ahmed@example.com'))!;
    const { jwtSecret } = testConfig();
    const send = (token: string) => request(app).get('/api/auth/me').set('Cookie', `${AUTH_COOKIE}=${token}`);

    const good = jwt.sign({}, jwtSecret, { subject: user.id, expiresIn: 60, algorithm: 'HS256' });
    await send(good).expect(200);

    await send(jwt.sign({}, 'a different secret entirely, long enough', { subject: user.id, algorithm: 'HS256' })).expect(401);
    await send(jwt.sign({}, jwtSecret, { subject: user.id, expiresIn: -10, algorithm: 'HS256' })).expect(401);
    await send(jwt.sign({}, jwtSecret, { subject: user.id, algorithm: 'HS512' })).expect(401);
    await send(jwt.sign({}, '', { subject: user.id, algorithm: 'none' } as jwt.SignOptions)).expect(401);
    await send(`${good.slice(0, -4)}AAAA`).expect(401);
    await send('garbage').expect(401);
    await send(jwt.sign({}, jwtSecret, { algorithm: 'HS256' })).expect(401); // no subject
  });

  it('stops honouring a token once the account is gone', async () => {
    const { app, repos } = await createTestApp();
    const agent = await signUp(app, 'ahmed@example.com');
    const ghost = jwt.sign({}, testConfig().jwtSecret, { subject: 'a-user-that-does-not-exist', algorithm: 'HS256' });
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${ghost}`).expect(401);
    await agent.get('/api/auth/me').expect(200);
    expect(await repos.users.findById('a-user-that-does-not-exist')).toBeNull();
  });

  it('accepts a bearer token as well as the cookie', async () => {
    const { app, repos } = await createTestApp();
    await signUp(app, 'ahmed@example.com');
    const user = (await repos.users.findByEmail('ahmed@example.com'))!;
    const token = jwt.sign({}, testConfig().jwtSecret, { subject: user.id, algorithm: 'HS256', expiresIn: 60 });
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
    await request(app).get('/api/auth/me').set('Authorization', 'Bearer ').expect(401);
    await request(app).get('/api/auth/me').set('Authorization', `Basic ${token}`).expect(401);
  });
});

describe('every protected route requires a session', () => {
  it.each([
    ['get', '/api/services'],
    ['get', '/api/services/company_registration'],
    ['post', '/api/applications'],
    ['get', '/api/applications'],
    ['get', '/api/applications/REG-2026-000001'],
    ['patch', '/api/applications/REG-2026-000001'],
    ['get', '/api/applications/REG-2026-000001/documents'],
    ['post', '/api/documents/upload'],
    ['get', '/api/documents'],
    ['post', '/api/conversations'],
    ['get', '/api/conversations'],
    ['get', '/api/conversations/abc'],
    ['post', '/api/conversations/abc/messages'],
  ] as const)('%s %s returns 401', async (method, path) => {
    const { app } = await createTestApp();
    await request(app)[method](path).expect(401);
  });
});
