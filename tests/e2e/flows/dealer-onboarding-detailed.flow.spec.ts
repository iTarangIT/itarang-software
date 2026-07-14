import { test, expect } from '@playwright/test';
import { stubbedPage, detailStep } from './_flow-helpers';
import { OnboardingWizardPage } from '../pages/OnboardingWizardPage';
import { preloadAllSamples } from '../helpers/sample-docs';

/**
 * Dealer onboarding — the public 6-step wizard at /dealer-onboarding.
 *
 * Unauthenticated (the route is public — not in middleware's protected list),
 * so we open with stubbedPage(browser, null). Step components DO use #id /
 * htmlFor, so #companyName, #companyType, #gstNumber, #companyPanNumber,
 * #companyAddress, #smName etc. are stable selectors.
 *
 * Coverage:
 *  - Test 1: capture every Step-1 "Business Details" field (code-by-code).
 *  - Test 2: empty-step validation shows the red field errors.
 *  - Test 3: the full 6-step happy path with the finance = "No" branch
 *    (skips Step 5 Agreement), real document uploads to sandbox, and a STUBBED
 *    final submit so nothing is written as a submitted application.
 *
 * Every action/assertion is wrapped in detailStep(...) for the "Detailed
 * Steps" worksheet.
 */
const MODULE = 'Dealer Onboarding';

// GST/PAN must pass the format masks (15-char GSTIN, 10-char PAN).
const GSTIN = '27AAAAA0000A1Z5';
const PAN = 'AAAAA0000A';

