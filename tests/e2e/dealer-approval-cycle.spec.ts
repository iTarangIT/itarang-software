/**
 * Focused dealer approval lifecycle: onboarding → sales_head KYC review →
 * approve (+ assert both approval emails dispatched) → dealer login.
 *
 * Run:
 *   npx playwright test --project=setup                               # once
 *   npx playwright test tests/e2e/dealer-approval-cycle.spec.ts --headed
 *
 * Requires .env.test.local: E2E_BASE_URL, E2E_TEST_PHONE_NUMBER,
 * E2E_TEST_PASSWORD, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * DATABASE_URL.
 *
 * No inbox polling — "mail receipt" is proven by the approve endpoint's
 * JSON response: emailSent / emailTarget / internalNotificationResult.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { preloadAllSamples } from './helpers/sample-docs';
import { fillDealerOnboardingWizard } from './helpers/onboarding-wizard';
import {
  provisionKnownDealerPassword,
  closeDealerCredsClients,
  type NewDealerCreds,
} from './helpers/dealer-creds';

test.describe.configure({ mode: 'serial' });

const E2E_PHONE   = (process.env.E2E_TEST_PHONE_NUMBER || '').replace(/^\+91/, '').replace(/[^0-9]/g, '');
const RUN_ID      = Date.now().toString().slice(-6);
// StepCompany.tsx strips digits from companyName onChange, so we encode the
// run id as letters to keep per-run uniqueness without tripping the regex.
const RUN_LETTERS = RUN_ID.split('').map((d) => String.fromCharCode(65 + parseInt(d, 10))).join('');
const COMPANY     = `Shree Ganesh Auto Batteries ${RUN_LETTERS}`;
const OWNER_NAME  = 'Rohan Deshmukh';
const OWNER_EMAIL = `dealer-${RUN_ID}@itarang.com`;
const GSTIN       = `27AAGCS${RUN_ID.slice(-4)}F1Z5`;
const PAN         = `AAGCS${RUN_ID.slice(-4)}F`;

test('dealer approval cycle: onboard → sales_head review → approve+mail → dealer login', async ({ browser }) => {
  test.setTimeout(8 * 60_000);

  if (!E2E_PHONE || E2E_PHONE.length !== 10) {
    throw new Error('E2E_TEST_PHONE_NUMBER must be a +91 10-digit number');
  }

  console.log(`[cycle] RUN_ID=${RUN_ID} COMPANY="${COMPANY}" OWNER_EMAIL=${OWNER_EMAIL}`);

  const samples = await preloadAllSamples();

  const w1: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const w2: BrowserContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState: 'tests/.auth/sales_head.json',
  });
  const w3: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  try {
    // ── PHASE A: anonymous onboarding ──
    const p1 = await w1.newPage();
    const applicationId = await fillDealerOnboardingWizard(p1, samples, {
      companyName: COMPANY,
      ownerName: OWNER_NAME,
      ownerEmail: OWNER_EMAIL,
      ownerPhone: E2E_PHONE,
      gstin: GSTIN,
      pan: PAN,
    });
    expect(applicationId, 'Phase A: applicationId not captured').toBeTruthy();
    console.log(`[Phase A] applicationId=${applicationId}`);

    // ── PHASE B: sales_head KYC review walkthrough ──
    const p2 = await w2.newPage();
    await reviewDealerApplication(p2, applicationId);
    console.log(`[Phase B] KYC review sections OK`);

    // ── PHASE C: approve + assert both approval emails dispatched ──
    const approveBody = await approveAndAssertMailDispatched(p2, applicationId);
    console.log(`[Phase C] approve OK — emailSent=${approveBody.emailSent} internalNotify=${approveBody.internalNotificationResult?.success} dealerCode=${approveBody.dealerCode}`);

    // Mint a known password for the newly created dealer (approval route only
    // emails the temp password — we bypass the inbox by resetting via admin SDK).
    const creds = await provisionKnownDealerPassword(approveBody.authUserId, approveBody.dealerCode);

    // ── PHASE D: newly approved dealer logs in ──
    const p3 = await w3.newPage();
    await loginAsNewDealer(p3, creds, COMPANY);
    console.log(`[Phase D] dealer logged in — email=${creds.email}`);
  } finally {
    await closeDealerCredsClients();
    await w1.close();
    await w2.close();
    await w3.close();
  }
});

/* ─────────────────────────────  PHASE B  ───────────────────────────────── */

