import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api/http';
import type { DocumentExtractionView, DocumentView } from './api/types';
import { createFakeApi } from './test/fakeApi';
import { pdf, renderApp } from './test/helpers';

const NOW = '2026-11-21T10:00:00.000Z';

function doc(over: Partial<DocumentView> = {}): DocumentView {
  return {
    id: 'doc-1',
    typeId: 'trade_licence',
    label: 'Trade licence',
    originalName: 'licence.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 120_000,
    sha256: 'a'.repeat(64),
    applicationId: null,
    requirementId: null,
    processingStatus: 'completed',
    aiStatus: 'completed',
    detectedType: 'trade_licence',
    errorMessage: null,
    retryCount: 0,
    processedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const extraction = (over: Partial<DocumentExtractionView> = {}): DocumentExtractionView => ({
  method: 'pdf_text',
  detectedType: 'trade_licence',
  confidence: 'high',
  pageCount: 2,
  textLength: 900,
  truncated: false,
  structured: {
    schemaVersion: 1,
    documentType: 'trade_licence',
    facts: { licenceNumber: '1234567', companyName: 'Vinith Media FZ LLC', legalForm: null, issuingAuthority: null, businessActivities: ['Marketing Consultancy', 'Design'], issueDate: '01/02/2026', expiryDate: '31/01/2027', registeredAddress: null },
    interpretation: { summary: 'A trade licence for a marketing company.', observations: ['Both an issue date and an expiry date are shown.'], missingInformation: ['Legal form', 'Issuing authority', 'Address'] },
    notes: ['"Legal form" could not be matched to the document text, so it was left blank.'],
    disclaimer: 'Read automatically from the document text. It has not been checked with the issuing authority or any official source, so please review it.',
  },
  ai: { status: 'completed', provider: 'gemini', model: 'm', error: null },
  ...over,
});

/** The app with these documents already on the server when it loads. */
async function open(path: string, docs: DocumentView[], extra: { extraction?: Record<string, DocumentExtractionView | null>; activePollMs?: number } = {}) {
  const api = createFakeApi({ seed: false });
  api.stored.push(...docs);
  for (const [id, value] of Object.entries(extra.extraction ?? {})) api.finishReading(id, { extraction: value, ...docs.find((d) => d.id === id) });
  return renderApp(path, { api, activePollMs: extra.activePollMs });
}

const vaultOf = () => screen.getByRole('heading', { name: 'YOUR DOCUMENTS' }).closest('section')!;

describe('the Documents page', () => {
  it('shows each document with how far its reading has got', async () => {
    await open('/documents', [
      doc({ id: 'a', originalName: 'queued.pdf', processingStatus: 'queued', aiStatus: 'not_requested', detectedType: null }),
      doc({ id: 'b', originalName: 'busy.pdf', processingStatus: 'processing', aiStatus: 'not_requested', detectedType: null }),
      doc({ id: 'c', originalName: 'done.pdf' }),
      doc({ id: 'd', originalName: 'partial.pdf', processingStatus: 'partially_completed', aiStatus: 'unavailable', errorMessage: 'The text was read, but the AI analysis was not available just now.' }),
      doc({ id: 'e', originalName: 'bad.pdf', processingStatus: 'failed', aiStatus: 'not_requested', detectedType: null, errorMessage: 'No readable text was found in this PDF.' }),
    ]);
    const rows = within(vaultOf()).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    const byName = (name: string) => rows.find((r) => within(r).queryByText(new RegExp(name)))!;
    expect(within(byName('queued')).getByTestId('processing-status')).toHaveTextContent('Waiting to be read');
    expect(within(byName('busy')).getByTestId('processing-status')).toHaveTextContent('Reading...');
    expect(within(byName('done')).getByTestId('processing-status')).toHaveTextContent('Read');
    expect(within(byName('done')).getByText('AI details ready')).toBeInTheDocument();
    expect(within(byName('partial')).getByTestId('processing-status')).toHaveTextContent('Partly read');
    expect(within(byName('partial')).getByText('AI unavailable')).toBeInTheDocument();
    expect(within(byName('partial')).getByText(/AI analysis was not available just now/)).toBeInTheDocument();
    expect(within(byName('bad')).getByTestId('processing-status')).toHaveTextContent('Could not be read');
    expect(within(byName('bad')).getByText('No readable text was found in this PDF.')).toBeInTheDocument();
    // The file is safe on the server whatever happened to the reading.
    expect(within(vaultOf()).getAllByText('Stored')).toHaveLength(5);
  });

  it('follows a new upload until it has been read, then shows what it looks like', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { api } = await renderApp('/documents', { seed: false, activePollMs: 20 });
    await user.selectOptions(screen.getByLabelText('Document type'), 'trade_licence');
    await user.upload(screen.getByLabelText('Add document file'), pdf('licence.pdf'));
    expect(await screen.findByText('licence.pdf uploaded')).toBeInTheDocument();

    expect(within(vaultOf()).getByTestId('processing-status')).toHaveTextContent('Waiting to be read');
    api.finishReading(api.stored[0]!.id, { detectedType: 'trade_licence', aiStatus: 'completed' });
    await waitFor(() => expect(within(vaultOf()).getByTestId('processing-status')).toHaveTextContent('Read'));
    expect(within(vaultOf()).getByText('AI details ready')).toBeInTheDocument();
    expect(within(vaultOf()).getByText('Looks like: Trade licence')).toBeInTheDocument();
  });

  it('says why a document could not be read, and reads it again on request', async () => {
    const user = userEvent.setup();
    const { api } = await open('/documents', [doc({ processingStatus: 'failed', aiStatus: 'not_requested', detectedType: null, errorMessage: 'No readable text was found in this PDF.' })]);
    expect(within(vaultOf()).getByText('Could not be read')).toBeInTheDocument();
    await user.click(within(vaultOf()).getByRole('button', { name: 'Read licence.pdf again' }));
    expect(await within(vaultOf()).findByText('Waiting to be read')).toBeInTheDocument();
    expect(api.calls('documents.reprocess')).toBe(1);
    expect(within(vaultOf()).queryByText('No readable text was found in this PDF.')).not.toBeInTheDocument();
  });

  it('offers to read again only when that makes sense', async () => {
    await open('/documents', [doc({ id: 'a', originalName: 'busy.pdf', processingStatus: 'processing' }), doc({ id: 'b', originalName: 'done.pdf' })]);
    expect(screen.queryByRole('button', { name: 'Read busy.pdf again' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read done.pdf again' })).toBeInTheDocument();
  });

  it('tells the user when reading again is refused', async () => {
    const user = userEvent.setup();
    const { api } = await open('/documents', [doc()]);
    api.failNext('documents.reprocess', new ApiError(503, 'Document processing is not available right now. Please try again later.'));
    await user.click(screen.getByRole('button', { name: 'Read licence.pdf again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Document processing is not available right now');
  });

  it('asks before deleting, and deletes only when confirmed', async () => {
    const user = userEvent.setup();
    const { api } = await open('/documents', [doc(), doc({ id: 'doc-2', originalName: 'other.pdf' })]);
    await user.click(screen.getByRole('button', { name: 'Delete licence.pdf' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('licence.pdf will be removed, together with everything read from it');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.calls('documents.remove')).toBe(0);
    expect(within(vaultOf()).getAllByRole('listitem')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Delete licence.pdf' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete document' }));
    await waitFor(() => expect(within(vaultOf()).getAllByRole('listitem')).toHaveLength(1));
    expect(api.calls('documents.remove')).toBe(1);
    expect(api.stored.map((d) => d.id)).toEqual(['doc-2']);
  });

  it('keeps the document and says so when it could not be deleted', async () => {
    const user = userEvent.setup();
    const { api } = await open('/documents', [doc()]);
    api.failNext('documents.remove', new ApiError(500, 'Something went wrong. Please try again.'));
    await user.click(screen.getByRole('button', { name: 'Delete licence.pdf' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete document' }));
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
    expect(within(vaultOf()).getAllByRole('listitem')).toHaveLength(1);
  });

  it('treats a document that is already gone as deleted', async () => {
    const user = userEvent.setup();
    const { api } = await open('/documents', [doc()]);
    api.stored.length = 0;
    await user.click(screen.getByRole('button', { name: 'Delete licence.pdf' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete document' }));
    await waitFor(() => expect(screen.getByText('No documents yet')).toBeInTheDocument());
  });

  it('downloads the file from the server, and says when that fails', async () => {
    const user = userEvent.setup();
    const { api } = await open('/documents', [doc()]);
    await user.click(screen.getByRole('button', { name: 'Download licence.pdf' }));
    await waitFor(() => expect(api.calls('documents.file')).toBe(1));
    // The temporary link used to save the file is gone again.
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);

    api.failNext('documents.file', new ApiError(404, 'The file for this document is not available.'));
    await user.click(screen.getByRole('button', { name: 'Download licence.pdf' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The file for this document is not available.');
  });
});

describe('a document’s page', () => {
  it('shows the file, its status and what was read, keeping what the document says apart from what the AI made of it', async () => {
    await open('/documents/doc-1', [doc({ id: 'doc-1' })], { extraction: { 'doc-1': extraction() } });
    expect(await screen.findByRole('heading', { name: 'licence.pdf' })).toBeInTheDocument();
    expect(await screen.findByTitle('Preview of licence.pdf')).toHaveAttribute('src', expect.stringMatching(/^blob:/));

    const facts = screen.getByRole('region', { name: 'Details found in the document' });
    expect(within(facts).getByText('Licence number').nextSibling).toHaveTextContent('1234567');
    expect(within(facts).getByText('Business activities').nextSibling).toHaveTextContent('Marketing Consultancy, Design');
    expect(within(facts).getByText('Expiry date').nextSibling).toHaveTextContent('31/01/2027');
    // What the document does not say is shown as not found, never filled in.
    expect(within(facts).getByText('Legal form').nextSibling).toHaveTextContent('Not found');

    const ai = screen.getByRole('region', { name: 'What the AI made of it' });
    expect(ai).toHaveTextContent('An interpretation by an AI model. It can be wrong');
    expect(ai).toHaveTextContent('A trade licence for a marketing company.');
    expect(screen.getByText(/has not been checked with the issuing authority/)).toBeInTheDocument();
    expect(screen.getByText(/The text was read straight from the PDF\. 2 pages\./)).toBeInTheDocument();
    expect(screen.getByText(/not a check that the document is genuine/)).toBeInTheDocument();
  });

  it('shows an image as an image', async () => {
    await open('/documents/img', [doc({ id: 'img', originalName: 'scan.png', mimeType: 'image/png' })], { extraction: { img: extraction({ method: 'ocr', pageCount: 1 }) } });
    expect(await screen.findByRole('img', { name: 'Preview of scan.png' })).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    expect(screen.queryByTitle('Preview of scan.png')).not.toBeInTheDocument();
    expect(screen.getByText(/recognised from the image \(OCR\), so a few words may be wrong/)).toBeInTheDocument();
  });

  it('shows text as text, never as markup', async () => {
    const hostile = '<img src=x onerror="document.title=1"><script>alert(1)</script>';
    const base = extraction();
    const structured = { ...base.structured!, facts: { ...base.structured!.facts, companyName: hostile }, interpretation: { ...base.structured!.interpretation, summary: hostile } };
    await open('/documents/doc-1', [doc()], { extraction: { 'doc-1': { ...base, structured } } });
    const facts = await screen.findByRole('region', { name: 'Details found in the document' });
    expect(within(facts).getByText(hostile)).toBeInTheDocument();
    expect(document.querySelector('script, img[src="x"]')).toBeNull();
    expect(document.title).not.toBe('1');
  });

  it('keeps working when the stored reading is not in the expected shape', async () => {
    await open('/documents/doc-1', [doc()], { extraction: { 'doc-1': extraction({ structured: 'garbage' as never }) } });
    expect(await screen.findByRole('heading', { name: 'licence.pdf' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Details found in the document' })).not.toBeInTheDocument();
  });

  it('says plainly when there was no AI analysis, or it was not available', async () => {
    await open('/documents/a', [doc({ id: 'a', aiStatus: 'skipped' })], { extraction: { a: extraction({ structured: null, ai: { status: 'skipped', provider: null, model: null, error: null } }) } });
    expect(await screen.findByText('No AI analysis was done for this document.')).toBeInTheDocument();
  });

  it('follows a document that is being read, and then shows what was found', async () => {
    const { api } = await open('/documents/doc-1', [doc({ processingStatus: 'processing', aiStatus: 'not_requested', detectedType: null })], { activePollMs: 20 });
    expect(await screen.findByText('This document is being read. What is found will appear here.')).toBeInTheDocument();
    api.finishReading('doc-1', { aiStatus: 'completed', detectedType: 'trade_licence', extraction: extraction() });
    expect(await screen.findByRole('region', { name: 'Details found in the document' })).toBeInTheDocument();
    expect(screen.getByTestId('processing-status')).toHaveTextContent('Read');
  });

  it('explains a failure, and can try again', async () => {
    const user = userEvent.setup();
    const { api } = await open('/documents/doc-1', [doc({ processingStatus: 'failed', aiStatus: 'not_requested', detectedType: null, errorMessage: 'No readable text was found in this PDF.' })]);
    expect(await screen.findByText('Could not be read')).toBeInTheDocument();
    expect(screen.getAllByText(/No readable text was found in this PDF\./).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('processing-status')).toHaveTextContent('Waiting to be read'));
    expect(api.calls('documents.reprocess')).toBe(1);
  });

  it('offers a download when the preview cannot be shown, and can try the preview again', async () => {
    const user = userEvent.setup();
    const { api } = await open('/documents/doc-1', [doc()], { extraction: { 'doc-1': extraction() } });
    await screen.findByTitle('Preview of licence.pdf');
    // A second visit where the file cannot be fetched the first time.
    api.failNext('documents.file', new ApiError(404, 'The file for this document is not available.'));
    await user.click(screen.getByRole('link', { name: 'All documents' }));
    await user.click(await screen.findByRole('link', { name: 'Details for licence.pdf' }));
    const alert = await screen.findByText('The file for this document is not available.');
    expect(alert).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download instead' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTitle('Preview of licence.pdf')).toBeInTheDocument();
  });

  it('says so when the document does not exist, with a way back', async () => {
    await open('/documents/nope', []);
    expect(await screen.findByText('Document not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to documents' })).toHaveAttribute('href', '/documents');
  });

  it('deletes from here and goes back to the list', async () => {
    const user = userEvent.setup();
    const { api } = await open('/documents/doc-1', [doc()], { extraction: { 'doc-1': extraction() } });
    await user.click(await screen.findByRole('button', { name: 'Delete licence.pdf' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete document' }));
    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
    expect(api.stored).toHaveLength(0);
  });

  it('links to a document from its row', async () => {
    const user = userEvent.setup();
    await open('/documents', [doc()], { extraction: { 'doc-1': extraction() } });
    await user.click(screen.getByRole('link', { name: 'Details for licence.pdf' }));
    expect(await screen.findByRole('heading', { name: 'licence.pdf' })).toBeInTheDocument();
  });
});