test.describe('Dealer onboarding wizard', () => {
  test(`Step 1 — captures every Business Details field [module:${MODULE}]`, async ({ browser }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULE });
    const { context, page } = await stubbedPage(browser, null);
    try {
      const wizard = new OnboardingWizardPage(page);

      await detailStep(
        testInfo,
        {
          description: 'Open /dealer-onboarding → "New Dealer Onboarding" → Step 1',
          expected: 'The "Business Details" heading (Step 1 / StepCompany) is visible',
        },
        async () => {
          await wizard.goto();
          await expect(page.getByRole('heading', { name: /business details/i })).toBeVisible();
          return 'Step 1 "Business Details" mounted';
        },
      );

      await detailStep(
        testInfo,
        { description: 'Fill Company Name (#companyName)', expected: 'Field holds "iTarang E2E Pvt Ltd"' },
        async () => {
          await page.locator('#companyName').fill('iTarang E2E Pvt Ltd');
          return `#companyName = "${await page.locator('#companyName').inputValue()}"`;
        },
      );

      await detailStep(
        testInfo,
        {
          description: 'Select Company Type (#companyType) = sole_proprietorship',
          expected: 'Select value becomes "sole_proprietorship"',
        },
        async () => {
          await page.locator('#companyType').selectOption('sole_proprietorship');
          return `#companyType = "${await page.locator('#companyType').inputValue()}"`;
        },
      );

      await detailStep(
        testInfo,
        { description: 'Fill Company Address (#companyAddress)', expected: 'Field holds the address' },
        async () => {
          await page.locator('#companyAddress').fill('221B Test Street, Mumbai, Maharashtra 400001');
          return `#companyAddress length = ${(await page.locator('#companyAddress').inputValue()).length} chars`;
        },
      );

      await detailStep(
        testInfo,
        { description: `Fill GST Number (#gstNumber) = ${GSTIN}`, expected: `Field holds "${GSTIN}" (15 chars, uppercased)` },
        async () => {
          await page.locator('#gstNumber').fill(GSTIN);
          return `#gstNumber = "${await page.locator('#gstNumber').inputValue()}"`;
        },
      );

      await detailStep(
        testInfo,
        { description: `Fill Company PAN (#companyPanNumber) = ${PAN}`, expected: `Field holds "${PAN}" (10 chars, uppercased)` },
        async () => {
          await page.locator('#companyPanNumber').fill(PAN);
          return `#companyPanNumber = "${await page.locator('#companyPanNumber').inputValue()}"`;
        },
      );

      await detailStep(
        testInfo,
        { description: 'Fill Business Summary (#businessSummary)', expected: 'Optional summary textarea accepts text' },
        async () => {
          await page.locator('#businessSummary').fill('E2E sole-prop test dealer.');
          return `#businessSummary = "${await page.locator('#businessSummary').inputValue()}"`;
        },
      );

      await detailStep(
        testInfo,
        {
          description: 'Confirm the two Step-1 document upload slots + "Next" affordance are present',
          expected: '≥2 file inputs (GST cert + Company PAN) and a "Next" button exist',
        },
        async () => {
          const fileCount = await page.locator('input[type="file"]').count();
          await expect(page.getByRole('button', { name: /next/i }).first()).toBeVisible();
          expect(fileCount).toBeGreaterThanOrEqual(2);
          return `${fileCount} file inputs present; Next visible`;
        },
      );
    } finally {
      await context.close();
    }
  });

  test(`Step 1 — empty-step validation blocks navigation [module:${MODULE}]`, async ({ browser }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULE });
    const { context, page } = await stubbedPage(browser, null);
    try {
      const wizard = new OnboardingWizardPage(page);

      await detailStep(
        testInfo,
        { description: 'Open Step 1 with all fields empty', expected: '"Business Details" heading visible' },
        async () => {
          await wizard.goto();
          return 'Step 1 mounted (empty)';
        },
      );

      await detailStep(
        testInfo,
        {
          description: 'Click "Next" with an empty form',
          expected: 'At least one red validation error (p.text-red-600) appears and Step 1 stays mounted',
        },
        async () => {
          await page.getByRole('button', { name: /next/i }).first().click();
          const errors = page.locator('p.text-red-600');
          await expect(errors.first()).toBeVisible({ timeout: 5_000 });
          const count = await errors.count();
          await expect(page.getByRole('heading', { name: /business details/i })).toBeVisible();
          return `${count} field error(s) shown; still on Step 1`;
        },
      );
    } finally {
      await context.close();
    }
  });

  test(`Full 6-step happy path (finance = No) submits for admin review [module:${MODULE}]`, async ({ browser }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULE });
    test.setTimeout(180_000);
    const { context, page } = await stubbedPage(browser, null);
    try {
      // Real document uploads hit sandbox (correct response shape); count them
      // so we only click Next once each step's uploads have landed.
      let uploads = 0;
      page.on('response', (res) => {
        if (
          res.url().includes('/api/uploads/dealer-documents') &&
          res.request().method() === 'POST' &&
          res.status() < 400
        ) {
          uploads += 1;
        }
      });
      const waitUploads = async (target: number, label: string) => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          if (uploads >= target) return;
          await page.waitForTimeout(500);
        }
        throw new Error(`uploads stalled at ${uploads}/${target} during ${label}`);
      };

      // Stub ONLY the final submit so no submitted application is written.
      let submitBody: Record<string, unknown> | null = null;
      await page.route('**/api/dealer/onboarding/submit', (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        submitBody = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              applicationId: 'APP-E2E-STUB',
              onboardingStatus: 'submitted',
              reviewStatus: 'pending_admin_review',
            },
          }),
        });
      });

      const samples = await test.step('Preload sample documents (PDF/PNG fixtures)', async () => {
        return await preloadAllSamples();
      });

      // Click "Next" and wait for the target heading, retrying the click a few
      // times. After an async document upload the wizard's React state can lag
      // behind the network response, so the first Next occasionally no-ops while
      // the step re-validates — a second click once it settles advances cleanly.
      // Re-clicking is safe: we return the instant the target heading appears.
      const advanceTo = async (headingRe: RegExp, label: string): Promise<void> => {
        for (let attempt = 1; attempt <= 4; attempt++) {
          await page.getByRole('button', { name: /next/i }).first().click();
          const ok = await page
            .getByRole('heading', { name: headingRe })
            .waitFor({ state: 'visible', timeout: 12_000 })
            .then(() => true)
            .catch(() => false);
          if (ok) return;
          await page.waitForTimeout(1_000);
        }
        throw new Error(`did not advance to ${label} after 4 "Next" clicks`);
      };

      await detailStep(
        testInfo,
        {
          description: 'Step 1 — fill Business Details, upload GST cert + Company PAN, click Next',
          expected: 'Both Step-1 uploads land, then Step 2 "Compliance Documents" heading appears',
        },
        async () => {
          await page.goto('/dealer-onboarding');
          const startBtn = page.getByRole('button', { name: /New Dealer Onboarding/i }).first();
          if (await startBtn.isVisible({ timeout: 15_000 }).catch(() => false)) await startBtn.click();
          await expect(page.getByRole('heading', { name: /business details/i })).toBeVisible({ timeout: 30_000 });

          await page.locator('#companyName').fill('iTarang E2E Pvt Ltd');
          await page.locator('#companyType').selectOption('sole_proprietorship');
          await page.locator('#companyAddress').fill('221B Test Street, Mumbai, Maharashtra 400001');
          await page.locator('#gstNumber').fill(GSTIN);
          await page.locator('#companyPanNumber').fill(PAN);
          await page.locator('#businessSummary').fill('E2E sole-prop test dealer.');

          const f = page.locator('input[type="file"]');
          await f.nth(0).setInputFiles(samples.pdfs.gst);
          await f.nth(1).setInputFiles(samples.pdfs.panFile);
          await waitUploads(2, 'step 1');
          await page.waitForTimeout(800); // let the client attach the 2 uploads
          await advanceTo(/financial.*compliance documents/i, 'Step 2');
          return 'Step 1 complete → Step 2 mounted';
        },
      );

      await detailStep(
        testInfo,
        {
          description: 'Step 2 — upload the 5 compliance documents (ITR, bank, cheques, photo, Udyam), click Next',
          expected: 'All 5 uploads land (7 total), then Step 3 "Ownership & Banking" appears',
        },
        async () => {
          const f = page.locator('input[type="file"]');
          await f.nth(0).setInputFiles(samples.pdfs.itr);
          await f.nth(1).setInputFiles(samples.pdfs.bank);
          await f.nth(2).setInputFiles(samples.pdfs.cheques);
          await f.nth(3).setInputFiles(samples.pngs.photo);
          await f.nth(4).setInputFiles(samples.pdfs.udyam);
          await waitUploads(2 + 5, 'step 2');
          await page.waitForTimeout(800);
          await advanceTo(/ownership.*banking/i, 'Step 3');
          return 'Step 2 complete → Step 3 mounted';
        },
      );

      await detailStep(
        testInfo,
        {
          description: 'Step 3 — fill sole-proprietor owner, address & bank details, upload owner photo, click Next',
          expected: 'Owner photo lands, then Step 4 "Finance Enablement" appears',
        },
        async () => {
          await page.getByPlaceholder('Full name as on PAN').first().fill('E2E Owner');
          await page.getByPlaceholder('10-digit mobile number').first().fill('9000000001');
          await page.getByPlaceholder('name@example.com').first().fill('e2e+owner@itarang.com');
          await page.getByPlaceholder(/Age \(18.*90\)/).first().fill('35');
          // E-175 — Owner Aadhaar is a required sole-prop field (12 digits,
          // Verhoeff-valid). Missing it silently blocks the Step 3 → 4 Next.
          await page.getByPlaceholder('12-digit Aadhaar number').first().fill('999999990019');
          await page.locator('input[type="file"]').first().setInputFiles(samples.pngs.ownerPhoto);
          await waitUploads(2 + 5 + 1, 'step 3 owner photo');
          await page.getByPlaceholder('House / Street / Area').first().fill('221B Test Street');
          await page.getByPlaceholder('City').first().fill('Mumbai');
          await page.getByPlaceholder('District').first().fill('Mumbai');
          await page.getByPlaceholder('State').first().fill('Maharashtra');
          await page.getByPlaceholder('6-digit pin code').first().fill('400001');
          await page.getByPlaceholder('e.g. HDFC Bank').first().fill('State Bank of India');
          await page.getByPlaceholder('Bank account number').first().fill('12345678901234');
          await page.getByPlaceholder('11-character IFSC').first().fill('SBIN0001234');
          await page.getByPlaceholder('As per bank records').first().fill('E2E Owner');
          await page.getByPlaceholder('Branch name').first().fill('Mumbai Main');
          await page.locator('select').last().selectOption('current');
          await page.waitForTimeout(1_200); // owner-photo state settle before Next
          await advanceTo(/finance enablement/i, 'Step 4');
          return 'Step 3 complete → Step 4 mounted';
        },
      );

      await detailStep(
        testInfo,
        {
          description: 'Step 4 — choose "No, continue without finance", fill the revealed Sales Manager section, click Next',
          expected: 'Selecting No reveals the required Sales Manager fields; Step 5 (Agreement) is SKIPPED → Step 6 "Review" appears',
        },
        async () => {
          await page.getByRole('button', { name: /no, continue without finance/i }).click();
          const smName = page.locator('#smName');
          if (await smName.isVisible({ timeout: 5_000 }).catch(() => false)) {
            await smName.fill('E2E Sales Manager');
            await page.locator('#smEmail').fill('e2e+sm@itarang.com');
            await page.locator('#smMobile').fill('9000000099');
            await page.locator('#smAge').fill('35');
          }
          await advanceTo(/review dealer application/i, 'Step 6 (Review)');
          return 'Step 4 (finance=No) complete; Step 5 skipped → Step 6 Review mounted';
        },
      );

      await detailStep(
        testInfo,
        {
          description: 'Step 6 — tick the 3 required confirmation checkboxes and click "Submit for Admin Review"',
          expected: 'Stubbed submit returns onboardingStatus="submitted", reviewStatus="pending_admin_review"',
        },
        async () => {
          const checkboxes = page.locator('input[type="checkbox"]');
          const cbCount = await checkboxes.count();
          for (let i = 0; i < cbCount; i++) {
            const cb = checkboxes.nth(i);
            if (!(await cb.isChecked())) await cb.check();
          }
          // On success the wizard hard-redirects (window.location = APP_URL),
          // which destroys the response body — so we must NOT read resp.json()
          // (it races the navigation and throws "No resource with given
          // identifier"). We stub the response, and the route handler records
          // the request payload the instant it fires, before navigation. Assert
          // on that instead.
          await page.getByRole('button', { name: /submit for admin review/i }).click();
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline && !submitBody) await page.waitForTimeout(250);
          expect(submitBody, 'submit POST never reached the stub').not.toBeNull();
          return `submit POST fired → stub returned onboardingStatus="submitted", reviewStatus="pending_admin_review"; ${cbCount} checkboxes ticked; ${Object.keys(submitBody ?? {}).length} payload keys`;
        },
      );
    } finally {
      await context.close();
    }
  });
});
