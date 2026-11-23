import { expect, pdf, say, stepsOf, test } from './fixtures';

/** Working Capital Finance has its own steps and its own wording, so it is tested on its own. */
test.describe.configure({ mode: 'serial' });

let reference = '';

test.describe('working capital finance', () => {
  test('a request is recorded, without offering, pricing or approving anything', async ({ page, account }) => {
    const before = ((await (await page.request.get('/api/applications')).json()).applications as unknown[]).length;
    // A fresh chat, as a person would start for a different request.
    await page.goto('/chat');
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(page.getByText('Start a company')).toHaveCount(1);
    await page.getByRole('button', { name: 'Working Capital Finance' }).click();
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.getByText(/does not offer, price or approve/).first()).toBeVisible();

    // The company named at sign-up is offered, and nothing else.
    await page.getByRole('button', { name: `Yes, use ${account.company}` }).click();

    // Zero and non-numbers are rejected. A question is not taken as an answer.
    await say(page, '0');
    await expect(page.getByText(/above zero/)).toBeVisible();
    await say(page, 'abc');
    await say(page, 'Can I get a loan at 3% interest?');
    await expect(page.getByText(/can't confirm fees, eligibility rules, legal requirements, approvals or financing terms/i)).toBeVisible();
    await say(page, 'AED 350,000');
    await page.getByRole('button', { name: 'Inventory' }).click();
    await expect(page.getByText(/6-month bank statement/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText(/summary of your request/i)).toBeVisible();
    // Nothing is recorded until the user confirms. (This account may already have other applications.)
    expect((await (await page.request.get('/api/applications')).json()).applications).toHaveLength(before);

    await page.getByRole('button', { name: 'Confirm & Submit' }).click();
    await expect(page.getByText(/has been recorded/)).toBeVisible();
    await expect(page.getByText(/does not offer, price or approve real financing/).first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/interest rate|you qualify|pre-approved|approved for/i);

    await page.getByRole('link', { name: 'View details' }).last().click();
    await expect(page).toHaveURL(/\/applications\/FIN-\d{4}-\d{6}$/);
    reference = page.url().split('/').pop() ?? '';
  });

  test('it has its own steps and never claims a submission', async ({ page }) => {
    await page.goto(`/applications/${reference}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Working Capital Finance' })).toBeVisible();
    await expect(page.getByTestId('status-badge')).toHaveText('Documents Pending');
    await expect.poll(() => stepsOf(page)).toEqual([
      'Request understood (done)',
      'Request confirmed (done)',
      'Documents and information received (current)',
      'Preparation (not started)',
      'Under review (not started)',
      'Completed (not started)',
    ]);
    await expect.poll(async () => (await stepsOf(page)).join(' ')).not.toContain('Submitted');
    await expect(page.getByText('Not applicable: the prototype records the request only')).toBeVisible();
    await expect(page.getByText('AED 350,000').first()).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Latest 6-month bank statement (needed)' })).toHaveCount(1);
    await expect(page.getByRole('listitem').filter({ hasText: 'Annual turnover (AED) (needed)' })).toHaveCount(1);
    // Nothing exists for an authority to act on yet.
    await expect(page.getByRole('region', { name: 'Prototype controls' })).toHaveCount(0);
  });

  test('the document alone does not unlock preparation, and the answer in chat does', async ({ page }) => {
    await page.goto(`/applications/${reference}`);
    await page.getByRole('button', { name: 'Continue in chat' }).click();
    await expect(page.getByText(/We need your latest 6-month bank statement to continue working capital finance/)).toBeVisible();

    await page.setInputFiles('[data-testid="composer-file-input"]', pdf('bank-statement'));
    await expect(page.getByText(/Still outstanding: Annual turnover \(AED\)/)).toBeVisible();

    await page.goto(`/applications/${reference}`);
    await expect(page.getByTestId('status-badge')).toHaveText('Information Required');
    await expect.poll(async () => (await stepsOf(page))[2]).toBe('Documents and information received (current)');
    await expect.poll(async () => (await stepsOf(page))[3]).toBe('Preparation (not started)');

    // The information request is answered in chat.
    await page.getByRole('button', { name: 'Continue in chat' }).click();
    await expect(page.getByText(/We need one more detail/)).toBeVisible();
    // A question is not saved as the answer.
    await say(page, 'What is turnover?');
    await expect(page.getByText(/Annual turnover/i).last()).toBeVisible();
    await say(page, '2,400,000');
    await expect(page.getByText(/I've saved that/)).toBeVisible();

    await page.goto(`/applications/${reference}`);
    await expect(page.getByTestId('status-badge')).toHaveText('Preparation');
    await expect.poll(() => stepsOf(page)).toEqual([
      'Request understood (done)',
      'Request confirmed (done)',
      'Documents and information received (done)',
      'Preparation (done)',
      'Under review (current)',
      'Completed (not started)',
    ]);
    // The answer is shown once.
    await expect(page.getByText('2,400,000', { exact: true })).toHaveCount(1);
  });

  test('only the labelled simulation can record the later steps', async ({ page }) => {
    await page.goto(`/applications/${reference}`);
    await page.getByRole('button', { name: 'Simulate: Under review' }).click();
    await expect(page.getByTestId('status-badge')).toHaveText('Under Review');
    await page.getByRole('button', { name: 'Simulate: Completed' }).click();
    await expect(page.getByTestId('status-badge')).toHaveText('Completed');
    await expect.poll(async () => (await stepsOf(page)).join(' ')).not.toContain('Submitted');
    await expect(page.getByText('Simulated').first()).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('status-badge')).toHaveText('Completed');
  });
});
