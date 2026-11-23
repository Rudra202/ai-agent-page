import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { INITIAL_WORKFLOW } from '@tajir/shared';
import { afterEach, describe, expect, it } from 'vitest';
import App from './App';
import { ApiError } from './api/http';
import { ApiContext } from './state/context';
import { AuthProvider } from './state/AuthStore';
import { createFakeApi } from './test/fakeApi';
import { button, chatToSummary, pdf, renderApp } from './test/helpers';

afterEach(() => cleanup());

const draftAt = (step: 'business_details' | 'submitted') => ({
  ...INITIAL_WORKFLOW,
  type: 'company_registration' as const,
  step,
  company: { registrationType: 'free_zone' as const, jurisdictionId: 'shams' },
});

describe('routes', () => {
  it.each([
    ['/dashboard', 'What can Tajir help you with today?'],
    ['/chat', 'Chat with Tajir'],
    ['/company-setup', 'Company setup'],
    ['/company-setup/review', 'Review and submit'],
    ['/applications', 'Applications'],
    ['/applications/FIN-2026-050123', 'Working Capital Finance'],
    ['/activity', 'Activity'],
    ['/documents', 'Documents'],
    ['/profile', 'Profile'],
    ['/design', 'Design system'],
    ['/does-not-exist', 'Page not found'],
  ])('renders %s', async (path, heading) => {
    await renderApp(path);
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
  });

  it('redirects / to the dashboard', async () => {
    await renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: /what can tajir help you with today/i })).toBeInTheDocument();
  });

  it('shows a helpful message for an unknown application', async () => {
    await renderApp('/applications/NOPE');
    expect(screen.getByText('Application not found')).toBeInTheDocument();
  });

  it('shows the four reference tabs in both navigation bars and highlights Home on chat', async () => {
    await renderApp('/chat');
    for (const label of ['primary', 'primary mobile']) {
      const nav = screen.getByRole('navigation', { name: new RegExp(`^${label}$`, 'i') });
      expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Home', 'Activity', 'Documents', 'Profile']);
      expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    }
  });
});

