import { test as setup, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const AUTH_DIR = path.join('tests', '.auth');
fs.mkdirSync(AUTH_DIR, { recursive: true });

// The full-flow orchestrator only depends on anirudh's storage state.
// The dealer entry is used by the DigiLocker Aadhaar KYC spec and the
// (currently skipped) kyc.spec.ts.
const rolesToAuth = [
  { role: 'sales_head', email: 'anirudh@itarang.com', password: process.env.E2E_TEST_PASSWORD },
  { role: 'dealer', email: 'dealer@itarang.com', password: 'password' },
];

for (const { role, email, password } of rolesToAuth) {
  setup(`authenticate as ${role}`, async ({ page }) => {
    if (!password) {
      throw new Error(`Missing password for ${role}. Set E2E_TEST_PASSWORD in .env.test.local`);
    }

    await page.goto('/login');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    // `force: true` bypasses Playwright's pointer-events check — the login
    // page's decorative rickshaw <img> sits above the form in the DOM stack
    // and intercepts the hit-test even though the button is visible.
    await page.getByRole('button', { name: /sign in/i }).click({ force: true });

    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
    await expect(page).not.toHaveURL(/\/change-password/);

    await page.context().storageState({
      path: path.join(AUTH_DIR, `${role}.json`),
    });
  });
}
