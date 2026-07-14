import { test, expect } from '@playwright/test';
import { stubbedPage, authStateFor } from './_flow-helpers';

/**
 * Admin KYC review — /admin/kyc-review/[leadId], secret-free.
 *
 * The page is a thin server shell over the CLIENT component <CaseReview>, which
 * loads everything from GET /api/admin/kyc/[leadId]/case-review. We stub that
 * endpoint with a minimal-but-valid payload (all collection fields present and
 * empty so CaseReview's .find/.map/.length never crash), so the review UI
 * mounts for a fake lead with no DB seeding. The KYC verify endpoints are
 * already stubbed by installAllStubs (Decentro), so nothing paid is ever hit.
 *
 * Accessed under the CEO session (middleware grants CEO access to
 * /admin/kyc-review).
 */
const MODULE = 'Admin KYC Review';
const ROLE = 'ceo';
const FAKE_LEAD = 'E2E-KYC-STUB';

/** Minimal CaseReview `data` — empty collections + null objects, no crash. */
const CASE_REVIEW_DATA = {
  caseType: 'primary',
  message: '',
  verificationCards: [],
  documents: [],
  supportingDocs: [],
  consent: [],
  digilocker: [],
  coBorrower: null,
  finalDecision: null,
  couponStatus: null,
  couponCode: null,
  dealerEditsLocked: false,
  documentsCount: 0,
  kycResult: null,
};

test.describe('Admin KYC review', () => {
  test(`review page mounts for a lead (stubbed case) [module:${MODULE}]`, async ({ browser }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULE });
    const statePath = authStateFor(ROLE);
    if (!statePath) test.skip(true, `no auth state for "${ROLE}"`);

    const pageErrors: string[] = [];
    const { context, page } = await stubbedPage(browser, statePath);
    page.on('pageerror', (e) => pageErrors.push(e.message));
    try {
      await page.route('**/api/admin/kyc/**/case-review', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: CASE_REVIEW_DATA }),
        }),
      );
      // Product-review banner also fetches — keep it benign.
      await page.route('**/api/admin/kyc/**/product-review*', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"data":null}' }),
      );

      await page.goto(`/admin/kyc-review/${FAKE_LEAD}`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

      // Shell mounted (not stuck on a loader / not a client crash).
      await expect(
        page.getByText(/KYC|Verification|Case Review|Final Decision|Documents/i).first(),
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(/Application error/i)).toHaveCount(0);
      expect(pageErrors, 'uncaught page errors').toEqual([]);
    } finally {
      await context.close();
    }
  });

  test(`surfaces an error state cleanly when the case fails to load [module:${MODULE}]`, async ({ browser }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULE });
    const statePath = authStateFor(ROLE);
    if (!statePath) test.skip(true, `no auth state for "${ROLE}"`);

    const pageErrors: string[] = [];
    const { context, page } = await stubbedPage(browser, statePath);
    page.on('pageerror', (e) => pageErrors.push(e.message));
    try {
      await page.route('**/api/admin/kyc/**/case-review', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: { message: 'E2E: no live case' } }),
        }),
      );
      await page.goto(`/admin/kyc-review/${FAKE_LEAD}`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
      // The component must render its handled error state, not throw.
      await expect(page.getByText(/no live case|Failed to load|Verification|KYC/i).first()).toBeVisible({
        timeout: 20_000,
      });
      expect(pageErrors, 'uncaught page errors').toEqual([]);
    } finally {
      await context.close();
    }
  });
});
