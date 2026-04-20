/**
 * Finance-enabled dealer onboarding lifecycle:
 *   anonymous onboarding (finance=yes + Step 5 agreement) →
 *   sales_head visits detail page (Section 3 renders, Initiate button shown) →
 *   click Initiate Agreement with a mocked Digio response →
 *   assert the persisted agreementConfig round-tripped from Step 5 into the
 *   initiate-agreement POST body.
 *
 * Scope note: this spec does NOT attempt final approval or dealer login. The
 * /approve endpoint hard-blocks finance-enabled applications until
 * agreementStatus === "completed" (approve/route.ts:94-109), which requires a
 * real Digio signed agreement and is not reproducible via a Playwright mock.
 * See dealer-approval-cycle.spec.ts for the finance=no end-to-end path.
 *
 * Run:
 *   npx playwright test --project=setup                                     # once
 *   npx playwright test tests/e2e/dealer-approval-cycle-finance.spec.ts --headed
 *
 * Requires .env.test.local: E2E_BASE_URL, E2E_TEST_PHONE_NUMBER,
 * E2E_TEST_PASSWORD, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * DATABASE_URL.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { preloadAllSamples } from './helpers/sample-docs';
import { fillDealerOnboardingWizard } from './helpers/onboarding-wizard';
import { closeDealerCredsClients } from './helpers/dealer-creds';

test.describe.configure({ mode: 'serial' });

const E2E_PHONE   = (process.env.E2E_TEST_PHONE_NUMBER || '').replace(/^\+91/, '').replace(/[^0-9]/g, '');
const RUN_ID      = Date.now().toString().slice(-6);
// StepCompany.tsx strips digits from companyName onChange, so we encode the
// run id as letters to keep per-run uniqueness without tripping the regex.
const RUN_LETTERS = RUN_ID.split('').map((d) => String.fromCharCode(65 + parseInt(d, 10))).join('');
// Distinct company prefix from dealer-approval-cycle.spec.ts to keep the two
// specs safe under parallel / serial re-runs.
const COMPANY     = `Shree Finance Batteries ${RUN_LETTERS}`;
const OWNER_NAME  = 'Rohan Deshmukh';
const OWNER_EMAIL = `dealer-fin-${RUN_ID}@itarang.com`;
const GSTIN       = `27AAGCS${RUN_ID.slice(-4)}F1Z5`;
const PAN         = `AAGCS${RUN_ID.slice(-4)}F`;
const ITARANG_S1_EMAIL = `itarang-sig1-${RUN_ID}@itarang.com`;

test('dealer onboarding (finance=yes): onboard → admin Section 3 → initiate (mocked)', async ({ browser }) => {
  test.setTimeout(8 * 60_000);

  if (!E2E_PHONE || E2E_PHONE.length !== 10) {
    throw new Error('E2E_TEST_PHONE_NUMBER must be a +91 10-digit number');
  }

  console.log(`[cycle-finance] RUN_ID=${RUN_ID} COMPANY="${COMPANY}" OWNER_EMAIL=${OWNER_EMAIL}`);

  const samples = await preloadAllSamples();

  const w1: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const w2: BrowserContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState: 'tests/.auth/sales_head.json',
  });

  try {
    // ── PHASE A: anonymous onboarding with finance=yes ──
    const p1 = await w1.newPage();
    const applicationId = await fillDealerOnboardingWizard(p1, samples, {
      companyName: COMPANY,
      ownerName: OWNER_NAME,
      ownerEmail: OWNER_EMAIL,
      ownerPhone: E2E_PHONE,
      gstin: GSTIN,
      pan: PAN,
      enableFinance: 'yes',
      agreement: {
        dateOfSigning: '2026-04-20',
        mouDate: '2026-04-15',
        dealerSigningMethod: 'aadhaar_esign',
        itarangSignatory1: {
          name: 'Priya Sharma',
          designation: 'Head of Legal',
          email: ITARANG_S1_EMAIL,
          mobile: '9876543210',
          address: 'iTarang HQ, Bangalore',
          signingMethod: 'aadhaar_esign',
        },
        salesManager: {
          name: 'Arjun Rao',
          email: `sm-${RUN_ID}@itarang.com`,
          mobile: '9876500000',
        },
      },
    });
    expect(applicationId, 'Phase A: applicationId not captured').toBeTruthy();
    console.log(`[Phase A] applicationId=${applicationId}`);

    // ── PHASE B: admin detail page reflects financeEnabled=true ──
    const p2 = await w2.newPage();
    // Admin UI calls window.alert on agreement failures (page.tsx:675); auto-dismiss
    // to avoid freezing the test if anything misfires.
    p2.on('dialog', async (d) => {
      console.log(`[dialog] ${d.type()}: ${d.message()}`);
      await d.dismiss().catch(() => {});
    });

    await assertAdminFinanceView(p2, applicationId);
    console.log(`[Phase B] admin Section 3 + Initiate button OK`);

    // ── PHASE C: intercept + click Initiate Agreement ──
    const capturedBody = await interceptAndClickInitiateAgreement(p2, applicationId);
    console.log(`[Phase C] initiate-agreement POST intercepted — payload keys=${Object.keys(capturedBody?.agreementConfig ?? {}).length}`);

    // The agreementConfig payload is built by handleAgreementAction
    // (page.tsx:644-665) from the detail-GET data, which in turn was written
    // by the submit route. Asserting on its contents proves Step 5 survived
    // the persistence round-trip.
    const cfg = capturedBody?.agreementConfig;
    if (!cfg) {
      throw new Error(`initiate-agreement body.agreementConfig missing: ${JSON.stringify(capturedBody).slice(0, 400)}`);
    }
    expect(cfg.dealerSignerEmail, 'agreementConfig.dealerSignerEmail').toBe(OWNER_EMAIL);
    expect(cfg.itarangSignatory1?.email, 'agreementConfig.itarangSignatory1.email').toBe(ITARANG_S1_EMAIL);
    expect(String(cfg.dateOfSigning ?? ''), 'agreementConfig.dateOfSigning non-empty').not.toBe('');
    expect(String(cfg.mouDate ?? ''), 'agreementConfig.mouDate non-empty').not.toBe('');
  } finally {
    await closeDealerCredsClients();
    await w1.close();
    await w2.close();
  }
});

/* ─────────────────────────────  PHASE B  ───────────────────────────────── */

