import { test, expect } from '@playwright/test';
import path from 'node:path';
import { assertProdAllowed, mutationsAllowed } from '../helpers/prod-guard';

/**
 * Sales-head dealer verification page. Read-only by default — list view loads,
 * detail view loads. The Approve button is gated on E2E_PROD_MUTATIONS=1
 * because clicking it creates a real Supabase auth user and emails the dealer.
 */

const SH_AUTH = path.join('tests', '.auth', 'prod-sales_head.json');
const SEED_DEALER_ID = process.env.E2E_PROD_SEED_DEALER_ID ?? '';

test.describe('dealer-verification [prod] [dealer-verification]', () => {
  test.beforeAll(() => assertProdAllowed());

  test('list page renders with table and stats [prod] [dealer-verification]', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: SH_AUTH });
    const page = await ctx.newPage();
    await page.goto('/admin/dealer-verification');
    // The page header may be one of a few wordings — match generously.
    await expect(
      page.getByRole('heading', { name: /dealer.*verification|dealer.*applications|pending.*review/i }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await ctx.close();
  });

  test('detail page renders for a known dealer [prod] [dealer-verification]', async ({ browser }) => {
    test.skip(!SEED_DEALER_ID, 'NOT_IMPLEMENTED: E2E_PROD_SEED_DEALER_ID not set');
    const ctx = await browser.newContext({ storageState: SH_AUTH });
    const page = await ctx.newPage();
    await page.goto(`/admin/dealer-verification/${SEED_DEALER_ID}`);
    await expect(page.locator('body')).toBeVisible();
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await ctx.close();
  });

  test('approve dealer (gated mutation) [prod] [dealer-verification]', async ({ browser }) => {
    test.skip(!mutationsAllowed(), 'NOT_IMPLEMENTED: set E2E_PROD_MUTATIONS=1 to enable');
    test.skip(!SEED_DEALER_ID, 'NOT_IMPLEMENTED: E2E_PROD_SEED_DEALER_ID not set');

    const ctx = await browser.newContext({ storageState: SH_AUTH });
    const page = await ctx.newPage();
    await page.goto(`/admin/dealer-verification/${SEED_DEALER_ID}`);

    // Wait for the page shell, then click the Approve button. The approve
    // endpoint creates a Supabase auth user — we record the response so the
    // teardown log can flag the auth user for manual cleanup.
    const approveBtn = page.getByRole('button', { name: /^approve$/i }).first();
    await expect(approveBtn).toBeVisible({ timeout: 15_000 });

    const respPromise = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/admin/dealer-verifications/${SEED_DEALER_ID}/approve`) &&
        r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await approveBtn.click();
    const resp = await respPromise;
    expect([200, 201]).toContain(resp.status());

    await ctx.close();
  });
});
