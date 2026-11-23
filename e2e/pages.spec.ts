import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, expectNoHorizontalScroll, test, watchForProblems } from './fixtures';

/**
 * Every page, on a desktop window and on a phone: it renders, has no script or server errors,
 * never needs sideways scrolling, and uses the right navigation for the screen size.
 * Screenshots are written to docs/e2e for a visual check.
 */

const SHOTS = path.resolve(__dirname, '..', 'docs', 'e2e');
let reference = '';

test.beforeAll(async ({ browser, baseURL, account }) => {
  mkdirSync(SHOTS, { recursive: true });
  // Something to look at: one finance request waiting for its document and an answer.
  const context = await browser.newContext({ baseURL, storageState: account.state as never });
  const response = await context.request.post('/api/applications', { data: { service: 'working_capital_finance', finance: { amount: 250000, purpose: 'Equipment' } } });
  expect(response.status()).toBe(201);
  reference = (await response.json()).application.id;
  await context.close();
});

const PAGES: Array<{ slug: string; path: () => string; heading: string | RegExp }> = [
  { slug: 'dashboard', path: () => '/dashboard', heading: 'What can Tajir help you with today?' },
  { slug: 'chat', path: () => '/chat', heading: 'Chat with Tajir' },
  { slug: 'company-setup', path: () => '/company-setup', heading: 'Company setup' },
  { slug: 'review', path: () => '/company-setup/review', heading: 'Review and submit' },
  { slug: 'applications', path: () => '/applications', heading: 'Applications' },
  { slug: 'application-detail', path: () => `/applications/${reference}`, heading: 'Working Capital Finance' },
  { slug: 'activity', path: () => '/activity', heading: 'Activity' },
  { slug: 'documents', path: () => '/documents', heading: 'Documents' },
  { slug: 'profile', path: () => '/profile', heading: 'Profile' },
  { slug: 'design', path: () => '/design', heading: 'Design system' },
  { slug: 'not-found', path: () => '/no-such-page', heading: 'Page not found' },
];

for (const entry of PAGES) {
  test(`${entry.slug} renders cleanly and fits the screen`, async ({ page }, testInfo) => {
    const problems = watchForProblems(page);
    await page.goto(entry.path());
    await expect(page.getByRole('heading', { level: 1, name: entry.heading })).toBeVisible();
    await expect(page.getByText('Loading your data...')).toHaveCount(0);

    await expectNoHorizontalScroll(page);
    const mobile = testInfo.project.name === 'mobile';
    await expect(page.getByRole('navigation', { name: mobile ? 'Primary mobile' : 'Primary', exact: true })).toBeVisible();
    // The other navigation is hidden on this screen size, so it is not in the accessibility tree at all.
    await expect(page.getByRole('navigation', { name: mobile ? 'Primary' : 'Primary mobile', exact: true })).toHaveCount(0);
    // The prototype notice is always on screen, so nobody mistakes this for a real filing.
    await expect(page.getByText(/Prototype · sample data · nothing is filed with any authority/)).toBeVisible();

    await page.screenshot({ path: path.join(SHOTS, `${testInfo.project.name}-${entry.slug}.png`), fullPage: true });
    expect(problems).toEqual([]);
  });
}

test('the chat box is never hidden behind the bottom bar', async ({ page }, testInfo) => {
  await page.goto('/chat');
  const input = page.getByLabel('Message Tajir');
  await expect(input).toBeVisible();
  if (testInfo.project.name === 'mobile') {
    const inputBox = (await input.boundingBox())!;
    const navBox = (await page.getByRole('navigation', { name: 'Primary mobile', exact: true }).boundingBox())!;
    expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(navBox.y + 1);
  }
  await input.fill('hello');
  await input.press('Enter');
  await expect(page.getByText(/Hello Aisha!/)).toBeVisible();
  await expect(input).toBeInViewport();
});

test('navigation reaches every main page', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  await page.goto('/dashboard');
  const nav = page.getByRole('navigation', { name: mobile ? 'Primary mobile' : 'Primary', exact: true });
  for (const [label, heading] of [
    ['Activity', 'Activity'],
    ['Documents', 'Documents'],
    ['Profile', 'Profile'],
    ['Home', 'What can Tajir help you with today?'],
  ] as const) {
    await nav.getByRole('link', { name: label }).click();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(nav.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
  }
});

test('an unknown application reference says so, and the app keeps working', async ({ page }) => {
  await page.goto('/applications/REG-2026-999999');
  await expect(page.getByText('Application not found')).toBeVisible();
  await page.getByRole('link', { name: 'Back to applications' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Applications' })).toBeVisible();
});

test('the header starts a fresh chat', async ({ page }) => {
  await page.goto('/chat');
  await page.getByLabel('Message Tajir').fill('hello again');
  await page.getByLabel('Message Tajir').press('Enter');
  await expect(page.getByText(/Hello Aisha!/).last()).toBeVisible();
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByText('hello again')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start a company' })).toBeVisible();
});

test('the chat says plainly when no AI model is connected', async ({ page }) => {
  await page.goto('/chat');
  const note = page.getByRole('note');
  await expect(note).toContainText('The AI assistant is not connected');
  await expect(note).toContainText('cannot answer general questions');
  // A general question gets the guided reply, not a made-up answer.
  await page.getByLabel('Message Tajir').fill('What is the capital of France?');
  await page.getByLabel('Message Tajir').press('Enter');
  await expect(page.getByText(/did not quite get that/i).last()).toBeVisible();
});