describe('loading and errors', () => {
  it('shows a loading state, then the data', async () => {
    const api = createFakeApi();
    const view = render(
      <ApiContext.Provider value={api}>
        <AuthProvider api={api}>
          <MemoryRouter initialEntries={['/applications']}>
            <App pollMs={0} />
          </MemoryRouter>
        </AuthProvider>
      </ApiContext.Provider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/Checking your session|Loading your data/);
    expect(await screen.findByRole('heading', { level: 1, name: 'Applications' })).toBeInTheDocument();
    expect(view.container.querySelectorAll('[role="progressbar"]')).toHaveLength(3);
  });

  it('explains a failed first load and loads again on retry', async () => {
    const api = createFakeApi();
    api.failNext('applications.list', new ApiError(500, 'Something went wrong. Please try again.'));
    const user = userEvent.setup();
    await renderApp('/applications', { api });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load your data');
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Please try again.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Applications' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says so plainly when the server cannot be reached, and recovers', async () => {
    const api = createFakeApi();
    api.failNext('auth.me', new ApiError(0, 'Could not reach the server.'));
    const user = userEvent.setup();
    await renderApp('/dashboard', { api });
    expect(screen.getByRole('heading', { name: 'Cannot reach Tajir' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: /what can tajir help you with today/i })).toBeInTheDocument();
  });

  it('shows empty states for an account with no applications or documents', async () => {
    await renderApp('/applications', { seed: false });
    expect(screen.getByText('No applications yet')).toBeInTheDocument();
    cleanup();
    await renderApp('/documents', { seed: false });
    expect(screen.getByText('No documents yet')).toBeInTheDocument();
    cleanup();
    await renderApp('/activity', { seed: false });
    expect(screen.getByText('Nothing needs your attention right now.')).toBeInTheDocument();
  });
});

describe('home', () => {
  it('greets the signed-in user and shows what is waiting, taken from their real applications', async () => {
    await renderApp('/dashboard');
    expect(screen.getByText(/^Good (morning|afternoon|evening), Ahmed$/)).toBeInTheDocument();
    expect(screen.getAllByText('ABC Trading LLC').length).toBeGreaterThan(0);
    const urgent = screen.getByRole('region', { name: 'Most urgent' });
    expect(within(urgent).getByText('Latest 6-month bank statement')).toBeInTheDocument();
    expect(within(urgent).getByText(/Document needed for Working Capital Finance FIN-2026-050123/)).toBeInTheDocument();
    // No invented reminders.
    expect(screen.queryByText(/VAT Return/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Ejari/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start a company' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Ask Tajir...')).toBeInTheDocument();
  });

  it('shows no urgent card when nothing is waiting', async () => {
    await renderApp('/dashboard', { seed: false });
    expect(screen.queryByRole('region', { name: 'Most urgent' })).not.toBeInTheDocument();
  });

  it('continues in chat when a suggestion is pressed', async () => {
    const user = userEvent.setup();
    await renderApp('/dashboard');
    await user.click(screen.getByRole('button', { name: 'Working Capital Finance' }));
    expect(await screen.findByText(/does not offer, price or approve/)).toBeInTheDocument();
  });

  it('opens the clarification in chat from the urgent card', async () => {
    const user = userEvent.setup();
    await renderApp('/dashboard');
    await user.click(within(screen.getByRole('region', { name: 'Most urgent' })).getByRole('button', { name: 'Continue in chat' }));
    expect(await screen.findByText(/We need your latest 6-month bank statement/)).toBeInTheDocument();
  });
});

describe('chat', () => {
  it('shows the message at once and a typing indicator until the server answers', async () => {
    const api = createFakeApi();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const send = api.conversations.send.bind(api.conversations);
    api.conversations.send = async (id, turn) => {
      await gate;
      return send(id, turn);
    };
    const user = userEvent.setup();
    await renderApp('/chat', { api });
    await user.type(screen.getByLabelText('Message Tajir'), 'hello{Enter}');
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Tajir is typing' })).toBeInTheDocument();
    release();
    expect(await screen.findByText(/Hello Ahmed!/)).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Tajir is typing' })).not.toBeInTheDocument();
    expect(screen.getAllByText('hello')).toHaveLength(1);
  });

  it('does not send an empty message and offers a disabled mic instead of a send button', async () => {
    await renderApp('/chat');
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /voice input is not available/i })).toBeDisabled();
    await userEvent.setup().type(screen.getByLabelText('Message Tajir'), '   ');
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
  });

  it('disables a card once the conversation has moved on', async () => {
    const user = userEvent.setup();
    await renderApp('/chat');
    await user.click(await button('Start a company'));
    await user.click(await button('Select Free Zone'));
    await screen.findByText(/Which free zone are you considering/);
    expect(await button('Select Free Zone')).toBeDisabled();
    expect(await button('Select Offshore')).toBeDisabled();
  });

  it('shows what went wrong, keeps nothing half-sent and sends again on retry', async () => {
    const api = createFakeApi();
    api.failNext('conversations.send', new ApiError(502, 'The assistant is unavailable right now. Your message was saved.'));
    const user = userEvent.setup();
    await renderApp('/chat', { api });
    await user.type(screen.getByLabelText('Message Tajir'), 'hello{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The assistant is unavailable right now.');
    expect(alert).toHaveTextContent('Your message was not sent.');
    expect(screen.queryByText('hello')).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Tajir is typing' })).not.toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Hello Ahmed!/)).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('lets the user dismiss a failed message', async () => {
    const api = createFakeApi();
    api.failNext('conversations.send', new ApiError(0, 'Could not reach the server. Check your connection and try again.'));
    const user = userEvent.setup();
    await renderApp('/chat', { api });
    await user.type(screen.getByLabelText('Message Tajir'), 'hello{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('runs the whole company journey and records the application', async () => {
    const user = userEvent.setup();
    await renderApp('/dashboard');
    await user.click(screen.getByRole('button', { name: 'Start a company' }));
    await user.click(await button('Select Free Zone'));
    await user.click(await button('Show me popular free zones'));
    await user.click(await button('Select Sharjah Media City (Shams)'));
    await user.click(await button('Media & Marketing'));
    await user.type(screen.getByLabelText('Message Tajir'), 'Vinith Media{Enter}');
    await user.click(await button('1'));
    await user.click(await button('Skip'));
    await user.click(await button('Select package Starter package'));

    const summary = await screen.findByRole('heading', { name: 'New Company Registration' });
    const card = summary.closest('div')!.parentElement!;
    expect(within(card).getByText('Vinith Media')).toBeInTheDocument();
    expect(within(card).getByText('Sharjah Media City (Shams)')).toBeInTheDocument();
    expect(within(card).getByText('All key documents are on record')).toBeInTheDocument();

    await user.click(await button('Confirm & Submit'));
    expect(await screen.findByText(/has been submitted to Shams/)).toBeInTheDocument();

    await user.click(screen.getAllByRole('link', { name: 'Activity' })[0]!);
    await user.click(screen.getByRole('tab', { name: 'In Progress' }));
    expect(screen.getByText(/Vinith Media/)).toBeInTheDocument();
  });

  it('keeps the conversation after a reload, because the server holds it', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    const first = await renderApp('/chat', { api });
    await user.type(screen.getByLabelText('Message Tajir'), 'hello{Enter}');
    await screen.findByText(/Hello Ahmed!/);
    first.unmount();

    await renderApp('/chat', { api });
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.getByText(/Hello Ahmed!/)).toBeInTheDocument();
    expect(api.calls('conversations.create')).toBe(1);
  });

  it('keeps nothing in the browser', async () => {
    const user = userEvent.setup();
    await renderApp('/chat');
    await user.type(screen.getByLabelText('Message Tajir'), 'hello{Enter}');
    await screen.findByText(/Hello Ahmed!/);
    expect(Object.keys(localStorage)).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  it('starts a fresh conversation from the header', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp('/chat');
    await user.type(screen.getByLabelText('Message Tajir'), 'hello{Enter}');
    await screen.findByText(/Hello Ahmed!/);
    await user.click(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(() => expect(screen.queryByText('hello')).not.toBeInTheDocument());
    expect(screen.getAllByText('What can Tajir help you with today?').length).toBeGreaterThan(0);
    expect(api.calls('conversations.create')).toBe(2);
  });

  it('does not open another chat when the current one is still empty', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp('/chat');
    await user.click(screen.getByRole('button', { name: 'New chat' }));
    expect(api.calls('conversations.create')).toBe(1);
  });
});

