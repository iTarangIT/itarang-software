import { test, expect } from '@playwright/test';
import path from 'node:path';
import { sweepPage } from '../helpers/button-sweep';
import { isProdRun } from '../helpers/prod-guard';

/**
 * One sweep per workflow page. Each test asserts the page loaded, then walks
 * every visible button/link, attaching a SweepResult JSON for the Excel
 * reporter to aggregate. Tagged `[prod] [button-sweep]` so it picks up under
 * the chromium-prod project's grep — but the same tests also run against
 * sandbox if you point the chromium project at them directly.
 */

const PROD_DEALER_AUTH = path.join('tests', '.auth', 'prod-dealer.json');
const PROD_SH_AUTH = path.join('tests', '.auth', 'prod-sales_head.json');
const SANDBOX_DEALER_AUTH = path.join('tests', '.auth', 'dealer.json');
const SANDBOX_SH_AUTH = path.join('tests', '.auth', 'sales_head.json');

function dealerAuth(): string {
  return isProdRun() ? PROD_DEALER_AUTH : SANDBOX_DEALER_AUTH;
}
function salesHeadAuth(): string {
  return isProdRun() ? PROD_SH_AUTH : SANDBOX_SH_AUTH;
}

const SEED_DEALER_ID = process.env.E2E_PROD_SEED_DEALER_ID ?? process.env.E2E_SEED_DEALER_ID ?? '';
const SEED_LEAD_ID = process.env.E2E_PROD_SEED_LEAD_ID ?? process.env.E2E_SEED_LEAD_ID ?? '';

test.describe('button sweep [prod] [button-sweep]', () => {
  test('dealer-onboarding (anonymous) [prod] [button-sweep]', async ({ browser }, testInfo) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const result = await sweepPage(page, testInfo, {
      url: '/dealer-onboarding',
      tag: 'dealer-onboarding',
      maxClicks: 30,
    });
    await ctx.close();
    expect(result.totalDiscovered, 'no buttons discovered on /dealer-onboarding').toBeGreaterThan(0);
  });

  test('login (anonymous) [prod] [button-sweep]', async ({ browser }, testInfo) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const result = await sweepPage(page, testInfo, {
      url: '/login',
      tag: 'login',
      maxClicks: 15,
      // The login page's Sign In button is destructive in the sense that it
      // submits credentials we want to drive deliberately, not via the sweep.
      extraSkipPatterns: [/^sign in$/i],
    });
    await ctx.close();
    expect(result.totalDiscovered).toBeGreaterThan(0);
  });

  test('dealer-portal home (dealer) [prod] [button-sweep]', async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({ storageState: dealerAuth() });
    const page = await ctx.newPage();
    const result = await sweepPage(page, testInfo, {
      url: '/dealer-portal',
      tag: 'dealer-portal',
      maxClicks: 40,
    });
    await ctx.close();
    expect(result.totalDiscovered).toBeGreaterThan(0);
  });

  test('dealer-portal new-lead (dealer) [prod] [button-sweep]', async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({ storageState: dealerAuth() });
    const page = await ctx.newPage();
    const result = await sweepPage(page, testInfo, {
      url: '/dealer-portal/leads/new',
      tag: 'dealer-portal-leads-new',
      maxClicks: 40,
      // Don't accidentally submit the form during a sweep.
      extraSkipPatterns: [/submit\s+lead/i, /save\s+draft/i],
    });
    await ctx.close();
    expect(result.totalDiscovered).toBeGreaterThan(0);
  });

  test('admin dealer-verification list (sales_head) [prod] [button-sweep]', async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({ storageState: salesHeadAuth() });
    const page = await ctx.newPage();
    const result = await sweepPage(page, testInfo, {
      url: '/admin/dealer-verification',
      tag: 'admin-dealer-verification',
      maxClicks: 30,
    });
    await ctx.close();
    expect(result.totalDiscovered).toBeGreaterThan(0);
  });

  test('admin dealer-verification detail (sales_head) [prod] [button-sweep]', async ({ browser }, testInfo) => {
    test.skip(!SEED_DEALER_ID, 'NOT_IMPLEMENTED: set E2E_PROD_SEED_DEALER_ID to run');
    const ctx = await browser.newContext({ storageState: salesHeadAuth() });
    const page = await ctx.newPage();
    const result = await sweepPage(page, testInfo, {
      url: `/admin/dealer-verification/${SEED_DEALER_ID}`,
      tag: 'admin-dealer-verification-detail',
      maxClicks: 30,
    });
    await ctx.close();
    expect(result.totalDiscovered).toBeGreaterThan(0);
  });

  test('admin kyc-review list (sales_head) [prod] [button-sweep]', async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({ storageState: salesHeadAuth() });
    const page = await ctx.newPage();
    const result = await sweepPage(page, testInfo, {
      url: '/admin/kyc-review',
      tag: 'admin-kyc-review',
      maxClicks: 30,
    });
    await ctx.close();
    expect(result.totalDiscovered).toBeGreaterThan(0);
  });

  test('admin kyc-review detail (sales_head) [prod] [button-sweep]', async ({ browser }, testInfo) => {
    test.skip(!SEED_LEAD_ID, 'NOT_IMPLEMENTED: set E2E_PROD_SEED_LEAD_ID to run');
    const ctx = await browser.newContext({ storageState: salesHeadAuth() });
    const page = await ctx.newPage();
    const result = await sweepPage(page, testInfo, {
      url: `/admin/kyc-review/${SEED_LEAD_ID}`,
      tag: 'admin-kyc-review-detail',
      maxClicks: 30,
    });
    await ctx.close();
    expect(result.totalDiscovered).toBeGreaterThan(0);
  });
});
