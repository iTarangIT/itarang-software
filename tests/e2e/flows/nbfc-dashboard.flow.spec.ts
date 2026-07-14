import { test, expect } from '@playwright/test';
import { stubbedPage, authStateFor } from './_flow-helpers';

/**
 * NBFC dashboard — admin-facing NBFC directory + governance surfaces,
 * secret-free, read-only. Driven by the CEO session (middleware grants CEO
 * access to /admin/nbfc). installAllStubs neutralises any paid call.
 *
 * Each page asserts recognizable NBFC content renders and that there is no
 * client-side exception. A page that throws is a genuine finding (it surfaces
 * as Fail in the report), not a test artifact.
 */
const MODULE = 'NBFC Dashboard';
const ROLE = 'ceo';

const PAGES: { path: string; name: string }[] = [
  { path: '/admin/nbfc', name: 'directory' },
  { path: '/admin/nbfc/ecosystem-overview', name: 'ecosystem overview' },
  { path: '/admin/nbfc/audit-log', name: 'audit log' },
  { path: '/admin/nbfc/risk-rules', name: 'risk rules' },
  { path: '/admin/nbfc/approvals', name: 'approvals' },
];

test.describe('NBFC dashboard', () => {
  for (const { path: p, name } of PAGES) {
    test(`${name} renders without a client error [module:${MODULE}]`, async ({ browser }, testInfo) => {
      testInfo.annotations.push({ type: 'module', description: MODULE });
      const statePath = authStateFor(ROLE);
      if (!statePath) test.skip(true, `no auth state for "${ROLE}"`);

      const pageErrors: string[] = [];
      const { context, page } = await stubbedPage(browser, statePath);
      page.on('pageerror', (e) => pageErrors.push(e.message));
      try {
        const resp = await page.goto(p, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        expect(resp?.status() ?? 0, `HTTP status for ${p}`).toBeLessThan(500);
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

        await expect(
          page.getByText(/NBFC|Partner|Risk|Audit|Ecosystem|Approval|Lender/i).first(),
          `NBFC content on ${p}`,
        ).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText(/Application error/i), `client exception on ${p}`).toHaveCount(0);
        expect(pageErrors, `uncaught page errors on ${p}`).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});
