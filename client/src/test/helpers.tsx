import { render, screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';
import type { UserView } from '../api/types';
import { ApiContext } from '../state/context';
import { AuthProvider } from '../state/AuthStore';
import { createFakeApi } from './fakeApi';
import type { FakeApi, FakeApiOptions } from './fakeApi';

export type User = ReturnType<typeof userEvent.setup>;

/** Resolves once the session check and the first data load have finished. */
export const ready = () =>
  waitFor(() => {
    expect(screen.queryByText(/^(Loading your data|Checking your session)/)).not.toBeInTheDocument();
  });

export interface RenderOptions extends FakeApiOptions {
  api?: FakeApi;
  /** Do not wait for loading to finish. */
  skipReady?: boolean;
  /** How often (ms) to check on a document being read. Off by default, so tests control when progress happens. */
  activePollMs?: number;
}

/** Renders the whole app against an in-memory stand-in for the server, signed in unless told otherwise. */
export async function renderApp(path = '/dashboard', options: RenderOptions = {}) {
  const api = options.api ?? createFakeApi(options);
  const view = render(
    <ApiContext.Provider value={api}>
      <AuthProvider api={api}>
        <MemoryRouter initialEntries={[path]}>
          <App pollMs={0} activePollMs={options.activePollMs ?? 0} />
        </MemoryRouter>
      </AuthProvider>
    </ApiContext.Provider>,
  );
  if (!options.skipReady) await ready();
  return { ...view, api };
}

export type { UserView };

export const button = (name: string | RegExp) => screen.findByRole('button', { name });

/** Runs the company journey through the chat UI, ending on the summary card. Free Zone by default. */
export async function chatToSummary(user: User, zone: 'free_zone' | 'offshore' = 'free_zone') {
  await user.click(await button('Start a company'));
  if (zone === 'free_zone') {
    await user.click(await button('Select Free Zone'));
    await user.click(await button('Show me popular free zones'));
    await user.click(await button('Select Sharjah Media City (Shams)'));
  } else {
    await user.click(await button('Select Offshore'));
    await user.click(await button('Show me popular offshore jurisdictions'));
    await user.click(await button('Select Ras Al Khaimah Offshore'));
  }
  await user.click(await button('Media & Marketing'));
  await user.type(screen.getByLabelText('Message Tajir'), 'Vinith Media{Enter}');
  await user.click(await button('1'));
  await user.click(await button('Skip'));
  await user.click(await button('Select package Starter package'));
  await screen.findByText(/Here's a summary of your new company setup/);
}

/** Runs the finance journey through the chat UI up to and including the confirmation. */
export async function chatThroughFinance(user: User) {
  await user.click(await button('Working Capital Finance'));
  await user.click(await button('Yes, use ABC Trading LLC'));
  await user.type(screen.getByLabelText('Message Tajir'), '350000{Enter}');
  await user.click(await button('Inventory'));
  await user.click(await button('Continue'));
  await user.click(await button('Confirm & Submit'));
}

export const pdf = (name = 'statement.pdf', content = '%PDF-1.4 sample') => new File([content], name, { type: 'application/pdf' });
