import { test as setup, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const AUTH_DIR = path.join('tests', '.auth');
fs.mkdirSync(AUTH_DIR, { recursive: true });

const baseURL = process.env.E2E_BASE_URL ?? 'https://sandbox.itarang.com';
const isProd = /crm\.itarang\.com/i.test(baseURL);

/**
 * Auth pairs depend on the host:
 *   - Sandbox uses the long-standing seeded users baked into that environment.
 *   - Prod must be explicitly provisioned and credentials provided via env;
 *     storage state lands in prod-*.json so a sandbox run can never overwrite
 *     a prod auth blob (and vice versa).
 */
const sandboxRoles = [
  { role: 'sales_head', email: 'anirudh@itarang.com', password: process.env.E2E_TEST_PASSWORD },
  { role: 'dealer', email: 'dealer@itarang.com', password: 'password' },
];

const prodRoles = [
  {
    role: 'sales_head',
    email: process.env.E2E_PROD_SH_EMAIL,
    password: process.env.E2E_PROD_SH_PASSWORD,
    stateFile: 'prod-sales_head.json',
  },
  {
    role: 'dealer',
    email: process.env.E2E_PROD_DEALER_EMAIL,
    password: process.env.E2E_PROD_DEALER_PASSWORD,
    stateFile: 'prod-dealer.json',
  },
];

const rolesToAuth = isProd ? prodRoles : sandboxRoles.map((r) => ({ ...r, stateFile: `${r.role}.json` }));

if (isProd && process.env.E2E_ALLOW_PROD !== '1') {
  throw new Error(
    '[global.setup] E2E_BASE_URL points at production but E2E_ALLOW_PROD=1 is not set. Refusing to authenticate.',
  );
}

for (const { role, email, password, stateFile } of rolesToAuth) {
  setup(`authenticate as ${role}`, async ({ page }) => {
    if (!email || !password) {
      throw new Error(
        `Missing email/password for ${role}. Set E2E_PROD_${role.toUpperCase()}_EMAIL / _PASSWORD (prod) or E2E_TEST_PASSWORD (sandbox) in .env.test.local`,
      );
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
      path: path.join(AUTH_DIR, stateFile),
    });
  });
}