describe('which assistant is answering', () => {
  it('says plainly in the chat when no AI model is connected', async () => {
    await renderApp('/chat');
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('The AI assistant is not connected');
    expect(note).toHaveTextContent('cannot answer general questions');
  });

  it('shows no such notice when a model is connected, and names it and its backup on the profile', async () => {
    const user = userEvent.setup();
    await renderApp('/chat', { ai: 'gemini', aiBackup: 'openai', replyMode: 'ai' });
    await waitFor(() => expect(screen.queryByText(/The AI assistant is not connected/)).not.toBeInTheDocument());
    await user.type(screen.getByLabelText('Message Tajir'), 'hello{Enter}');
    await screen.findByText(/Hello Ahmed!/);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('link', { name: 'Profile' })[0]!);
    expect(await screen.findByText('Google Gemini, with OpenAI as backup, with safety checks')).toBeInTheDocument();
  });

  it('explains when the model could not be reached and the built-in guide answered instead', async () => {
    const user = userEvent.setup();
    await renderApp('/chat', { ai: 'gemini', aiBackup: 'openai', replyMode: 'fallback' });
    await user.type(screen.getByLabelText('Message Tajir'), 'hello{Enter}');
    expect(await screen.findByRole('note')).toHaveTextContent('could not be reached for that message');
  });
});

