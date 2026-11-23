import { describe, expect, it, vi } from 'vitest';
import { ApiError, createHttp } from './http';
import { createHttpApi } from './httpApi';

type FetchFn = typeof fetch;

const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>, extra: Parameters<typeof createHttp>[0] = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as unknown as FetchFn;
  return { http: createHttp({ fetchImpl, ...extra }), calls };
}

describe('requests', () => {
  it('sends JSON with the session cookie and reads JSON back', async () => {
    const { http, calls } = setup(() => reply(200, { ok: true }));
    await expect(http.request('POST', '/api/x', { a: 1 })).resolves.toEqual({ ok: true });
    expect(calls[0]!.init.credentials).toBe('include');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.body).toBe('{"a":1}');
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('sends a file as multipart and lets the browser set the content type', async () => {
    const { http, calls } = setup(() => reply(201, { ok: true }));
    const form = new FormData();
    form.append('file', new File(['x'], 'a.pdf'));
    await http.request('POST', '/api/documents/upload', form);
    expect(calls[0]!.init.body).toBe(form);
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('treats 204 as success with no body', async () => {
    const { http } = setup(() => new Response(null, { status: 204 }));
    await expect(http.request('POST', '/api/auth/logout')).resolves.toBeUndefined();
  });

  it('never puts a secret in the URL or headers', async () => {
    const { http, calls } = setup(() => reply(200, {}));
    await http.request('POST', '/api/auth/login', { email: 'a@b.co', password: 'pw-secret-1' });
    expect(calls[0]!.url).not.toContain('pw-secret-1');
    expect(JSON.stringify(calls[0]!.init.headers)).not.toContain('pw-secret-1');
  });
});

describe('errors', () => {
  it('uses the message the server sent', async () => {
    const { http } = setup(() => reply(409, { error: { message: 'An account with this email already exists' } }));
    const error = (await http.request('POST', '/api/auth/register', {}).catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(error.message).toBe('An account with this email already exists');
  });

  it('shows the first field message for a validation failure', async () => {
    const { http } = setup(() => reply(400, { error: { message: 'Validation failed', details: [{ path: 'company.shareholders', message: 'At least one shareholder is required' }] } }));
    await expect(http.request('PATCH', '/x', {})).rejects.toMatchObject({ status: 400, message: 'At least one shareholder is required' });
  });

  it('keeps the rate-limit message', async () => {
    const { http } = setup(() => reply(429, { error: { message: 'Too many uploads. Please try again later.' } }));
    await expect(http.request('POST', '/x', {})).rejects.toMatchObject({ status: 429, message: 'Too many uploads. Please try again later.' });
  });

  it('gives a plain message when the answer is not JSON, such as a proxy error page', async () => {
    const { http } = setup(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const error = (await http.request('GET', '/x').catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(502);
    expect(error.message).toBe('Something went wrong. Please try again.');
    expect(error.message).not.toContain('html');
  });

  it('says the server could not be reached when the network fails', async () => {
    const { http } = setup(() => {
      throw new TypeError('Failed to fetch');
    });
    const error = (await http.request('GET', '/x').catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({ status: 0, message: 'Could not reach the server. Check your connection and try again.' });
  });

  it('gives up on a request that takes too long', async () => {
    const { http } = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      { timeoutMs: 20 },
    );
    await expect(http.request('GET', '/x')).rejects.toMatchObject({ status: 0 });
  });

  it('does not repeat server internals', async () => {
    const { http } = setup(() => reply(500, { error: { message: 'Something went wrong. Please try again.' } }));
    const error = (await http.request('GET', '/x').catch((e: unknown) => e)) as ApiError;
    expect(error.message).not.toMatch(/stack|mongo|exception/i);
  });
});

describe('an ended session', () => {
  it('is reported when a normal request is refused with 401', async () => {
    const onUnauthorized = vi.fn();
    const { http } = setup(() => reply(401, { error: { message: 'Sign in to continue' } }), { onUnauthorized });
    await expect(http.request('GET', '/api/applications')).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('is not reported for sign-in calls, where 401 means a wrong password', async () => {
    const onUnauthorized = vi.fn();
    const { http } = setup(() => reply(401, { error: { message: 'Invalid email or password' } }), { onUnauthorized });
    await expect(http.request('POST', '/api/auth/login', {}, { expectUnauthorized: true })).rejects.toMatchObject({ status: 401, message: 'Invalid email or password' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('the API client', () => {
  it('asks "who am I" and treats 401 as "nobody", without announcing an ended session', async () => {
    const onUnauthorized = vi.fn();
    const { http, calls } = setup(() => reply(401, { error: { message: 'Sign in to continue' } }), { onUnauthorized });
    void http;
    const api = createHttpApi({ fetchImpl: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return reply(401, { error: { message: 'x' } }); }) as unknown as FetchFn, onUnauthorized });
    await expect(api.auth.me()).resolves.toBeNull();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('reports an unreachable server from "who am I" instead of pretending nobody is signed in', async () => {
    const api = createHttpApi({ fetchImpl: (async () => { throw new TypeError('down'); }) as unknown as FetchFn });
    await expect(api.auth.me()).rejects.toMatchObject({ status: 0 });
  });

  it('encodes ids in paths and sends the upload fields before the file', async () => {
    const calls: Array<{ url: string; body?: BodyInit | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body });
      return reply(200, { application: {}, document: {}, conversations: [], applications: [], documents: [] });
    }) as unknown as FetchFn;
    const api = createHttpApi({ fetchImpl });
    await api.applications.get('REG-2026-000001/../x');
    expect(calls[0]!.url).toBe('/api/applications/REG-2026-000001%2F..%2Fx');

    await api.documents.upload(new File(['x'], 'a.pdf', { type: 'application/pdf' }), { typeId: 'passport', applicationId: 'REG-2026-000001', requirementId: 'req-passport' });
    const form = calls[1]!.body as FormData;
    expect([...form.keys()]).toEqual(['typeId', 'applicationId', 'requirementId', 'file']);
    expect(calls[1]!.url).toBe('/api/documents/upload');
  });
});
