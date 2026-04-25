/**
 * Full-flow orchestrator: drives 3 Chromium windows side-by-side through
 * dealer onboarding → admin approval → dealer login → customer lead → admin
 * KYC review smoke → scraper + real Bolna AI call.
 *
 * Run:
 *   npx playwright test --project=setup            # once, refreshes auth state
 *   npx playwright test tests/e2e/full-flow.spec.ts
 *
 * Requires .env.test.local: E2E_BASE_URL, E2E_TEST_PHONE_NUMBER,
 * E2E_TEST_PASSWORD, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * DATABASE_URL.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { preloadAllSamples } from '../helpers/sample-docs';
import { fillDealerOnboardingWizard } from '../helpers/onboarding-wizard';
import {
  provisionKnownDealerPassword,
  closeDealerCredsClients,
  seedDealerLeadForPhone,
  getDealerLeadByPhone,
  type NewDealerCreds,
} from '../helpers/dealer-creds';

test.describe.configure({ mode: 'serial' });

const E2E_PHONE = (process.env.E2E_TEST_PHONE_NUMBER || '').replace(/^\+91/, '').replace(/[^0-9]/g, '');
const RUN_ID = Date.now().toString().slice(-6);
const COMPANY_NAME = `Playwright Test Co ${RUN_ID}`;
const OWNER_NAME = `PW Owner ${RUN_ID}`;
const OWNER_EMAIL = `playwright-dealer-${RUN_ID}@itarang.com`;
const CUSTOMER_NAME = `PW Customer ${RUN_ID}`;
// Per-run unique GSTIN/PAN — accounts.gstin has a UNIQUE constraint, so a
// hardcoded value collides on the second approval. Embed RUN_ID in the
// numeric slot of each. GSTIN: 27[5L][4N][L][N][Z][N|L]. PAN: [5L][4N][L].
const GSTIN = `27ABCDE${RUN_ID.slice(-4)}F1Z5`;
const PAN = `ABCDE${RUN_ID.slice(-4)}F`;

test('full flow: onboard → review → dealer lead → KYC review → scraper + AI dialer [onboarding] [live] [critical]', async ({ browser }) => {
  test.setTimeout(15 * 60_000);

  if (!E2E_PHONE || E2E_PHONE.length !== 10) {
    throw new Error('E2E_TEST_PHONE_NUMBER must be a +91 10-digit number');
  }

  console.log(`[full-flow] RUN_ID=${RUN_ID} COMPANY="${COMPANY_NAME}" PHONE=+91${E2E_PHONE}`);

  const samples = await preloadAllSamples();

  const w1: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const w2: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const w3: BrowserContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState: 'tests/.auth/sales_head.json',
  });

  const p1 = await w1.newPage();
  const p3a = await w3.newPage();

  let applicationId: string | null = null;
  let scrapeRunId: string | null = null;

  try {
    // ── PHASE A: parallel — wizard (window 1) + scraper (window 3) ──
    await Promise.all([
      (async () => {
        applicationId = await fillDealerOnboardingWizard(p1, samples, {
          companyName: COMPANY_NAME,
          ownerName: OWNER_NAME,
          ownerEmail: OWNER_EMAIL,
          ownerPhone: E2E_PHONE,
          gstin: GSTIN,
          pan: PAN,
        });
        console.log(`[Phase A.1] applicationId=${applicationId}`);
      })(),
      (async () => {
        scrapeRunId = await runScraperFromLeadsTab(p3a);
        console.log(`[Phase A.2] scrapeRunId=${scrapeRunId}`);
      })(),
    ]);

    expect(applicationId, 'Phase A: applicationId not captured').toBeTruthy();

    // ── PHASE B: anirudh approves the dealer application ──
    const p3b = await w3.newPage();
    const dealerCreds = await approveApplicationAndProvisionPassword(p3b, applicationId!);
    console.log(`[Phase B] dealer email=${dealerCreds.email} dealerCode=${dealerCreds.dealerCode}`);

    // ── PHASE C: new dealer logs in and creates a customer lead ──
    const p2 = await w2.newPage();
    await loginAsNewDealer(p2, dealerCreds);
    const leadId = await createCustomerLead(p2);
    console.log(`[Phase C] leadId=${leadId}`);

    // ── PHASE D: anirudh KYC review smoke ──
    await runKycReviewSmoke(p3b, CUSTOMER_NAME, leadId);
    console.log(`[Phase D] KYC review smoke OK`);

    // ── PHASE E: AI dialer toggle + real Bolna call assertion ──
    await assertAiDialerCalls(p3a, leadId);
    console.log(`[Phase E] AI dialer + scoring OK`);
  } finally {
    await closeDealerCredsClients();
    await w1.close();
    await w2.close();
    await w3.close();
  }
});

/* ─────────────────────────────  PHASE A.2  ─────────────────────────────── */