describe('review and submit', () => {
  it('shows an empty state when there is nothing to review', async () => {
    await renderApp('/company-setup/review');
    expect(screen.getByText('Nothing to review yet')).toBeInTheDocument();
  });

  it('flags incomplete information and blocks submission', async () => {
    await renderApp('/company-setup/review', { workflow: draftAt('business_details') });
    expect(screen.getByText('Some information is missing')).toBeInTheDocument();
    expect(screen.getAllByText('Incomplete').length).toBeGreaterThan(0);
    // Shown once in the summary banner and once under its section.
    expect(screen.getAllByText('Company name is required')).toHaveLength(2);
    expect(screen.getAllByText('Package is required')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Confirm & Submit' })).toBeDisabled();
  });

  it('validates edits, saves them on the server and submits after confirmation', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp('/chat');
    await chatToSummary(user);

    await user.click(screen.getByRole('link', { name: 'Review & edit details' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Review and submit' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit Business details' }));
    const name = screen.getByLabelText('Company name');
    await user.clear(name);
    await user.type(name, 'A');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/at least 2 characters/)).toBeInTheDocument();
    expect(api.calls('conversations.updateDraft')).toBe(0);

    await user.clear(name);
    await user.type(name, 'Vinith Studio');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Vinith Studio')).toBeInTheDocument();
    expect(api.calls('conversations.updateDraft')).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Edit Shareholders' }));
    const shareholders = screen.getByLabelText('Number of shareholders');
    await user.clear(shareholders);
    await user.type(shareholders, '0');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('At least one shareholder is required')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Confirm & Submit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Submit this application?' });
    await user.click(within(dialog).getByRole('button', { name: 'Yes, submit' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Company Registration' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/Submitted\. Your request is recorded/);
    expect(screen.getByRole('status')).toHaveTextContent(/Nothing is filed with any authority/);
    // The edited name appears as the subtitle and in the details list.
    expect(screen.getAllByText('Vinith Studio')).toHaveLength(2);
    expect(screen.getByText(/^REG-2026-\d{6}$/, { selector: 'a' })).toBeInTheDocument();
  });

  it('keeps the editor open and explains it when the server refuses an edit', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp('/chat');
    await chatToSummary(user);
    await user.click(screen.getByRole('link', { name: 'Review & edit details' }));
    await user.click(await screen.findByRole('button', { name: 'Edit Business details' }));
    api.failNext('conversations.updateDraft', new ApiError(422, 'That package does not belong to the chosen jurisdiction'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('That package does not belong to the chosen jurisdiction')).toBeInTheDocument();
    expect(screen.getByLabelText('Company name')).toBeInTheDocument();
  });

  it('shows an error and stays on the page when submission fails', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp('/chat');
    await chatToSummary(user);
    await user.click(screen.getByRole('link', { name: 'Review & edit details' }));
    await user.click(await button('Confirm & Submit'));
    api.failNext('conversations.send', new ApiError(502, 'The assistant is unavailable right now. Your message was saved.'));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes, submit' }));
    expect(await screen.findByText('The assistant is unavailable right now. Your message was saved.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Review and submit' })).toBeInTheDocument();
  });

  it('lets the user back out of the confirmation dialog', async () => {
    const user = userEvent.setup();
    await renderApp('/chat');
    await chatToSummary(user);
    await user.click(screen.getByRole('link', { name: 'Review & edit details' }));
    await user.click(await button('Confirm & Submit'));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Review and submit' })).toBeInTheDocument();
  });

  it('shows an already-submitted state once the registration has been submitted', async () => {
    await renderApp('/company-setup/review', { workflow: draftAt('submitted') });
    expect(screen.getByText('Already submitted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm & Submit' })).not.toBeInTheDocument();
  });
});

