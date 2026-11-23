import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

export { expect };

export interface Account {
  name: string;
  firstName: string;
  email: string;
  password: string;
  company: string;
  /** The signed-in browser state, so tests start signed in without going through the form. */
  state: { cookies: Array<Record<string, unknown>>; origins: Array<Record<string, unknown>> };
}

let counter = 0;
export const uniqueEmail = (label: string) => `${label}-${Date.now().toString(36)}-${(counter += 1)}@example.com`;
export const PASSWORD = 'e2e-test-passphrase-1';

/** A real PDF header, so the server's content check accepts it. */
export const pdf = (label: string) => ({ name: `${label}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF`) });

/**
 * Tests that need an account share one per project, created through the real sign-up API,
 * and start signed in. (The server limits sign-ups per hour, so accounts are not made per test.)
 * Tests that must start signed out import `test` from '@playwright/test' instead.
 */
export const test = base.extend<object, { account: Account }>({
  account: [
    async ({ browser }, use, workerInfo) => {
      const baseURL = workerInfo.project.use.baseURL;
      const context = await browser.newContext({ baseURL });
      const email = uniqueEmail(`e2e-${workerInfo.project.name}`);
      const account = { name: 'Aisha Rahman', firstName: 'Aisha', email, password: PASSWORD, company: 'Rahman Trading LLC' };
      const response = await context.request.post('/api/auth/register', {
        data: { name: account.name, email, password: PASSWORD, company: account.company },
        headers: { Origin: baseURL ?? '' },
      });
      expect(response.status(), 'sign-up through the API').toBe(201);
      const state = await context.storageState();
      await context.close();
      await use({ ...account, state: state as Account['state'] });
    },
    { scope: 'worker' },
  ],
  storageState: async ({ account }, use) => {
    await use(account.state as never);
  },
});

/** Collects what a real person would find broken: script errors, console errors and server errors. */
export function watchForProblems(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`script error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()} (${message.location().url})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 500) problems.push(`server error ${response.status()}: ${response.url()}`);
  });
  return problems;
}

/** The page never needs sideways scrolling, on any screen size. */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'horizontal overflow in pixels').toBeLessThanOrEqual(1);
}

/** Types into the chat box and sends. */
export async function say(page: Page, text: string) {
  const box = page.getByLabel('Message Tajir');
  await box.fill(text);
  await box.press('Enter');
}

/** The step list of the open application. Use inside expect.poll, because it changes as the server answers. */
export const stepsOf = async (page: Page): Promise<string[]> =>
  (await page.getByRole('list', { name: 'Application steps' }).getByRole('listitem').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').replace(/\d{4}-\d{2}-\d{2}/, '').replace('Simulated', '').trim());