async function assertAdminFinanceView(page: Page, applicationId: string): Promise<void> {
  await page.goto(`/admin/dealer-verification/${applicationId}`);
  await expect(page.getByRole('heading', { name: new RegExp(COMPANY, 'i') })).toBeVisible({ timeout: 30_000 });

  // Verification Progress checklist (page.tsx:872) flips to "Agreement" when
  // financeEnabled is true. The finance=no spec asserts the opposite label,
  // so inverting that assertion here proves the submit route persisted the
  // flag correctly.
  await expect(page.getByText('No Finance Agreement', { exact: true })).toHaveCount(0);

  // Section 3 renders only when financeEnabled=true (page.tsx:1011-1014).
  await expect(page.getByRole('heading', { name: 'Section 3 — Agreement Verification' })).toBeVisible();

  // Initiate button is shown when the agreement has not yet been initiated
  // (page.tsx:1044). A just-submitted application sits at agreementStatus
  // "not_generated", so the button must be present.
  await expect(page.getByRole('button', { name: /initiate agreement/i })).toBeVisible();
}

/* ─────────────────────────────  PHASE C  ───────────────────────────────── */

type InitiateBody = {
  agreementConfig?: {
    dealerSignerEmail?: string;
    dateOfSigning?: string;
    mouDate?: string;
    itarangSignatory1?: { email?: string };
  };
};

async function interceptAndClickInitiateAgreement(
  page: Page,
  applicationId: string,
): Promise<InitiateBody> {
  let captured: InitiateBody | null = null;

  // handleAgreementAction (page.tsx:668) fires this from the browser via
  // fetch(), so page.route intercepts cleanly. Contrast with the server-to-
  // server call from initiate-agreement → /api/integrations/digio/create-
  // agreement, which Playwright cannot intercept — that path is bypassed
  // entirely when we fulfil here.
  await page.route(`**/api/admin/dealer-verifications/${applicationId}/initiate-agreement`, async (route) => {
    try {
      captured = route.request().postDataJSON() as InitiateBody;
    } catch {
      captured = null;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        message: 'mocked',
        data: {
          providerDocumentId: 'mock-doc-123',
          requestId: 'mock-req-123',
          agreementStatus: 'sent_to_external_party',
          providerSigningUrl: 'https://example.invalid/sign',
          signerUrls: [],
        },
      }),
    });
  });

  await page.getByRole('button', { name: /initiate agreement/i }).click();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !captured) {
    await page.waitForTimeout(100);
  }

  if (!captured) {
    throw new Error('initiate-agreement POST was never intercepted');
  }

  return captured;
}