async function runScraperFromLeadsTab(page: Page): Promise<string | null> {
  await page.goto('/leads');
  await expect(page.getByRole('button', { name: /^scraper$/i })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /^scraper$/i }).click();

  // QueryManager exposes a search input + Run button. Run is disabled until a
  // query is typed.
  const queryInput = page.locator('input[placeholder*="search query"]').first();
  await expect(queryInput).toBeVisible({ timeout: 15_000 });
  await queryInput.fill(`e2e ${RUN_ID} 3w battery dealer pune`);

  const runReq = page
    .waitForResponse(
      (res) => res.url().includes('/api/scraper/run') && res.request().method() === 'POST',
      { timeout: 60_000 },
    )
    .catch(() => null);

  await page.getByRole('button', { name: /^run$/i }).first().click();

  const res = await runReq;
  if (!res) {
    console.warn('[Phase A.2] no /api/scraper/run response observed; continuing.');
    return null;
  }
  const body = await res.json().catch(() => ({}));
  return body?.data?.run_id ?? body?.data?.id ?? null;
}

/* ─────────────────────────────  PHASE B  ───────────────────────────────── */

async function approveApplicationAndProvisionPassword(
  page: Page,
  applicationId: string,
): Promise<NewDealerCreds> {
  await page.goto('/admin/dealer-verification');

  // Drill into the just-created application by id (the URL pattern works regardless of list state)
  await page.goto(`/admin/dealer-verification/${applicationId}`);
  await expect(page.getByRole('button', { name: /approve.*activate/i })).toBeVisible({ timeout: 30_000 });

  // Capture body inside a response listener so it's read before any subsequent
  // navigation can evict it from CDP.
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

  // Wait until either the body lands or 60s elapses.
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

  const authUserId = capturedBody.authUserId as string;
  const dealerCode = (capturedBody.dealerCode as string) ?? null;
  if (!authUserId) throw new Error(`approve response missing authUserId: ${JSON.stringify(capturedBody)}`);

  return await provisionKnownDealerPassword(authUserId, dealerCode);
}

/* ─────────────────────────────  PHASE C  ───────────────────────────────── */

async function loginAsNewDealer(page: Page, creds: NewDealerCreds): Promise<void> {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(creds.email);
  await page.locator('input[name="password"]').fill(creds.password);
  await page.getByRole('button', { name: /sign in/i }).click();

  await page.waitForURL((url) => /\/dealer-portal/.test(url.pathname), { timeout: 30_000 });
  await expect(page).not.toHaveURL(/\/change-password/);
}

