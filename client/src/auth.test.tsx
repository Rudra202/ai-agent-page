import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import App from './App';
import { ApiError } from './api/http';
import { notifySessionExpired } from './lib/authEvents';
import { ApiContext } from './state/context';
import { AuthProvider } from './state/AuthStore';
import { createFakeApi } from './test/fakeApi';
import { ready, renderApp } from './test/helpers';

afterEach(() => cleanup());

const accounts = [
  { email: 'alice@example.com', password: 'correct horse battery', name: 'Alice Smith', company: 'Alice Trading LLC' },
  { email: 'bob@example.com', password: 'another good passphrase', name: 'Bob Jones' },
];

const visitor = () => createFakeApi({ user: null, accounts, seed: false });

async function signInForm(user: ReturnType<typeof userEvent.setup>, email: string, password: string) {
  await user.type(screen.getByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('protected pages', () => {
  it('sends a visitor to sign in and loads none of the app data', async () => {
    const api = visitor();
    await renderApp('/dashboard', { api });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(api.calls('applications.list')).toBe(0);
    expect(api.calls('documents.list')).toBe(0);
    expect(api.calls('conversations.list')).toBe(0);
  });

  it.each(['/chat', '/applications', '/applications/REG-2026-178295', '/documents', '/activity', '/profile', '/company-setup/review'])(
    'does not show %s to a visitor',
    async (path) => {
      await renderApp(path, { api: visitor() });
      expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
      expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
    },
  );

  it('does not show the sign-in page to someone who is already signed in', async () => {
    await renderApp('/login');
    expect(await screen.findByRole('heading', { level: 1, name: /what can tajir help you with today/i })).toBeInTheDocument();
    cleanup();
    await renderApp('/register');
    expect(await screen.findByRole('heading', { level: 1, name: /what can tajir help you with today/i })).toBeInTheDocument();
  });
});

describe('signing in', () => {
  it('checks the form before asking the server', async () => {
    const api = visitor();
    const user = userEvent.setup();
    await renderApp('/login', { api });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter your email address')).toBeInTheDocument();
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(api.calls('auth.login')).toBe(0);
  });

  it('says so, and stays put, when the email or password is wrong', async () => {
    const user = userEvent.setup();
    await renderApp('/login', { api: visitor() });
    await signInForm(user, 'alice@example.com', 'wrong password');
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    // The same words for an unknown account, so the form does not reveal who has one.
    await user.clear(screen.getByLabelText('Email'));
    await signInForm(user, 'nobody@example.com', 'wrong password');
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });

  it('shows the busy state while signing in, then the app', async () => {
    const api = visitor();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const login = api.auth.login.bind(api.auth);
    api.auth.login = async (input) => {
      await gate;
      return login(input);
    };
    const user = userEvent.setup();
    await renderApp('/login', { api });
    await signInForm(user, 'alice@example.com', 'correct horse battery');
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeDisabled();
    release();
    expect(await screen.findByRole('heading', { level: 1, name: /what can tajir help you with today/i })).toBeInTheDocument();
    expect(screen.getByText(/^Good (morning|afternoon|evening), Alice$/)).toBeInTheDocument();
    expect(screen.getAllByText('Alice Trading LLC').length).toBeGreaterThan(0);
  });

  it('returns to the page the visitor was sent away from', async () => {
    const user = userEvent.setup();
    await renderApp('/documents', { api: visitor() });
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    await signInForm(user, 'alice@example.com', 'correct horse battery');
    expect(await screen.findByRole('heading', { level: 1, name: 'Documents' })).toBeInTheDocument();
  });

  it('ignores a "from" address that points outside the app', async () => {
    const api = visitor();
    const user = userEvent.setup();
    render(
      <ApiContext.Provider value={api}>
        <AuthProvider api={api}>
          <MemoryRouter initialEntries={[{ pathname: '/login', state: { from: '//evil.example/phish' } }]}>
            <App pollMs={0} />
          </MemoryRouter>
        </AuthProvider>
      </ApiContext.Provider>,
    );
    await ready();
    await signInForm(user, 'alice@example.com', 'correct horse battery');
    expect(await screen.findByRole('heading', { level: 1, name: /what can tajir help you with today/i })).toBeInTheDocument();
  });

  it('explains a failure to reach the server', async () => {
    const api = visitor();
    api.failNext('auth.login', new ApiError(0, 'Could not reach the server. Check your connection and try again.'));
    const user = userEvent.setup();
    await renderApp('/login', { api });
    await signInForm(user, 'alice@example.com', 'correct horse battery');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
  });

  it('shows the limit message when there have been too many attempts', async () => {
    const api = visitor();
    api.failNext('auth.login', new ApiError(429, 'Too many sign-in attempts. Please wait a few minutes and try again.'));
    const user = userEvent.setup();
    await renderApp('/login', { api });
    await signInForm(user, 'alice@example.com', 'whatever1');
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many sign-in attempts');
  });
});

describe('registering', () => {
  async function fill(user: ReturnType<typeof userEvent.setup>, values: { name?: string; email?: string; password?: string; company?: string }) {
    if (values.name) await user.type(screen.getByLabelText('Your name'), values.name);
    if (values.email) await user.type(screen.getByLabelText('Email'), values.email);
    if (values.password) await user.type(screen.getByLabelText('Password'), values.password);
    if (values.company) await user.type(screen.getByLabelText(/Company name/), values.company);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
  }

  it('checks the form before asking the server', async () => {
    const api = visitor();
    const user = userEvent.setup();
    await renderApp('/register', { api });
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Enter your name')).toBeInTheDocument();
    expect(screen.getByText('Enter your email address')).toBeInTheDocument();
    expect(screen.getByText('Use at least 8 characters')).toBeInTheDocument();
    await fill(user, { name: 'Carol', email: 'carol@example.com', password: 'short' });
    expect(await screen.findAllByText('Use at least 8 characters')).not.toHaveLength(0);
    expect(api.calls('auth.register')).toBe(0);
  });

  it('creates the account, signs in and greets the user by first name', async () => {
    const api = visitor();
    const user = userEvent.setup();
    await renderApp('/register', { api });
    await fill(user, { name: 'Carol Danvers', email: 'Carol@Example.com', password: 'a long passphrase', company: 'Danvers Aviation' });
    expect(await screen.findByRole('heading', { level: 1, name: /what can tajir help you with today/i })).toBeInTheDocument();
    expect(screen.getByText(/^Good (morning|afternoon|evening), Carol$/)).toBeInTheDocument();
    expect(screen.getAllByText('Danvers Aviation').length).toBeGreaterThan(0);
    // A new account has its own, empty chat and no applications.
    expect(screen.queryByRole('region', { name: 'Most urgent' })).not.toBeInTheDocument();
  });

  it('works without a company and shows the name instead', async () => {
    const user = userEvent.setup();
    await renderApp('/register', { api: visitor() });
    await fill(user, { name: 'Dev Patel', email: 'dev@example.com', password: 'a long passphrase' });
    expect(await screen.findByText(/^Good (morning|afternoon|evening), Dev$/)).toBeInTheDocument();
    expect(screen.getAllByText('Dev Patel').length).toBeGreaterThan(0);
  });

  it('reports an email that is already used', async () => {
    const user = userEvent.setup();
    await renderApp('/register', { api: visitor() });
    await fill(user, { name: 'Alice Again', email: 'alice@example.com', password: 'a long passphrase' });
    expect(await screen.findByRole('alert')).toHaveTextContent('An account with this email already exists');
    expect(screen.getByRole('heading', { level: 1, name: 'Create your account' })).toBeInTheDocument();
  });

  it('links between sign in and sign up', async () => {
    const user = userEvent.setup();
    await renderApp('/login', { api: visitor() });
    await user.click(screen.getByRole('link', { name: 'Create an account' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Create your account' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('signing out and session changes', () => {
  it('signs out, and the pages are closed again', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp('/profile');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(api.calls('auth.logout')).toBe(1);
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
  });

  it("never shows one person's data to the next person on the same browser", async () => {
    const api = visitor();
    const user = userEvent.setup();
    await renderApp('/login', { api });
    await signInForm(user, 'alice@example.com', 'correct horse battery');
    expect(await screen.findByText(/^Good (morning|afternoon|evening), Alice$/)).toBeInTheDocument();
    await user.click(screen.getAllByRole('link', { name: 'Profile' })[0]!);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });

    await user.type(screen.getByLabelText('Email'), 'bob@example.com');
    await user.type(screen.getByLabelText('Password'), 'another good passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/^Good (morning|afternoon|evening), Bob$/)).toBeInTheDocument();
    expect(screen.queryByText('Alice Trading LLC')).not.toBeInTheDocument();
    expect(screen.queryByText(/Alice/)).not.toBeInTheDocument();
    // The app loaded again for the new person instead of reusing the old state.
    expect(api.calls('conversations.list')).toBe(2);
  });

  it('sends the user back to sign in, with a note, when the session ends', async () => {
    await renderApp('/applications');
    expect(screen.getByRole('heading', { level: 1, name: 'Applications' })).toBeInTheDocument();
    act(() => notifySessionExpired());
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Your session ended. Please sign in again.');
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
  });

  it('clears the "session ended" note after signing in again', async () => {
    const api = createFakeApi({ accounts, user: null, seed: false });
    const user = userEvent.setup();
    await renderApp('/login', { api });
    await signInForm(user, 'alice@example.com', 'correct horse battery');
    await screen.findByText(/^Good (morning|afternoon|evening), Alice$/);
    act(() => notifySessionExpired());
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    await signInForm(user, 'alice@example.com', 'correct horse battery');
    await waitFor(() => expect(screen.queryByText('Your session ended. Please sign in again.')).not.toBeInTheDocument());
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });
});