describe('company setup overview', () => {
  it('offers to start when nothing has been started', async () => {
    await renderApp('/company-setup');
    expect(screen.getByRole('button', { name: 'Start in chat' })).toBeInTheDocument();
  });

  it('shows progress, what has been answered and shortcuts once a registration is under way', async () => {
    await renderApp('/company-setup', { workflow: draftAt('business_details') });
    const steps = within(screen.getByRole('list', { name: 'Registration steps' })).getAllByRole('listitem');
    expect(steps.map((li) => li.textContent)).toEqual([
      'Registration type (done)',
      'Jurisdiction (done)',
      'Business details (current)',
      'Package',
      'Review',
      'Submitted',
    ]);
    expect(screen.getByText('Sharjah Media City (Shams)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue in chat' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review what I have so far' })).toBeInTheDocument();
  });
});

describe('activity and applications', () => {
  it('filters by Needs Action, In Progress and Completed, defaulting to Needs Action', async () => {
    const user = userEvent.setup();
    await renderApp('/activity');
    expect(screen.getByRole('tab', { name: 'Needs Action' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Upload latest 6-month bank statement')).toBeInTheDocument();
    expect(screen.queryByText(/REG-2026-178295/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'In Progress' }));
    expect(screen.getByText(/REG-2026-178295/)).toBeInTheDocument();
    expect(screen.queryByText(/FIN-2026-050123/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Completed' }));
    expect(screen.getByText(/REG-2026-101443/)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getAllByRole('link', { name: /Company Registration|Working Capital Finance/ })).toHaveLength(3);
  });

  it('lists every application with its progress', async () => {
    await renderApp('/applications');
    expect(screen.getAllByRole('progressbar')).toHaveLength(3);
  });

  it('shows the application detail the way the reference does', async () => {
    await renderApp('/applications/FIN-2026-050123');
    expect(screen.getByText('Action required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue in chat' })).toBeInTheDocument();
    expect(screen.getByText('Progress')).toBeInTheDocument();
    expect(screen.getByText('Timeline')).toBeInTheDocument();
    expect(screen.getByText('Last updated')).toBeInTheDocument();
    expect(screen.getByText('Submission date')).toBeInTheDocument();
    expect(screen.getByText('Documents Pending')).toBeInTheDocument();
    // Service-specific steps: finance has Preparation and no Submitted step.
    const steps = within(screen.getByRole('list', { name: 'Application steps' })).getAllByRole('listitem');
    expect(steps.map((li) => li.textContent?.replace(/\d{4}-\d{2}-\d{2}/, ''))).toEqual([
      'Request understood (done)',
      'Request confirmed (done)',
      'Documents and information received (current)',
      'Preparation (not started)',
      'Under review (not started)',
      'Completed (not started)',
    ]);
  });

  it('does not show an action banner when nothing is pending', async () => {
    await renderApp('/applications/REG-2026-178295');
    expect(screen.queryByText('Action required')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing is needed from you for this application.')).toBeInTheDocument();
  });

  it('asks the server for the latest status when an application is opened', async () => {
    const { api } = await renderApp('/applications/REG-2026-178295');
    await waitFor(() => expect(api.calls('applications.list')).toBeGreaterThan(1));
  });
});

describe('clarifications and uploads', () => {
  it('continues in chat, explains where to upload, and updates progress after the upload', async () => {
    const user = userEvent.setup({ applyAccept: false });
    await renderApp('/applications/FIN-2026-050123');
    await user.click(screen.getByRole('button', { name: 'Continue in chat' }));

    expect(await screen.findByText(/We need your latest 6-month bank statement/)).toBeInTheDocument();
    await user.click(await button('Where can I upload it?'));
    expect(await screen.findByText(/upload option below/)).toBeInTheDocument();

    const inputs = screen.getAllByLabelText('Upload Latest 6-month bank statement file');
    await user.upload(inputs[inputs.length - 1]!, pdf());

    expect(await screen.findByText(/I've recorded your latest 6-month bank statement/)).toBeInTheDocument();
    expect(screen.getByText('Uploaded statement.pdf')).toBeInTheDocument();

    await user.click(screen.getAllByRole('link', { name: 'Activity' })[0]!);
    expect(await screen.findByText('Nothing needs your attention right now.')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'In Progress' }));
    expect(screen.getByText(/FIN-2026-050123/)).toBeInTheDocument();
  });

  it('rejects unsupported files with a clear message and keeps the requirement open', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { api } = await renderApp('/applications/FIN-2026-050123');
    const input = screen.getByLabelText('Upload Latest 6-month bank statement file');
    await user.upload(input, new File(['MZ'], 'virus.exe', { type: 'application/x-msdownload' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Please upload a PDF, PNG or JPG file.');
    expect(screen.getByRole('button', { name: 'Continue in chat' })).toBeInTheDocument();
    // The browser check stops it before anything is sent.
    expect(api.calls('documents.upload')).toBe(0);
  });

  it("shows the server's reason when it refuses a file, and keeps the requirement open", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { api } = await renderApp('/applications/FIN-2026-050123');
    api.failNext('documents.upload', new ApiError(400, 'The file content does not match its type.'));
    await user.upload(screen.getByLabelText('Upload Latest 6-month bank statement file'), pdf());
    expect(await screen.findByRole('alert')).toHaveTextContent('The file content does not match its type.');
    expect(screen.getByText('Action required')).toBeInTheDocument();
  });

  it('uploads from the application page without going through chat and confirms it', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { api } = await renderApp('/applications/FIN-2026-050123');
    await user.upload(screen.getByLabelText('Upload Latest 6-month bank statement file'), pdf());
    expect(await screen.findByText('Recorded')).toBeInTheDocument();
    expect(screen.queryByText('Action required')).not.toBeInTheDocument();
    expect(api.calls('conversations.send')).toBe(0);
  });

  it('attaches with the paperclip when a document is needed', async () => {
    const user = userEvent.setup({ applyAccept: false });
    await renderApp('/chat');
    expect(screen.getByRole('button', { name: 'Attach Latest 6-month bank statement' })).toBeEnabled();
    await user.upload(screen.getByTestId('composer-file-input'), pdf());
    expect(await screen.findByText(/I've recorded your latest 6-month bank statement/)).toBeInTheDocument();
    // Nothing else is waiting for a document, but a file can still be attached for Tajir to read.
    expect(screen.getByRole('button', { name: 'Attach a document' })).toBeEnabled();
  });

  it('attaches any other file in the chat, which Tajir acknowledges with a card that follows its reading', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { api } = await renderApp('/chat', { seed: false, activePollMs: 20 });
    expect(screen.getByRole('button', { name: 'Attach a document' })).toBeEnabled();
    await user.upload(screen.getByTestId('composer-file-input'), pdf('lease.pdf'));
    expect(await screen.findByText(/I have received lease\.pdf/)).toBeInTheDocument();
    expect(api.stored[0]).toMatchObject({ typeId: 'other', originalName: 'lease.pdf', processingStatus: 'queued' });

    const log = screen.getByRole('log', { name: 'Conversation with Tajir' });
    expect(within(log).getByText('Waiting to be read')).toBeInTheDocument();
    // The worker finishes reading it: the card in the chat follows, without a reload.
    api.finishReading(api.stored[0]!.id, { detectedType: 'tenancy_contract' });
    expect(await within(log).findByText('Read')).toBeInTheDocument();
    expect(within(log).getByText('Looks like: Tenancy contract')).toBeInTheDocument();
    expect(within(log).getByRole('link', { name: 'lease.pdf' })).toHaveAttribute('href', `/documents/${api.stored[0]!.id}`);
  });

  it('attaches a document that is already in Documents, without uploading anything again', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp('/chat');
    const before = api.stored.length;
    await user.click(screen.getByRole('button', { name: 'Choose an existing document' }));
    const list = screen.getByRole('group', { name: 'Your documents' });
    expect(within(list).getAllByRole('button')).toHaveLength(before);
    await user.click(within(list).getByRole('button', { name: `Use ${api.stored[0]!.originalName}` }));

    const log = screen.getByRole('log', { name: 'Conversation with Tajir' });
    expect(await within(log).findByRole('link', { name: api.stored[0]!.originalName })).toHaveAttribute('href', `/documents/${api.stored[0]!.id}`);
    expect(api.calls('documents.upload')).toBe(0);
    expect(api.stored).toHaveLength(before);
    // The list closes once a document is chosen.
    expect(screen.queryByRole('group', { name: 'Your documents' })).not.toBeInTheDocument();
  });

  it('says so when there are no documents to choose from', async () => {
    const user = userEvent.setup();
    await renderApp('/chat', { seed: false });
    await user.click(screen.getByRole('button', { name: 'Choose an existing document' }));
    expect(screen.getByRole('group', { name: 'Your documents' })).toHaveTextContent('You have no documents yet');
  });

  it('attaching the same file again uses the document that is already there', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { api } = await renderApp('/chat', { seed: false });
    await user.upload(screen.getByTestId('composer-file-input'), pdf('lease.pdf'));
    expect(await screen.findByText(/I have received lease\.pdf/)).toBeInTheDocument();
    await user.upload(screen.getByTestId('composer-file-input'), pdf('lease.pdf'));
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'lease.pdf' })).toHaveLength(2));
    expect(api.stored).toHaveLength(1);
    expect(api.calls('documents.upload')).toBe(2);
  });

  it('shows in the chat that an attached file could not be read, and why', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { api } = await renderApp('/chat', { seed: false, activePollMs: 20 });
    await user.upload(screen.getByTestId('composer-file-input'), pdf('blank.pdf'));
    const log = screen.getByRole('log', { name: 'Conversation with Tajir' });
    expect(await within(log).findByText('Waiting to be read')).toBeInTheDocument();
    api.finishReading(api.stored[0]!.id, { processingStatus: 'failed', aiStatus: 'not_requested', errorMessage: 'No readable text was found in this PDF.' });
    expect(await within(log).findByText('Could not be read')).toBeInTheDocument();
    expect(within(log).getByText('No readable text was found in this PDF.')).toBeInTheDocument();
  });

  it('names the documents an answer came from, each as a link', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp('/chat');
    const doc = api.stored[0]!;
    api.answerNextTextWith('The licence shows an expiry date of 31/01/2027.', [{ documentId: doc.id, name: doc.originalName, page: 1 }]);
    await user.type(screen.getByLabelText('Message Tajir'), 'When does my trade licence expire?{Enter}');
    expect(await screen.findByText('The licence shows an expiry date of 31/01/2027.')).toBeInTheDocument();
    const sources = screen.getByTestId('answer-sources');
    expect(within(sources).getByRole('link', { name: doc.originalName })).toHaveAttribute('href', `/documents/${doc.id}`);
    expect(sources).toHaveTextContent('(page 1)');
  });
});

