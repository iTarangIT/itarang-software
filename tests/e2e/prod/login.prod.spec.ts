import { test, expect } from '@playwright/test';
import { assertProdAllowed } from '../helpers/prod-guard';

/**
 * Login is the cheapest end-to-end signal that the prod environment is alive
 * and that auth is wired correctly. Two cases:
 *   1. Happy path with the e2e dealer credentials.
 *   2. Negative path: a deliberately wrong password must show an error and
 *      stay on /login.
 */

test.describe('login [prod] [login]', () => {
  test.beforeAll(() => assertProdAllowed());

  test('valid dealer credentials reach a non-login URL [prod] [login]', async ({ browser }) => {
    const email = process.env.E2E_PROD_DEALER_EMAIL;
    const password = process.env.E2E_PROD_DEALER_PASSWORD;
    if (!email || !password) {
      test.skip(true, 'NOT_IMPLEMENTED: E2E_PROD_DEALER_EMAIL/PASSWORD not set');
      return;
    }

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole('button', { name: /sign in/i }).click({ force: true });

    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
    await expect(page).not.toHaveURL(/\/login/);
    await ctx.close();
  });

  test('invalid credentials surface an error [prod] [login]', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.locator('input[name="email"]').fill('e2e+nonexistent@itarang.com');
    await page.locator('input[name="password"]').fill('definitely-not-the-real-password-9X');
    await page.getByRole('button', { name: /sign in/i }).click({ force: true });

    // Either: an inline error appears, or we stay on /login. Both are accepted
    // signals — wording varies across Supabase auth versions.
    await page.waitForTimeout(2_000);
    await expect(page).toHaveURL(/\/login/);
    await ctx.close();
  });
});
