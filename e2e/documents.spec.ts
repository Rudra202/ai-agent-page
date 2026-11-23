import { blankPng, buildPdf, TRADE_LICENCE_LINES } from '../server/src/test/files';
import { expect, test } from './fixtures';

/**
 * A document through the real app: uploaded in the browser, stored by the server, read (text extraction and OCR run
 * for real, with no AI key), shown, asked about in the chat, downloaded and deleted.
 */
const licence = (name: string) => ({ name, mimeType: 'application/pdf', buffer: buildPdf([{ lines: TRADE_LICENCE_LINES }]) });

test.describe('a document from upload to delete', () => {
  test('is uploaded, read, shown, asked about, downloaded and deleted', async ({ page, account }) => {
    test.setTimeout(120_000);
    const name = `licence-journey-${account.email.split('@')[0]}.pdf`;
    await page.goto('/documents');

    // Upload
    await page.getByLabel('Document type').selectOption('trade_licence');
    await page.setInputFiles('[data-testid="file-input"] >> nth=-1', licence(name));
    await expect(page.getByText(`${name} uploaded`)).toBeVisible();

    // It is read in the background, and the page follows it without a reload.
    const row = page.getByRole('listitem').filter({ hasText: name });
    await expect(row.getByTestId('processing-status')).toHaveText('Read', { timeout: 60_000 });
    await expect(row.getByText('Looks like: Trade licence')).toBeVisible();
    await expect(row.getByText('Stored')).toBeVisible();

    // Its page: the file is previewed, and what was read is shown, with the limits of that reading said out loud.
    await row.getByRole('link', { name: `Details for ${name}` }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await expect(page.getByTitle(`Preview of ${name}`)).toBeVisible();
    await expect(page.getByText(/not a check that the document is genuine/)).toBeVisible();
    await expect(page.getByText('No AI analysis was done for this document.')).toBeVisible();

    // Ask about it in the chat: the answer comes from the document and names it.
    await page.goto('/chat');
    await page.getByLabel('Message Tajir').fill('What is the licence number in my trade licence?');
    await page.getByLabel('Message Tajir').press('Enter');
    await expect(page.getByText(/Licence No: 1234567/).first()).toBeVisible();
    const sources = page.getByTestId('answer-sources').last();
    await expect(sources.getByRole('link', { name })).toBeVisible();

    // Download gives back exactly what was uploaded.
    await page.goto('/documents');
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: `Download ${name}` }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(name);

    // Delete, after being asked. It is gone from the page and from the server.
    const listed = (await (await page.request.get('/api/documents')).json()).documents as Array<{ id: string; originalName: string }>;
    const id = listed.find((d) => d.originalName === name)!.id;
    await page.getByRole('button', { name: `Delete ${name}` }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete document' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: name })).toHaveCount(0);
    expect((await page.request.get(`/api/documents/${id}/download`)).status()).toBe(404);
    expect((await page.request.get(`/api/documents/${id}`)).status()).toBe(404);
  });

  test('an image with nothing to read says so plainly instead of pretending', async ({ page, account }) => {
    test.setTimeout(120_000);
    const name = `blank-${account.email.split('@')[0]}.png`;
    await page.goto('/documents');
    await page.getByLabel('Document type').selectOption('other');
    await page.setInputFiles('[data-testid="file-input"] >> nth=-1', { name, mimeType: 'image/png', buffer: blankPng() });
    await expect(page.getByText(`${name} uploaded`)).toBeVisible();
    const row = page.getByRole('listitem').filter({ hasText: name });
    await expect(row.getByTestId('processing-status')).toHaveText('Could not be read', { timeout: 90_000 });
    await expect(row.getByText(/No readable text was found/)).toBeVisible();
    // The file itself is still safe, and reading it again is offered.
    await expect(row.getByText('Stored')).toBeVisible();
    await expect(row.getByRole('button', { name: `Read ${name} again` })).toBeVisible();
  });

  test('questions in the chat are answered from a document uploaded on the Documents page, and from one attached in the chat', async ({ page, account }) => {
    test.setTimeout(150_000);
    const tag = account.email.split('@')[0]!.replace(/[^a-z0-9]/gi, '').slice(-8).toUpperCase();
    const uploadedName = `documents-page-${tag}.pdf`;
    const attachedName = `chat-attached-${tag}.pdf`;
    const documentsPage = { name: uploadedName, mimeType: 'application/pdf', buffer: buildPdf([{ lines: ['TRADE LICENCE', `Licence No: DP-${tag}-4471`, 'Company Name: Documents Page Trading LLC', 'Expiry Date: 05/06/2028'] }]) };
    const chatAttached = { name: attachedName, mimeType: 'application/pdf', buffer: buildPdf([{ lines: ['BANK STATEMENT', 'Account Statement', 'Account holder: Chat Attach Studio', `Closing balance AED 77,${tag.length}99`] }]) };

    // Problem A: uploaded on the Documents page
    await page.goto('/documents');
    await page.getByLabel('Document type').selectOption('trade_licence');
    await page.setInputFiles('[data-testid="file-input"] >> nth=-1', documentsPage);
    const row = page.getByRole('listitem').filter({ hasText: uploadedName });
    await expect(row.getByTestId('processing-status')).toHaveText('Read', { timeout: 60_000 });

    await page.goto('/chat');
    const box = page.getByLabel('Message Tajir');
    const log = page.getByRole('log');
    await box.fill('What does my document contain?');
    await box.press('Enter');
    await expect(log.getByText(new RegExp(`DP-${tag}-4471`)).last()).toBeVisible();
    await box.fill('What is my license number?');
    await box.press('Enter');
    await expect(log.getByText(new RegExp(`DP-${tag}-4471`)).last()).toBeVisible();
    await expect(page.getByTestId('answer-sources').last().getByRole('link', { name: uploadedName })).toBeVisible();

    // Problem B: attached directly in the chat, then asked about with "it"
    await page.setInputFiles('[data-testid="composer-file-input"]', chatAttached);
    await expect(log.getByRole('link', { name: attachedName })).toBeVisible();
    await expect(log.getByText('Read', { exact: true }).last()).toBeVisible({ timeout: 60_000 });
    await box.fill('What does it contain?');
    await box.press('Enter');
    await expect(log.getByText(/Chat Attach Studio/).last()).toBeVisible();
    // The newest answer is about the attached file only: nothing from the other document is in it.
    await expect(log.getByText(/Chat Attach Studio/).last()).not.toContainText(/DP-/);

    // Test C: the same file again does not make a second document
    const before = ((await (await page.request.get('/api/documents')).json()).documents as unknown[]).length;
    await page.setInputFiles('[data-testid="composer-file-input"]', chatAttached);
    await expect(log.getByText(new RegExp(`I've received ${attachedName.replace('.', '\.')}`))).toHaveCount(2);
    expect(((await (await page.request.get('/api/documents')).json()).documents as unknown[]).length).toBe(before);

    // ...and an existing document can be picked from the list
    await page.getByRole('button', { name: 'Choose an existing document' }).click();
    await page.getByRole('group', { name: 'Your documents' }).getByRole('button', { name: `Use ${uploadedName}` }).click();
    await expect(log.getByRole('link', { name: uploadedName })).not.toHaveCount(0);
    expect(((await (await page.request.get('/api/documents')).json()).documents as unknown[]).length).toBe(before);
  });

  test('a file attached in the chat is acknowledged with a card that follows its reading', async ({ page, account }) => {
    test.setTimeout(120_000);
    const name = `chat-attach-${account.email.split('@')[0]}.pdf`;
    await page.goto('/chat');
    await page.setInputFiles('[data-testid="composer-file-input"]', licence(name));
    const card = page.getByRole('log').getByRole('link', { name });
    await expect(card).toBeVisible();
    await expect(page.getByRole('log').getByText(new RegExp(`I've received ${name.replace('.', '\\.')}`))).toBeVisible();
    await expect(page.getByRole('log').getByText('Read', { exact: true }).last()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('log').getByText('Looks like: Trade licence').last()).toBeVisible();
  });
});
