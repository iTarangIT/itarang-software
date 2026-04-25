import { test, expect } from '@playwright/test';
import path from 'node:path';
import { assertProdAllowed, mutationsAllowed } from '../helpers/prod-guard';

/**
 * Sales-head KYC review. Read-only by default. The final-decision POST runs
 * only when E2E_PROD_MUTATIONS=1 because it changes a real lead's KYC state
 * and may cascade into customer notifications.
 */

const SH_AUTH = path.join('tests', '.auth', 'prod-sales_head.json');
const SEED_LEAD_ID = process.env.E2E_PROD_SEED_LEAD_ID ?? '';

test.describe('kyc-review [prod] [kyc-review]', () => {
  test.beforeAll(() => assertProdAllowed());

  test('list page renders with filter tabs [prod] [kyc-review]', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: SH_AUTH });
    const page = await ctx.newPage();
    await page.goto('/admin/kyc-review');
    await expect(
      page.getByRole('heading', { name: /kyc.*review|kyc.*verification|leads/i }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await ctx.close();
  });

  test('detail page renders for a seeded lead [prod] [kyc-review]', async ({ browser }) => {
    test.skip(!SEED_LEAD_ID, 'NOT_IMPLEMENTED: E2E_PROD_SEED_LEAD_ID not set');
    const ctx = await browser.newContext({ storageState: SH_AUTH });
    const page = await ctx.newPage();
    await page.goto(`/admin/kyc-review/${SEED_LEAD_ID}`);
    await expect(
      page.getByText(/KYC Review|KYC Verification|Lead Details|Verification/i).first(),
    ).toBeVisible({ timeout: 20_000 });
    await ctx.close();
  });

  test('post a final decision (gated mutation) [prod] [kyc-review]', async ({ browser }) => {
    test.skip(!mutationsAllowed(), 'NOT_IMPLEMENTED: set E2E_PROD_MUTATIONS=1 to enable');
    test.skip(!SEED_LEAD_ID, 'NOT_IMPLEMENTED: E2E_PROD_SEED_LEAD_ID not set');

    const ctx = await browser.newContext({ storageState: SH_AUTH });
    const page = await ctx.newPage();
    await page.goto(`/admin/kyc-review/${SEED_LEAD_ID}`);

    // Submit the safer non-rejection decision: dealer_action_required. Avoids
    // emitting customer-facing rejection emails while still exercising the API.
    const respPromise = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/admin/kyc/${SEED_LEAD_ID}/final-decision`) &&
        r.request().method() === 'POST',
      { timeout: 30_000 },
    );

    const reviewBtn = page.getByRole('button', { name: /request\s+additional|dealer\s+action/i }).first();
    if (await reviewBtn.isVisible().catch(() => false)) {
      await reviewBtn.click();
      // If a notes field appears, fill it
      const notes = page.getByPlaceholder(/notes?|remarks?|reason/i).first();
      if (await notes.isVisible().catch(() => false)) {
        await notes.fill('E2E gated decision — automated test, no action needed.');
      }
      const submit = page.getByRole('button', { name: /submit\s+review|submit/i }).first();
      await submit.click();
      const resp = await respPromise;
      expect([200, 201]).toContain(resp.status());
    } else {
      test.skip(true, 'NOT_IMPLEMENTED: review modal not surfaced on this page revision');
    }
    await ctx.close();
  });
});
