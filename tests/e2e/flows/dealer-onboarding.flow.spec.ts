import { test, expect } from '@playwright/test';
import { stubbedPage } from './_flow-helpers';
import { OnboardingWizardPage } from '../pages/OnboardingWizardPage';

/**
 * Dealer onboarding — Step 1 (Business Details) flow, secret-free.
 *
 * /dealer-onboarding is the public self-onboarding wizard (not auth-gated in
 * middleware), so this runs with no session and no seeding. We exercise the
 * real UI: the wizard mounts, client-side validation blocks an empty step, and
 * a fully-filled Step 1 clears its errors. We deliberately do NOT submit the
 * whole wizard (that needs mandatory file uploads + a real server write) — that
 * end-to-end path is covered by the [live] onboarding spec when run with creds.
 */
const MODULE = 'Dealer Onboarding';

test.describe('Dealer onboarding wizard', () => {
  test(`Step 1 wizard mounts (Business Details) [module:${MODULE}]`, async ({ browser }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULE });
    const { context, page } = await stubbedPage(browser, null);
    try {
      const wizard = new OnboardingWizardPage(page);
      await wizard.goto();
      await expect(page.getByRole('heading', { name: /business details/i })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test(`Step 1 blocks submit when empty (validation) [module:${MODULE}]`, async ({ browser }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULE });
    const { context, page } = await stubbedPage(browser, null);
    try {
      const wizard = new OnboardingWizardPage(page);
      await wizard.goto();
      await wizard.clickNext();
      // At least one field-level validation error should appear and we must
      // still be on Step 1 (heading unchanged).
      await expect(page.locator('p.text-red-600').first()).toBeVisible({ timeout: 8_000 });
      await expect(page.getByRole('heading', { name: /business details/i })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test(`Step 1 accepts valid company details; only document uploads remain [module:${MODULE}]`, async ({ browser }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULE });
    const { context, page } = await stubbedPage(browser, null);
    try {
      const wizard = new OnboardingWizardPage(page);
      await wizard.goto();
      await wizard.fillCompanyStep({
        companyName: 'E2E Onboarding Co',
        companyType: 'sole_proprietorship',
        companyAddress: '12 Test Street, Nashik, Maharashtra',
        gstin: '27ABCDE1234F1Z5',
        pan: 'ABCDE1234F',
        businessSummary: 'Battery retail — automated E2E check.',
      });
      await wizard.clickNext();
      // The text fields validated OK — the ONLY gate left is the two mandatory
      // document uploads (GST certificate + company PAN). We don't attach files
      // here (that's the [live] full-flow's job); we assert no field-format
      // error slipped through, proving Step 1 accepted the company details.
      const errors = await page.locator('p.text-red-600').allInnerTexts();
      expect(errors.length, 'expected only upload requirements to remain').toBeGreaterThan(0);
      for (const e of errors) {
        expect(e.toLowerCase(), `unexpected non-upload error: "${e}"`).toContain('upload');
      }
    } finally {
      await context.close();
    }
  });
});
