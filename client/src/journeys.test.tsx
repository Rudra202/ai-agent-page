import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { button, chatThroughFinance, chatToSummary, pdf, renderApp } from './test/helpers';
import type { User } from './test/helpers';

/**
 * End-to-end journeys through the real UI. They check that progress only ever
 * shows what actually happened, that each service has its own steps, and that
 * uploads are never presented as stored files.
 */

const normalise = (text: string | null) =>
  (text ?? '').replace(/\d{4}-\d{2}-\d{2}/, '').replace('Simulated', '');
const steps = () =>
  within(screen.getByRole('list', { name: 'Application steps' }))
    .getAllByRole('listitem')
    .map((li) => normalise(li.textContent));
const status = () => screen.getByTestId('status-badge').textContent;
const lastOf = (elements: HTMLElement[]) => elements[elements.length - 1]!;

async function openLatestApplication(user: User) {
  await user.click(lastOf(await screen.findAllByRole('link', { name: 'View details' })));
  await screen.findByRole('list', { name: 'Application steps' });
}

afterEach(() => cleanup());

describe('company registration with every document on record', () => {
  it('shows only genuine progress and reaches completion solely through labelled simulation', async () => {
    const user = userEvent.setup({ applyAccept: false });
    await renderApp('/chat');
    await chatToSummary(user);
    await user.click(await button('Confirm & Submit'));
    expect(await screen.findByText(/has been submitted to Shams/)).toBeInTheDocument();
    await openLatestApplication(user);

    expect(status()).toBe('Submitted');
    expect(steps()).toEqual([
      'Request understood (done)',
      'Details confirmed (done)',
      'Documents ready (done)',
      'Submitted (done)',
      'Under review (current)',
      'Completed (not started)',
    ]);
    expect(screen.getByText('4 of 6 steps done. A step is only marked done once it has happened.')).toBeInTheDocument();
    expect(screen.queryByText('Simulated')).not.toBeInTheDocument();
    expect(screen.queryByText('Action required')).not.toBeInTheDocument();

    // Authority steps cannot happen for real in the prototype: only the labelled simulation can record them.
    const controls = screen.getByRole('region', { name: 'Prototype controls' });
    expect(within(controls).getByText('Prototype only')).toBeInTheDocument();
    await user.click(within(controls).getByRole('button', { name: 'Simulate: Under review' }));
    expect(status()).toBe('Under Review');
    expect(steps().slice(3)).toEqual(['Submitted (done)', 'Under review (done)', 'Completed (current)']);
    expect(screen.getAllByText('Simulated').length).toBeGreaterThan(0);
    expect(screen.getByText('Under review (simulated)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Simulate: Completed' }));
    expect(status()).toBe('Completed');
    expect(steps().every((s) => s.endsWith('(done)'))).toBe(true);
    expect(screen.getByText('6 of 6 steps done. A step is only marked done once it has happened.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Prototype controls' })).not.toBeInTheDocument();

    await user.click(screen.getAllByRole('link', { name: 'Activity' })[0]!);
    await user.click(await screen.findByRole('tab', { name: 'Completed' }));
    expect(screen.getByText(/Vinith Media/)).toBeInTheDocument();
  });
});