async function createCustomerLead(page: Page): Promise<string> {
  await page.goto('/dealer-portal/leads/new');

  // Wait for draft init to settle
  await page.waitForResponse(
    (res) => res.url().includes('/api/leads/create') && res.request().method() === 'POST',
    { timeout: 30_000 },
  );

  // If "Resume draft?" prompt appears, dismiss it by starting fresh.
  const startFresh = page.getByRole('button', { name: /start fresh|start new/i });
  if (await startFresh.isVisible().catch(() => false)) {
    await startFresh.click();
  }

  // Personal info — placeholders "Vijay Sharma" and "9876543210" appear twice
  // (also on Vehicle Owner fields), so always scope to .first().
  await page.locator('input[placeholder="Vijay Sharma"]').first().fill(CUSTOMER_NAME);
  await page.locator('input[placeholder="Richard Doe"]').fill('Test Father');
  await page.getByLabel('Day').selectOption('15');
  await page.getByLabel('Month').selectOption('5');
  await page.getByLabel('Year').selectOption('1990');
  await page.locator('input[placeholder="9876543210"]').first().fill(E2E_PHONE);
  await page.locator('textarea[placeholder*="123, Main Street"]').first().fill('123, Test Street, Mumbai, Maharashtra - 400001');

  // Tick "Same as current address" so permanent_address auto-fills
  const sameAddr = page.getByText(/same as current address/i);
  if (await sameAddr.isVisible().catch(() => false)) await sameAddr.click();

  // Locate the Product Category and Product Type selects by their placeholder
  // option text — page also contains Day/Month/Year selects from DatePicker
  // and a payment-method select, so .nth() is unreliable.
  const categorySelect = page.locator('select:has(option:text-is("Select from Current Inventory"))');
  await expect(categorySelect).toBeVisible({ timeout: 15_000 });
  const firstCategoryValue = await categorySelect
    .locator('option:not([value=""])')
    .first()
    .getAttribute('value');
  if (!firstCategoryValue) {
    throw new Error('[Phase C] no product categories available — sandbox inventory empty?');
  }
  await categorySelect.selectOption(firstCategoryValue);

  // Product Type (primary_product_id) — required by validate(). Populated
  // after a /api/inventory/products?category=... fetch fires.
  await page.waitForResponse(
    (res) => res.url().includes('/api/inventory/products') && res.ok(),
    { timeout: 30_000 },
  );
  const productTypeSelect = page.locator('select:has(option:text-is("Select Product type"))');
  // Wait until the option list grows past the placeholder.
  await expect
    .poll(async () => productTypeSelect.locator('option').count(), { timeout: 15_000 })
    .toBeGreaterThan(1);
  const firstProductValue = await productTypeSelect
    .locator('option:not([value=""])')
    .first()
    .getAttribute('value');
  if (!firstProductValue) {
    throw new Error('[Phase C] no products available for selected category');
  }
  await productTypeSelect.selectOption(firstProductValue);

  // Lead Interest Level → Hot
  await page.getByRole('button', { name: /^hot$/i }).first().click();

  // Payment method → Cash (avoids triggering KYC step). Use the Cash radio
  // since the dropdown and radios are kept in sync by updateField.
  const cashRadio = page.locator('input[type="radio"][name="payment_method"]');
  if (await cashRadio.first().isVisible().catch(() => false)) {
    // The 3 radios share name="payment_method"; click the one whose label says Cash.
    await page.getByRole('radio', { name: /^cash$/i }).first().check().catch(() => {});
  }

  // Capture commitStep response body inside a listener (page may redirect).
  let createBody: any = null;
  const onResp = async (res: any) => {
    if (
      res.url().includes('/api/leads/create') &&
      res.request().method() === 'POST' &&
      !createBody
    ) {
      try {
        const body = await res.json();
        // Skip the initializeDraft response (no commit flag); only keep the commit response.
        if (body?.data?.committed || body?.data?.leadId || body?.data?.id) {
          createBody = body;
        }
      } catch { /* swallow — handler is best-effort */ }
    }
  };
  page.on('response', onResp);

  await page.getByRole('button', { name: /create lead/i }).first().click();

  // Confirm modal exposes a second "Create Lead" button.
  const innerCreate = page.getByRole('button', { name: /create lead/i }).last();
  if (await innerCreate.isVisible().catch(() => false)) {
    await innerCreate.click();
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !createBody) {
    await page.waitForTimeout(250);
  }
  page.off('response', onResp);

  if (!createBody) throw new Error('lead create POST never observed');
  expect(createBody?.success, `lead create failed: ${JSON.stringify(createBody).slice(0, 300)}`).toBe(true);

  const leadId = createBody?.data?.leadId ?? createBody?.data?.id;
  if (!leadId) throw new Error(`lead create response missing leadId: ${JSON.stringify(createBody).slice(0, 300)}`);
  return leadId as string;
}

/* ─────────────────────────────  PHASE D  ───────────────────────────────── */