describe('documents', () => {
  it('lists the stored documents and what is needed now', async () => {
    await renderApp('/documents');
    expect(screen.getByText('NEEDED NOW')).toBeInTheDocument();
    const vault = screen.getByRole('heading', { name: 'YOUR DOCUMENTS' }).closest('section')!;
    expect(within(vault).getByText('Passport copy')).toBeInTheDocument();
    expect(within(vault).getByText('Trade licence')).toBeInTheDocument();
    expect(within(vault).getAllByRole('listitem')).toHaveLength(5);
    expect(within(vault).getAllByText('Stored')).toHaveLength(5);
  });

  it('requires a document type before adding a file, then uploads it to the server', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { api } = await renderApp('/documents');
    const input = screen.getByLabelText('Add document file');
    await user.upload(input, new File(['x'], 'scan.pdf', { type: 'application/pdf' }));
    expect((await screen.findAllByText('Choose a document type first.')).length).toBeGreaterThan(0);
    expect(api.calls('documents.upload')).toBe(0);

    await user.selectOptions(screen.getByLabelText('Document type'), 'source_of_funds');
    await user.upload(input, new File(['hello'], 'funds.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText('funds.pdf uploaded')).toBeInTheDocument();
    expect((await screen.findAllByText(/funds\.pdf/)).length).toBeGreaterThan(1);
    expect(api.stored[0]).toMatchObject({ typeId: 'source_of_funds', originalName: 'funds.pdf', sizeBytes: 5 });
  });
});

describe('profile', () => {
  it('shows the account, what is stored and which assistant answers', async () => {
    await renderApp('/profile');
    expect(screen.getByText('Ahmed Al Mansoori')).toBeInTheDocument();
    expect(screen.getByText('ahmed@abctrading.example')).toBeInTheDocument();
    expect(screen.getAllByText('ABC Trading LLC').length).toBeGreaterThan(0);
    expect(await screen.findByText('Not connected: guided steps only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reset demo/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });
});
