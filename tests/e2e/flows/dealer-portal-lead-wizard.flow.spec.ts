import { test, expect } from '@playwright/test';
import { stubbedPage, authStateFor, detailStep } from './_flow-helpers';
import { buildDealerLead } from '../factories/lead.factory';

/**
 * Flow B — the dealer's own customer finance-lead wizard at
 * /dealer-portal/leads/new (multi-step: Step 1 → KYC → Product selection).
 *
 * Runs under the seeded dealer session. Selectors are placeholder/role/text
 * ONLY — the wizard's InputField (shared.tsx) renders a <label> with no
 * htmlFor, so getByLabel does NOT link to the input (see
 * tests/e2e/prod/dealer-lead-creation.prod.spec.ts).
 *
 * All create/duplicate endpoints are STUBBED so nothing is written to the
 * sandbox DB. If the seeded dealer user isn't linked to a dealer account, the
 * form shows a "User not associated with a dealer" empty-state — we detect it
 * and record the test as Skipped (Not Implemented) rather than failing.
 *
 * Every UI action/assertion is wrapped in detailStep(...) for the "Detailed
 * Steps" worksheet.
 */
const MODULE = 'Dealer Portal Lead Wizard';
const ROLE = 'dealer';

/** Stub the create + duplicate-check endpoints so Step 1 never writes to the DB. */
async function stubLeadEndpoints(
  page: import('@playwright/test').Page,
  onCreate?: (body: Record<string, unknown>) => void,
): Promise<void> {
  await page.route('**/api/leads/create', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    onCreate?.(body);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        leadId: 'L-E2E-DRAFT',
        id: 'L-E2E-DRAFT',
        data: { id: 'L-E2E-DRAFT', leadId: 'L-E2E-DRAFT' },
      }),
    });
  });
  await page.route('**/api/leads/check-duplicate**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ duplicate: false, exists: false }),
    }),
  );
}

/**
 * Navigate to the wizard. If the seeded dealer isn't linked to a dealer
 * account the page shows a "User not associated with a dealer" empty-state —
 * we call test.skip (which throws to abort the test as Skipped). Otherwise it
 * returns normally and the wizard is mounted.
 */
async function openWizardOrSkip(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.goto('/dealer-portal/leads/new');
  const notLinked = page.getByText(/user not associated with a dealer/i).first();
  const isNotLinked = await notLinked
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (isNotLinked) {
    test.skip(
      true,
      'NOT_IMPLEMENTED: seeded dealer not linked to a dealer account — the wizard shows the "User not associated with a dealer" empty-state (see dealer-lead-creation.prod.spec.ts).',
    );
  }
}

test.describe('Dealer portal lead wizard', () => {
  test(`Step 1 mounts and captures each field [module:${MODULE}]`, async ({ browser }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULE });
    const statePath = authStateFor(ROLE);
    if (!statePath) test.skip(true, `NOT_IMPLEMENTED: no auth state for "${ROLE}"`);

    const { context, page } = await stubbedPage(browser, statePath);
    try {
      await stubLeadEndpoints(page);

      // Navigate first — skips (Not Implemented) if the dealer isn't linked.
      await openWizardOrSkip(page);

      await detailStep(
        testInfo,
        {
          description: 'Open /dealer-portal/leads/new as the dealer',
          expected: 'Wizard mounts (dealer linked); no "not associated" empty-state',
        },
        async () => 'wizard rendered',
      );

      const input = buildDealerLead(testInfo.workerIndex, testInfo.testId);
      const email = `e2e+${testInfo.testId.slice(-6)}@itarang.com`;
      const phoneTen = input.phone.replace(/^\+91/, '').replace(/^\+/, '').slice(-10);

      await detailStep(
        testInfo,
        {
          description: 'Wait for the Step 1 form to be interactive (Full Name field)',
          expected: 'Full Name input (placeholder "Vijay Sharma") is visible',
        },
        async () => {
          await expect(page.getByPlaceholder('Vijay Sharma').first()).toBeVisible({ timeout: 30_000 });
          return 'Full Name field visible — Step 1 ready';
        },
      );

      await detailStep(
        testInfo,
        {
          description: `Fill Full Name = "${input.dealerName}"`,
          expected: 'Name field accepts the value',
        },
        async () => {
          const field = page.getByPlaceholder('Vijay Sharma').first();
          await field.fill(input.dealerName);
          return `field value = "${await field.inputValue()}"`;
        },
      );

      await detailStep(
        testInfo,
        {
          description: `Fill Phone = "${phoneTen}" (10 digits, first of two phone inputs)`,
          expected: 'Phone field accepts 10 digits; duplicate-check is stubbed to "not duplicate"',
        },
        async () => {
          const field = page.getByPlaceholder('9876543210').first();
          await field.fill(phoneTen);
          await field.blur();
          return `field value = "${await field.inputValue()}"`;
        },
      );

      await detailStep(
        testInfo,
        {
          description: `Fill Email = "${email}"`,
          expected: 'Email field accepts the value',
        },
        async () => {
          const field = page.getByPlaceholder('customer@example.com').first();
          await field.fill(email);
          return `field value = "${await field.inputValue()}"`;
        },
      );

      await detailStep(
        testInfo,
        {
          description: 'Fill Current Address (≥20 chars)',
          expected: 'Address textarea accepts the value',
        },
        async () => {
          const field = page.getByPlaceholder(/main street.*city.*state/i).first();
          await field.fill('221B Test Street, Pune, Maharashtra 411001');
          return `field value length = ${(await field.inputValue()).length} chars`;
        },
      );

      await detailStep(
        testInfo,
        {
          description: 'Confirm the Step 1 submit affordance ("Create Lead") is present',
          expected: '"Create Lead" button is visible at the bottom of Step 1',
        },
        async () => {
          await expect(page.getByRole('button', { name: /create lead/i })).toBeVisible();
          return 'Create Lead button visible';
        },
      );
    } finally {
      await context.close();
    }
  });

  test(`Create Lead with missing widget fields surfaces the required-field guard [module:${MODULE}]`, async ({ browser }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULE });
    const statePath = authStateFor(ROLE);
    if (!statePath) test.skip(true, `NOT_IMPLEMENTED: no auth state for "${ROLE}"`);

    const { context, page } = await stubbedPage(browser, statePath);
    try {
      let commitFired = false;
      await stubLeadEndpoints(page, (body) => {
        if (body.commitStep) commitFired = true;
      });

      // Navigate first — skips (Not Implemented) if the dealer isn't linked.
      await openWizardOrSkip(page);

      await detailStep(
        testInfo,
        {
          description: 'Open /dealer-portal/leads/new as the dealer',
          expected: 'Wizard mounts (dealer linked)',
        },
        async () => 'wizard rendered',
      );

      await detailStep(
        testInfo,
        {
          description: 'Click "Create Lead" without the required DOB / State / City widgets set',
          expected:
            'Red ErrorBanner "Please complete N required fields" appears; no commitStep POST fires (form does not advance to KYC/product-selection)',
        },
        async () => {
          await expect(page.getByPlaceholder('Vijay Sharma').first()).toBeVisible({ timeout: 30_000 });
          await page.getByRole('button', { name: /create lead/i }).click();
          const banner = page.getByText(/complete .*required field/i).first();
          await expect(banner).toBeVisible({ timeout: 5_000 });
          const bannerText = (await banner.textContent())?.trim() ?? '';
          expect(commitFired).toBe(false);
          return `guard held — banner: "${bannerText.slice(0, 120)}"; commitStep fired = ${commitFired}`;
        },
      );
    } finally {
      await context.close();
    }
  });
});