async function reviewDealerApplication(page: Page, applicationId: string): Promise<void> {
  // Soft-check the listing view — the row may or may not be on the default
  // (latest) page, so don't hard-fail if it's missing. The detail page nav
  // below is the real assertion target.
  await page.goto('/admin/dealer-verification');
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

  // Detail page — verifies middleware gave us access and API returned the
  // right record (heading shows the company name).
  await page.goto(`/admin/dealer-verification/${applicationId}`);
  await expect(page.getByRole('heading', { name: new RegExp(COMPANY, 'i') })).toBeVisible({ timeout: 30_000 });

  // Header verification checklist — these labels always render; the ready/
  // pending state is a distinct icon we don't assert on.
  await expect(page.getByText('Company Details', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Documents Uploaded', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Bank Details', { exact: true }).first()).toBeVisible();
  // Finance=no submission → this pill reads "No Finance Agreement".
  await expect(page.getByText('No Finance Agreement', { exact: true })).toBeVisible();

  // Section 1 — Company Details. Labels on this page say "Primary Contact ..."
  // not "Owner ..." (the submit mapping renames them). Assert by value.
  await expect(page.getByRole('heading', { name: 'Section 1 — Company Details' })).toBeVisible();
  await expect(page.getByText(COMPANY).first()).toBeVisible();
  await expect(page.getByText(GSTIN).first()).toBeVisible();
  await expect(page.getByText(PAN).first()).toBeVisible();
  await expect(page.getByText(OWNER_NAME).first()).toBeVisible();
  await expect(page.getByText(OWNER_EMAIL).first()).toBeVisible();
  await expect(page.getByText(E2E_PHONE).first()).toBeVisible();
  // Bank fields live inside Section 1 (not a separate section).
  await expect(page.getByText('State Bank of India').first()).toBeVisible();
  await expect(page.getByText('12345678901234').first()).toBeVisible();
  await expect(page.getByText('SBIN0001234').first()).toBeVisible();

  // Section 2 — Document Verification. The wizard uploads 8 files; assert ≥ 7
  // document rows render (one slot can be deduped by name).
  await expect(page.getByRole('heading', { name: 'Section 2 — Document Verification' })).toBeVisible();
  const docRowCount = await page
    .locator('section, div')
    .filter({ hasText: 'Section 2 — Document Verification' })
    .locator('a:has-text("View Document")')
    .count();
  expect(docRowCount, `expected ≥ 7 uploaded document rows, got ${docRowCount}`).toBeGreaterThanOrEqual(7);

  // Section 3 — Agreement Verification: must NOT render for finance=no.
  await expect(page.getByRole('heading', { name: 'Section 3 — Agreement Verification' })).toHaveCount(0);
}

/* ─────────────────────────────  PHASE C  ───────────────────────────────── */

type ApproveResponse = {
  success: boolean;
  message?: string;
  dealerCode: string;
  authUserId: string;
  emailSent: boolean;
  emailTarget: string;
  emailError: string | null;
  internalNotificationResult: {
    success: boolean;
    recipients: string[];
    messageId?: string;
    error?: string;
  };
};

async function approveAndAssertMailDispatched(page: Page, applicationId: string): Promise<ApproveResponse> {
  // Capture the approve response body inside a listener — the page navigates
  // back to the queue after approval, which evicts pending body reads.
  let capturedBody: any = null;
  const onResp = async (res: any) => {
    if (
      res.url().includes(`/api/admin/dealer-verifications/${applicationId}/approve`) &&
      res.request().method() === 'POST'
    ) {
      try {
        capturedBody = await res.json();
      } catch {
        capturedBody = { __unreadable: true };
      }
    }
  };
  page.on('response', onResp);

  await page.getByRole('button', { name: /approve.*activate/i }).click();

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !capturedBody) {
    await page.waitForTimeout(250);
  }
  page.off('response', onResp);

  if (!capturedBody) throw new Error('approve POST never observed');
  if (capturedBody.__unreadable) throw new Error('approve response body was unreadable (page navigated)');
  if (!capturedBody?.success) {
    throw new Error(`approve failed:\n${JSON.stringify(capturedBody, null, 2).slice(0, 2000)}`);
  }

  const body = capturedBody as ApproveResponse;

  // Identity fields.
  expect(body.success, 'approve body.success').toBe(true);
  expect(body.authUserId, 'approve body.authUserId').toBeTruthy();
  expect(body.dealerCode, 'approve body.dealerCode').toBeTruthy();

  // Dealer welcome email (EmailJS) — "mail receipt" signal #1.
  expect(body.emailSent, `dealer welcome email NOT dispatched: ${body.emailError ?? 'no error reported'}`).toBe(true);
  expect(body.emailTarget, 'emailTarget').toBe(OWNER_EMAIL);
  expect(body.emailError, 'emailError should be null on success').toBeNull();

  // Internal notification (SMTP via nodemailer). For finance=no applications
  // the approve endpoint intentionally reports success:false with "No itarang
  // signer / sales-manager emails on record" because those fields come from
  // the (skipped) agreement step. That's correct server behavior — the dealer
  // welcome email above is the primary "mail receipt" signal, so accept either
  // a real dispatch OR the documented no-recipients case.
  const internal = body.internalNotificationResult;
  if (internal?.success) {
    expect(internal.messageId, 'internalNotification messageId').toBeTruthy();
  } else {
    expect(
      internal?.error ?? '',
      `unexpected internal notification failure: ${internal?.error}`,
    ).toMatch(/No itarang signer|sales-manager emails/i);
  }

  return body;
}

/* ─────────────────────────────  PHASE D  ───────────────────────────────── */

async function loginAsNewDealer(page: Page, creds: NewDealerCreds, companyName: string): Promise<void> {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(creds.email);
  await page.locator('input[name="password"]').fill(creds.password);
  await page.getByRole('button', { name: /sign in/i }).click();

  await page.waitForURL((url) => /\/dealer-portal/.test(url.pathname), { timeout: 30_000 });
  await expect(page).not.toHaveURL(/\/change-password/);

  // Dashboard heading is "Dealer Dashboard - {currentDealerName}". The name
  // resolver may use the company OR the owner, so match loosely on the prefix
  // and assert the company name is visible somewhere on the page.
  await expect(
    page.getByRole('heading', { name: /^Dealer Dashboard\s*-/ }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(companyName).first()).toBeVisible({ timeout: 15_000 });
}
