import { expect, pdf, say, stepsOf, test, watchForProblems } from './fixtures';

/**
 * The whole company setup journey in a real browser: chat, review and edit, submission,
 * missing documents, clarification, uploads, status changes and completion.
 * One signed-in account per project runs the steps in order.
 */
test.describe.configure({ mode: 'serial' });

let reference = '';

test.describe('company setup', () => {
  test('chat guides the user from the first message to a recorded application', async ({ page, account }) => {
    const problems = watchForProblems(page);
    await page.goto('/dashboard');
    await expect(page.getByText(new RegExp(`^Good (morning|afternoon|evening), ${account.firstName}$`))).toBeVisible();
    // A new account has nothing waiting, and no invented reminders.
    await expect(page.getByRole('region', { name: 'Most urgent' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Start a company' }).click();
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.getByText('Which type of company would you like to set up?').or(page.getByText(/Mainland|Free Zone|Offshore/).first())).toBeVisible();

    // Offshore needs proof of source of funds on top of the three common documents, and this account has none.
    await page.getByRole('button', { name: 'Select Offshore' }).click();
    await page.getByRole('button', { name: 'Show me popular offshore jurisdictions' }).click();
    await page.getByRole('button', { name: 'Select Ras Al Khaimah Offshore' }).click();

    // Typing a question instead of an answer is not taken as the answer.
    await page.getByRole('button', { name: 'Media & Marketing' }).click();
    await say(page, 'How much does it cost?');
    await expect(page.getByText(/can't confirm fees/i)).toBeVisible();
    await say(page, 'Dunes Media');
    await page.getByRole('button', { name: '2', exact: true }).click();
    await page.getByRole('button', { name: 'Skip' }).click();
    await page.getByRole('button', { name: /Select package Starter package/ }).click();

    await expect(page.getByText(/Here's a summary of your new company setup/)).toBeVisible();
    await expect(page.getByText('Dunes Media').first()).toBeVisible();
    await expect(page.getByText(/4 still needed/)).toBeVisible();
    await expect(page.getByText(/Proof of source of funds/).first()).toBeVisible();

    // Nothing is recorded until the user confirms.
    expect((await (await page.request.get('/api/applications')).json()).applications).toHaveLength(0);
    expect(problems).toEqual([]);
  });

  test('the draft can be reviewed and edited, then submitted', async ({ page }) => {
    await page.goto('/company-setup');
    await expect(page.getByRole('list', { name: 'Registration steps' })).toBeVisible();
    await page.getByRole('button', { name: 'Review & submit' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Review and submit' })).toBeVisible();

    // A bad edit is stopped by the form. A good one is saved on the server.
    await page.getByRole('button', { name: 'Edit Business details' }).click();
    await page.getByLabel('Company name').fill('D');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/at least 2 characters/)).toBeVisible();
    await page.getByLabel('Company name').fill('Dunes Media FZ');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Dunes Media FZ').first()).toBeVisible();
    await page.reload();
    await expect(page.getByText('Dunes Media FZ').first()).toBeVisible();

    await page.getByRole('button', { name: 'Confirm & Submit' }).click();
    const dialog = page.getByRole('dialog', { name: 'Submit this application?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Yes, submit' }).click();

    await expect(page).toHaveURL(/\/applications\/REG-\d{4}-\d{6}$/);
    reference = page.url().split('/').pop() ?? '';
    await expect(page.getByRole('status').first()).toContainText('Submitted. Your request is recorded');
    await expect(page.getByRole('status').first()).toContainText('Nothing is filed with any authority');
    await expect(page.getByRole('heading', { level: 1, name: 'Company Registration' })).toBeVisible();
    await expect(page.getByTestId('status-badge')).toHaveText('Documents Pending');
  });

  test('progress shows only what has happened, and the missing documents are listed', async ({ page }) => {
    await page.goto(`/applications/${reference}`);
    await expect.poll(() => stepsOf(page)).toEqual([
      'Request understood (done)',
      'Details confirmed (done)',
      'Documents ready (current)',
      'Submitted (not started)',
      'Under review (not started)',
      'Completed (not started)',
    ]);
    await expect(page.getByText('Action required')).toBeVisible();
    await expect(page.getByText('Not submitted yet')).toBeVisible();
    // The labelled simulation is offered only for steps that need an authority, and not yet.
    await expect(page.getByRole('region', { name: 'Prototype controls' })).toHaveCount(0);
    for (const label of ['Passport copy', 'Emirates ID or residence visa', 'Proof of address', 'Proof of source of funds']) {
      await expect(page.getByRole('listitem').filter({ hasText: `${label} (needed)` })).toHaveCount(1);
    }
  });

  test('clarification in chat, then each document is uploaded and stored', async ({ page }) => {
    await page.goto(`/applications/${reference}`);
    await page.getByRole('button', { name: 'Continue in chat' }).click();
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.getByText(/We need your passport copy/i)).toBeVisible();

    // Wrong kinds of file are refused before anything is sent.
    await page.setInputFiles('[data-testid="composer-file-input"]', { name: 'virus.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') });
    await expect(page.getByRole('alert')).toContainText('Please upload a PDF, PNG or JPG file.');
    // A file whose content is not what its name says is refused by the server.
    await page.setInputFiles('[data-testid="composer-file-input"]', { name: 'fake.pdf', mimeType: 'application/pdf', buffer: Buffer.from('this is plain text, not a pdf') });
    await expect(page.getByRole('alert')).toContainText(/content/i);

    // The four real files.
    const wanted = ['passport', 'emirates id', 'proof of address', 'proof of source of funds'];
    for (const [index, label] of wanted.entries()) {
      await page.setInputFiles('[data-testid="composer-file-input"]', pdf(label.replace(/ /g, '-')));
      await expect(page.getByText(new RegExp(`I've recorded your ${label}`, 'i'))).toBeVisible();
      if (index < wanted.length - 1) await expect(page.getByText(/Still outstanding/).last()).toBeVisible();
    }
    await expect(page.getByText(/That's everything we need for now/)).toBeVisible();
    await expect(page.getByText(/stored on this prototype's server/).first()).toBeVisible();
    // Nothing else is waiting for a document, but a file can still be attached for Tajir to read.
    await expect(page.getByTitle('Attach a document for Tajir to read')).toBeEnabled();
  });

  test('the application moved on by itself, and only the labelled simulation finishes it', async ({ page }) => {
    await page.goto(`/applications/${reference}`);
    await expect(page.getByTestId('status-badge')).toHaveText('Submitted');
    await expect.poll(() => stepsOf(page)).toEqual([
      'Request understood (done)',
      'Details confirmed (done)',
      'Documents ready (done)',
      'Submitted (done)',
      'Under review (current)',
      'Completed (not started)',
    ]);
    await expect(page.getByText('Action required')).toHaveCount(0);
    await expect(page.getByText('Document recorded: Proof of source of funds')).toBeVisible();

    const controls = page.getByRole('region', { name: 'Prototype controls' });
    await controls.getByRole('button', { name: 'Simulate: Under review' }).click();
    await expect(page.getByTestId('status-badge')).toHaveText('Under Review');
    await expect(page.getByText('Under review (simulated)')).toBeVisible();
    await page.getByRole('button', { name: 'Simulate: Completed' }).click();
    await expect(page.getByTestId('status-badge')).toHaveText('Completed');
    await expect.poll(async () => (await stepsOf(page)).every((s) => s.endsWith('(done)'))).toBe(true);
    await expect(page.getByText('6 of 6 steps done')).toBeVisible();

    // The server holds it: a reload shows the same.
    await page.reload();
    await expect(page.getByTestId('status-badge')).toHaveText('Completed');
  });

  test('activity and documents show the same story', async ({ page }) => {
    await page.goto('/activity');
    await page.getByRole('tab', { name: 'Completed' }).click();
    await expect(page.getByText(new RegExp(reference))).toBeVisible();
    await page.getByRole('tab', { name: 'Needs Action' }).click();
    await expect(page.getByText('Nothing needs your attention right now.')).toBeVisible();

    await page.goto('/documents');
    await expect(page.getByRole('note')).toContainText("Stored in this prototype's database");
    const list = page.getByRole('heading', { name: 'YOUR DOCUMENTS' }).locator('xpath=ancestor::section[1]');
    await expect(list.getByText(`for ${reference}`).first()).toBeVisible();
    await expect(list.getByText('Stored')).toHaveCount(4);

    // The server really has four files for this account. Each can be opened or downloaded again by its owner.
    const documents = (await (await page.request.get('/api/documents')).json()).documents as Array<{ originalName: string; mimeType: string; applicationId: string }>;
    expect(documents).toHaveLength(4);
    expect(documents.every((d) => d.mimeType === 'application/pdf' && d.applicationId === reference)).toBe(true);
    await expect(list.getByRole('button', { name: /^Download / })).toHaveCount(4);
    const first = documents[0]!;
    const file = await page.request.get(`/api/documents/${(await (await page.request.get('/api/documents')).json()).documents[0].id}/download`);
    expect(file.status()).toBe(200);
    expect(file.headers()['content-type']).toBe('application/pdf');
    expect(file.headers()['content-disposition']).toContain(`filename="${first.originalName}"`);
    expect(file.headers()['cache-control']).toBe('private, no-store');
    expect((await file.body()).subarray(0, 5).toString()).toBe('%PDF-');
  });
});
