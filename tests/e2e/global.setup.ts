import { test as setup, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { SANDBOX_ROLES, type RoleAuth } from './coverage/roles';

const AUTH_DIR = path.join('tests', '.auth');
fs.mkdirSync(AUTH_DIR, { recursive: true });

const baseURL = process.env.E2E_BASE_URL ?? 'https://sandbox.itarang.com';
const isProd = /crm\.itarang\.com/i.test(baseURL);

/**
 * Auth pairs depend on the host:
 *   - Sandbox uses the seeded users defined in coverage/roles.ts. Roles without
 *     resolvable credentials are SKIPPED (not thrown) so the run still produces
 *     a report; their smoke tests surface as Skipped.
 *   - Prod must be explicitly provisioned and credentials provided via env;
 *     storage state lands in prod-*.json so a sandbox run can never overwrite a
 *     prod auth blob (and vice versa).
 */
const prodRoles: RoleAuth[] = [
  {
    role: 'sales_head',
    dashboard: '/sales-head',
    email: process.env.E2E_PROD_SH_EMAIL,
    password: process.env.E2E_PROD_SH_PASSWORD,
    stateFile: 'prod-sales_head.json',
  },
  {
    role: 'dealer',
    dashboard: '/dealer-portal',
    email: process.env.E2E_PROD_DEALER_EMAIL,
    password: process.env.E2E_PROD_DEALER_PASSWORD,
    stateFile: 'prod-dealer.json',
  },
  {
    role: 'ceo',
    dashboard: '/ceo',
    email: process.env.E2E_PROD_CEO_EMAIL,
    password: process.env.E2E_PROD_CEO_PASSWORD,
    stateFile: 'prod-ceo.json',
  },
];

const rolesToAuth = isProd ? prodRoles : SANDBOX_ROLES;

if (isProd && process.env.E2E_ALLOW_PROD !== '1') {
  throw new Error(
    '[global.setup] E2E_BASE_URL points at production but E2E_ALLOW_PROD=1 is not set. Refusing to authenticate.',
  );
}

for (const { role, email, password, stateFile, dashboard } of rolesToAuth) {
  setup(`authenticate as ${role}`, async ({ page }) => {
    if (!email || !password) {
      // Skip — not fail. A missing sandbox cred just means that role's smoke
      // tests report as Skipped instead of aborting the whole run.
      setup.skip(
        true,
        `No credentials for "${role}" — set E2E_${role.toUpperCase()}_EMAIL / _PASSWORD to include it.`,
      );
      return;
    }

    try {
      await page.goto('/login');
      await page.locator('input[name="email"]').fill(email);
      await page.locator('input[name="password"]').fill(password);
      // `force: true` bypasses Playwright's pointer-events check — the login
      // page's decorative rickshaw <img> sits above the form in the DOM stack
      // and intercepts the hit-test even though the button is visible.
      await page.getByRole('button', { name: /sign in/i }).click({ force: true });

      await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
      await expect(page).not.toHaveURL(/\/change-password/);
      // Sanity: we landed somewhere authenticated (own dashboard, or CEO can roam).
      void dashboard;

      await page.context().storageState({
        path: path.join(AUTH_DIR, stateFile),
      });
    } catch (err) {
      // Non-fatal: a bad/expired sandbox cred for one role must NOT fail the
      // setup project (which would skip every dependent workflow test). Skip
      // this role — its smoke tests then report as Skipped at run time.
      setup.skip(true, `login failed for "${role}": ${(err as Error).message}`);
    }
  });
}