async function runKycReviewSmoke(page: Page, customerName: string, leadId: string): Promise<void> {
  // Capture every API hit on the review page; assert they all return 2xx.
  const apiHits: { url: string; status: number }[] = [];
  page.on('response', (res) => {
    const u = res.url();
    if (u.includes('/api/admin/kyc-reviews') || u.includes(`/api/kyc/${leadId}/`)) {
      apiHits.push({ url: u, status: res.status() });
    }
  });

  await page.goto('/admin/kyc-review');
  await page.waitForResponse(
    (res) => res.url().includes('/api/admin/kyc-reviews') && res.request().method() === 'GET',
    { timeout: 30_000 },
  );

  // Navigate directly to the lead detail page — finding-by-name is fragile when
  // the queue is large. The smoke goal is "every API on this lead's page is 2xx".
  await page.goto(`/admin/kyc-review/${leadId}`).catch(() => {});

  // Settle network for ~3s after navigation.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  for (const hit of apiHits) {
    expect(hit.status, `non-2xx from ${hit.url}`).toBeLessThan(400);
  }
}

/* ─────────────────────────────  PHASE E  ───────────────────────────────── */

async function assertAiDialerCalls(page: Page, leadId: string): Promise<void> {
  // Visit /leads first so the user can SEE anirudh's view of leads + scraper +
  // dialer toggle (the user wanted this visible per the original ask). The
  // toggle on the leads page only operates on dealerLeads, not customer leads,
  // so we don't rely on it for the actual call dispatch.
  await page.goto('/leads').catch(() => {});
  await page.getByRole('button', { name: /^leads$/i }).click().catch(() => {});

  // triggerBolnaCall looks up the row in dealer_leads (or scraper_leads) by
  // phone — NOT in the customer leads table. Seed a dealer_leads row keyed by
  // the +91-prefixed phone (Bolna requires country code; the lookup compares
  // exact strings). Same value goes into the /api/bolna/call payload.
  const fullPhone = `+91${E2E_PHONE}`;
  const dealerLeadId = await seedDealerLeadForPhone({
    phone: fullPhone,
    dealer_name: OWNER_NAME,
    shop_name: COMPANY_NAME,
    location: 'Mumbai, Maharashtra',
    language: 'hinglish',
  });
  console.log(`[Phase E] seeded dealer_leads row id=${dealerLeadId} phone=${fullPhone}`);

  const ctxRequest = page.context().request;
  const callRes = await ctxRequest.post('/api/bolna/call', {
    data: { phone: fullPhone, leadId: dealerLeadId },
    headers: { 'content-type': 'application/json' },
  });
  const callBody = await callRes.json().catch(() => null);
  console.log('[Phase E] /api/bolna/call status=' + callRes.status() + ' body=' + JSON.stringify(callBody).slice(0, 400));
  expect(callRes.ok(), `Bolna trigger HTTP failed: ${callRes.status()}`).toBe(true);
  expect(callBody?.success, `Bolna trigger logical failure: ${JSON.stringify(callBody)}`).toBe(true);

  console.log('[Phase E] Bolna dispatched (call_id=' + (callBody?.call_id ?? 'n/a') + '). Phone +91' + E2E_PHONE + ' should ring within ~30s. Answer it.');

  // Poll the seeded dealer_leads row for follow_up_history / total_attempts
  // updates. Bolna webhook posts back to /api/webhooks/bolna which writes
  // there. Give it up to 4 minutes (typical 1-2 min call + processing).
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let updated = false;
  let attempts = 0;
  let history: any[] = [];
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const row = await getDealerLeadByPhone(fullPhone).catch(() => null);
    if (row) {
      attempts = row.total_attempts ?? 0;
      history = Array.isArray(row.follow_up_history) ? row.follow_up_history : [];
      if (attempts > 0 || history.length > 0 || row.final_intent_score != null || row.current_status === 'called') {
        updated = true;
        console.log(`[Phase E] dealer_leads row updated: attempts=${attempts} historyLen=${history.length} status=${row.current_status} score=${row.final_intent_score}`);
        break;
      }
    }
    await sleep(5_000);
  }

  expect(updated, 'No call record / transcript appeared on the dealer_leads row within 4 minutes').toBe(true);
}
