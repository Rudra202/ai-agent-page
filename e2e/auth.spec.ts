import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, PASSWORD, uniqueEmail, watchForProblems } from './fixtures';

/** Registration, sign-in and sign-out in a real browser, starting signed out. */

test.describe('signed out', () => {
  test('protected pages send a visitor to sign in, and they come back after signing in', async ({ page }) => {
    for (const path of ['/dashboard', '/chat', '/applications', '/documents', '/activity', '/profile']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
    }
  });

  test('the sign-in and sign-up forms check input before asking the server', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Enter your email address')).toBeVisible();
    await expect(page.getByText('Enter your password')).toBeVisible();

    await page.getByRole('link', { name: 'Create an account' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Create your account' })).toBeVisible();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Enter your name')).toBeVisible();
    await page.getByLabel('Your name').fill('Test Person');
    await page.getByLabel('Email').fill('test@example.com');
    await page.getByLabel('Password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Use at least 8 characters').last()).toBeVisible();
  });

  test('a wrong password and an unknown email give the same answer', async ({ page }) => {
    await page.goto('/login');
    for (const email of ['nobody@example.com', 'also-nobody@example.com']) {
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill('wrong-password-1');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('alert')).toHaveText('Invalid email or password');
      await expect(page).toHaveURL(/\/login$/);
    }
  });

  test('registering, signing out and signing back in', async ({ page }, testInfo) => {
    const problems = watchForProblems(page);
    const email = uniqueEmail(`auth-${testInfo.project.name}`);

    // Sign up.
    await page.goto('/register');
    await page.getByLabel('Your name').fill('Layla Hassan');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByLabel(/Company name/).fill('Hassan Imports LLC');
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { level: 1, name: 'What can Tajir help you with today?' })).toBeVisible();
    await expect(page.getByText(/^Good (morning|afternoon|evening), Layla$/)).toBeVisible();
    await expect(page.getByText('Hassan Imports LLC').first()).toBeVisible();
    await expectNoHorizontalScroll(page);

    // The session survives a reload and cannot be reached from a sign-in page.
    await page.reload();
    await expect(page.getByText(/^Good (morning|afternoon|evening), Layla$/)).toBeVisible();
    await page.goto('/login');
    await expect(page).toHaveURL(/\/dashboard$/);

    // Sign out from the profile.
    await page.goto('/profile');
    await expect(page.getByText(email)).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/applications');
    await expect(page).toHaveURL(/\/login$/);
    // The server no longer knows this browser.
    expect((await page.request.get('/api/auth/me')).status()).toBe(401);
    expect((await page.request.get('/api/applications')).status()).toBe(401);

    // Sign in again.
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Signing in returns to the page the visitor was sent away from.
    await expect(page).toHaveURL(/\/applications$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Applications' })).toBeVisible();
    await page.goto('/dashboard');
    await expect(page.getByText(/^Good (morning|afternoon|evening), Layla$/)).toBeVisible();

    // The same email cannot be registered twice.
    await page.getByRole('link', { name: 'Profile' }).first().click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.goto('/register');
    await page.getByLabel('Your name').fill('Someone Else');
    await page.getByLabel('Email').fill(email.toUpperCase());
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toHaveText('An account with this email already exists');

    // 401s from "who am I" are expected while signed out. Nothing else should have gone wrong.
    expect(problems.filter((p) => !p.includes('401') && !p.includes('409'))).toEqual([]);
  });
});
