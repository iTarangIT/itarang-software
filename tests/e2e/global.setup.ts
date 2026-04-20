import { test as setup, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const AUTH_DIR = path.join('tests', '.auth');
fs.mkdirSync(AUTH_DIR, { recursive: true });

// The full-flow orchestrator only depends on anirudh's storage state.
// The new dealer (window 2) logs in fresh inside the test using credentials
// minted by helpers/dealer-creds.ts — there is no pre-seeded dealer to auth.
const rolesToAuth = [
  { role: 'sales_head', email: 'anirudh@itarang.com' },
];

for (const { role, email } of rolesToAuth) {
  setup(`authenticate as ${role}`, async ({ page }) => {
    const password = process.env.E2E_TEST_PASSWORD;
    if (!password) {
      throw new Error('Set E2E_TEST_PASSWORD in .env.test.local');
    }

    await page.goto('/login');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole('button', { name: /sign in/i }).click();

    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
    await expect(page).not.toHaveURL(/\/change-password/);

    await page.context().storageState({
      path: path.join(AUTH_DIR, `${role}.json`),
    });
  });
}
