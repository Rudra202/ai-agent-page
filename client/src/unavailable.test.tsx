import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api/http';
import { createFakeApi } from './test/fakeApi';
import { renderApp } from './test/helpers';

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('when the server is up but cannot use its database', () => {
  it("shows the server's own explanation instead of a vague failure", async () => {
    const api = createFakeApi();
    api.failNext('auth.me', new ApiError(503, 'The database is not connected. Add this IP in Atlas.'));
    await renderApp('/dashboard', { api });
    expect(await screen.findByRole('heading', { name: 'Cannot reach Tajir' })).toBeInTheDocument();
    expect(screen.getByText('The database is not connected. Add this IP in Atlas.')).toBeInTheDocument();
    expect(screen.getByText(/checks again every few seconds/)).toBeInTheDocument();
  });

  it('uses the plain message when the server did not answer at all', async () => {
    const api = createFakeApi();
    api.failNext('auth.me', new ApiError(0, 'Could not reach the server.'));
    await renderApp('/dashboard', { api });
    expect(await screen.findByText(/The server did not answer/)).toBeInTheDocument();
    expect(screen.queryByText('Could not reach the server.')).not.toBeInTheDocument();
  });

  it('opens by itself once the server can use its database again, without a reload', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const api = createFakeApi();
    api.failNext('auth.me', new ApiError(503, 'The database is not connected.'));
    await renderApp('/dashboard', { api, skipReady: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByRole('heading', { name: 'Cannot reach Tajir' })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    vi.useRealTimers();
    expect(await screen.findByRole('heading', { level: 1, name: /what can tajir help you with today/i })).toBeInTheDocument();
    expect(api.calls('auth.me')).toBe(2);
  });
});