describe('company registration with a missing document', () => {
  it('waits for the document, clarifies in chat, records the upload, then submits and completes', async () => {
    const user = userEvent.setup({ applyAccept: false });
    await renderApp('/chat');
    await chatToSummary(user, 'offshore');
    expect(screen.getByText(/1 still needed: Proof of source of funds/)).toBeInTheDocument();

    await user.click(await button('Confirm & Submit'));
    expect(await screen.findByText(/can't go further yet/)).toBeInTheDocument();
    await openLatestApplication(user);

    // Nothing is marked done that has not happened: no documents, no submission, no review.
    expect(status()).toBe('Documents Pending');
    expect(steps()).toEqual([
      'Request understood (done)',
      'Details confirmed (done)',
      'Documents ready (current)',
      'Submitted (not started)',
      'Under review (not started)',
      'Completed (not started)',
    ]);
    expect(screen.getByText('Action required')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Prototype controls' })).not.toBeInTheDocument();
    expect(screen.getByText('Not submitted yet')).toBeInTheDocument();

    // Clarification in chat.
    await user.click(screen.getByRole('button', { name: 'Continue in chat' }));
    expect(await screen.findByText(/We need your proof of source of funds to continue company registration/)).toBeInTheDocument();
    await user.click(await button('Where can I upload it?'));
    expect(await screen.findByText(/upload option below/)).toBeInTheDocument();

    // Upload. The reply must say where the file is kept.
    const inputs = screen.getAllByLabelText('Upload Proof of source of funds file');
    await user.upload(lastOf(inputs), pdf('funds.pdf'));
    expect(await screen.findByText(/I've recorded your proof of source of funds/)).toBeInTheDocument();
    expect(screen.getAllByText(/stored on this prototype's server/).length).toBeGreaterThan(0);

    await openLatestApplication(user);
    expect(status()).toBe('Submitted');
    expect(steps()).toEqual([
      'Request understood (done)',
      'Details confirmed (done)',
      'Documents ready (done)',
      'Submitted (done)',
      'Under review (current)',
      'Completed (not started)',
    ]);
    expect(screen.getByText('Document recorded: Proof of source of funds')).toBeInTheDocument();
    expect(screen.getByText('funds.pdf')).toBeInTheDocument();
    expect(screen.queryByText('Action required')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Simulate: Under review' }));
    await user.click(screen.getByRole('button', { name: 'Simulate: Completed' }));
    expect(status()).toBe('Completed');
    expect(steps().every((s) => s.endsWith('(done)'))).toBe(true);
  });
});

describe('working capital finance', () => {
  it('has its own steps, records a request without claiming a submission, and needs both items before preparation', async () => {
    const user = userEvent.setup({ applyAccept: false });
    await renderApp('/chat');
    await chatThroughFinance(user);
    expect(await screen.findByText(/has been recorded/)).toBeInTheDocument();
    expect(screen.getAllByText(/does not offer, price or approve real financing/).length).toBeGreaterThan(0);
    await openLatestApplication(user);

    expect(screen.getByRole('heading', { level: 1, name: 'Working Capital Finance' })).toBeInTheDocument();
    expect(status()).toBe('Documents Pending');
    expect(steps()).toEqual([
      'Request understood (done)',
      'Request confirmed (done)',
      'Documents and information received (current)',
      'Preparation (not started)',
      'Under review (not started)',
      'Completed (not started)',
    ]);
    expect(steps().join(' ')).not.toContain('Submitted');
    expect(screen.getByText('Not applicable: the prototype records the request only')).toBeInTheDocument();
    const needs = screen.getByText('What we need from you').closest('div')!.parentElement!;
    expect(within(needs).getByText('Latest 6-month bank statement')).toBeInTheDocument();
    expect(within(needs).getByText('Annual turnover (AED)')).toBeInTheDocument();

    // Clarify the document in chat.
    await user.click(screen.getByRole('button', { name: 'Continue in chat' }));
    expect(await screen.findByText(/We need your latest 6-month bank statement to continue working capital finance/)).toBeInTheDocument();
    await user.upload(lastOf(screen.getAllByLabelText('Upload Latest 6-month bank statement file')), pdf());
    expect(await screen.findByText(/Still outstanding: Annual turnover \(AED\)/)).toBeInTheDocument();

    // The document alone must not unlock preparation.
    await user.click(screen.getAllByRole('link', { name: 'Activity' })[0]!);
    await user.click(await screen.findByRole('tab', { name: 'Needs Action' }));
    // The seeded finance application is also here. The newest one is listed first.
    await user.click((await screen.findAllByRole('link', { name: /Working Capital Finance FIN-/ }))[0]!);
    expect(status()).toBe('Information Required');
    expect(steps()[2]).toBe('Documents and information received (current)');
    expect(steps()[3]).toBe('Preparation (not started)');

    // Answer the information request in chat.
    await user.click(screen.getByRole('button', { name: 'Continue in chat' }));
    await user.type(screen.getByLabelText('Message Tajir'), '2,400,000{Enter}');
    expect(await screen.findByText(/I've saved that/)).toBeInTheDocument();
    await openLatestApplication(user);

    expect(status()).toBe('Preparation');
    expect(steps()).toEqual([
      'Request understood (done)',
      'Request confirmed (done)',
      'Documents and information received (done)',
      'Preparation (done)',
      'Under review (current)',
      'Completed (not started)',
    ]);
    expect(screen.getByText('2,400,000')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Simulate: Under review' }));
    await user.click(screen.getByRole('button', { name: 'Simulate: Completed' }));
    expect(status()).toBe('Completed');
    expect(steps().join(' ')).not.toContain('Submitted');
  });

  it('shows the seeded application waiting on its one document without claiming a product match', async () => {
    await renderApp('/applications/FIN-2026-050123');
    expect(steps()).toEqual([
      'Request understood (done)',
      'Request confirmed (done)',
      'Documents and information received (current)',
      'Preparation (not started)',
      'Under review (not started)',
      'Completed (not started)',
    ]);
    expect(screen.queryByText(/product matched/i)).not.toBeInTheDocument();
  });
});

describe('uploads reach the server and are described honestly', () => {
  it('sends the real file to the server, shows it as stored and lets it be downloaded again, keeping nothing in the browser', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { api } = await renderApp('/documents');
    await user.upload(screen.getByLabelText('Upload Latest 6-month bank statement for FIN-2026-050123 file'), pdf('statement.pdf', '%PDF-1.4 real bytes'));

    const records = screen.getByRole('heading', { name: 'YOUR DOCUMENTS' }).closest('section')!;
    expect(await within(records).findByText(/statement\.pdf/)).toBeInTheDocument();
    expect(within(records).getAllByText('Stored')).toHaveLength(6);
    expect(within(records).getByText(/for FIN-2026-050123/)).toBeInTheDocument();

    // The server received the file itself, with the application and requirement it is for.
    expect(api.calls('documents.upload')).toBe(1);
    expect(api.stored[0]).toMatchObject({
      typeId: 'bank_statement_6m',
      originalName: 'statement.pdf',
      sizeBytes: '%PDF-1.4 real bytes'.length,
      applicationId: 'FIN-2026-050123',
      requirementId: 'req-bank_statement_6m',
    });

    // Nothing is kept in the browser. The file is fetched from the server only when it is asked for, and saved to disk.
    expect(Object.keys(localStorage)).toEqual([]);
    expect(JSON.stringify(localStorage)).not.toContain('real bytes');
    expect(document.querySelectorAll('a[download], a[href^="blob:"], a[href^="data:"]')).toHaveLength(0);
    expect(api.calls('documents.file')).toBe(0);
    await user.click(within(records).getByRole('button', { name: 'Download statement.pdf' }));
    await waitFor(() => expect(api.calls('documents.file')).toBe(1));
    expect(Object.keys(localStorage)).toEqual([]);
  });

  it('tells the user where files are kept on every upload surface, and never claims they are not stored', async () => {
    const user = userEvent.setup();
    await renderApp('/documents');
    expect(screen.getByRole('note')).toHaveTextContent("Stored in this prototype's database");
    expect(screen.getByRole('note')).toHaveTextContent('not in cloud storage');
    expect(screen.getByRole('note')).toHaveTextContent('open, download, read again or delete');
    expect(screen.getByRole('note')).not.toHaveTextContent(/not available yet|local disk/);
    cleanup();

    await renderApp('/applications/FIN-2026-050123');
    expect(screen.getByText(/kept in this prototype's database/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue in chat' }));
    expect(await screen.findByText(/kept in this prototype's database/i)).toBeInTheDocument();
    expect(screen.queryByText(/file itself is not stored|never uploaded|records only/i)).not.toBeInTheDocument();
  });

  it('rejects files that fail the checks before anything is sent', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { api } = await renderApp('/applications/FIN-2026-050123');
    const input = screen.getByLabelText('Upload Latest 6-month bank statement file');
    await user.upload(input, new File(['MZ'], 'bank.exe', { type: 'application/x-msdownload' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Please upload a PDF, PNG or JPG file.');
    await user.upload(input, new File([''], 'empty.pdf', { type: 'application/pdf' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That file is empty.');
    expect(screen.getByText('Action required')).toBeInTheDocument();
    expect(steps()[2]).toBe('Documents and information received (current)');
    expect(api.calls('documents.upload')).toBe(0);
  });
});
