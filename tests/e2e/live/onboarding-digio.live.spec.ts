/**
 * Finance-enabled dealer onboarding lifecycle (LIVE Digio):
 *   anonymous onboarding (finance=yes + Step 5 agreement) →
 *   sales_head visits detail page (Section 3 renders, Initiate button shown) →
 *   click Initiate Agreement → real POST fires to sandbox → sandbox calls the
 *   live Digio sandbox API → assert both the outbound agreementConfig AND the
 *   response contains a real providerDocumentId / requestId from Digio.
 *
 * Side effects of running: creates a real Digio agreement draft and fires
 * e-sign invitation emails to the signer addresses (all @itarang.com test
 * addresses). Sandbox Digio creds must be present in the deployed env.
 *
 * Scope note: this spec does NOT attempt final approval or dealer login. The
 * /approve endpoint hard-blocks finance-enabled applications until
 * agreementStatus === "completed" (approve/route.ts:94-109), which requires
 * all signers to actually sign in Digio — not something an automated test can
 * finish on its own. See dealer-approval-cycle.spec.ts for the finance=no
 * end-to-end path.
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
import { preloadAllSamples } from '../helpers/sample-docs';
import { fillDealerOnboardingWizard } from '../helpers/onboarding-wizard';
import { closeDealerCredsClients } from '../helpers/dealer-creds';

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

test('dealer onboarding (finance=yes): onboard → admin Section 3 → initiate (live Digio) [onboarding] [live] [critical]', async ({ browser }) => {
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

    // ── PHASE C: click Initiate Agreement and observe the live Digio round-trip ──
    const { req, res } = await captureLiveInitiateAgreement(p2, applicationId);
    console.log(`[Phase C] initiate-agreement req captured (${Object.keys(req?.agreementConfig ?? {}).length} keys), live Digio response: success=${res?.success} providerDocumentId=${res?.data?.providerDocumentId} requestId=${res?.data?.requestId}`);

    // Outbound payload — the agreementConfig is built by handleAgreementAction
    // (page.tsx:644-665) from the detail-GET data, which in turn was written
    // by the submit route. Asserting on its contents proves Step 5 survived
    // the persistence round-trip.
    const cfg = req?.agreementConfig;
    if (!cfg) {
      throw new Error(`initiate-agreement body.agreementConfig missing: ${JSON.stringify(req).slice(0, 400)}`);
    }
    expect(cfg.dealerSignerEmail, 'agreementConfig.dealerSignerEmail').toBe(OWNER_EMAIL);
    expect(cfg.itarangSignatory1?.email, 'agreementConfig.itarangSignatory1.email').toBe(ITARANG_S1_EMAIL);
    expect(String(cfg.dateOfSigning ?? ''), 'agreementConfig.dateOfSigning non-empty').not.toBe('');
    expect(String(cfg.mouDate ?? ''), 'agreementConfig.mouDate non-empty').not.toBe('');

    // Live Digio response — confirms the server-to-server call in
    // initiate-agreement/route.ts:434-469 actually reached Digio and returned
    // a real document id + request id. Any failure upstream (Digio 5xx,
    // Puppeteer crash, missing template, etc.) surfaces here as success:false.
    if (!res?.success) {
      throw new Error(`live Digio initiate-agreement FAILED: ${JSON.stringify(res).slice(0, 800)}`);
    }
    const data = res.data;
    if (!data) {
      throw new Error(`live Digio response missing data block: ${JSON.stringify(res).slice(0, 400)}`);
    }
    expect(data.providerDocumentId, 'Digio providerDocumentId present').toBeTruthy();
    expect(data.requestId, 'Digio requestId present').toBeTruthy();
    // Guard against accidental mock-path regression: ensure we're not seeing
    // the old hard-coded mock identifiers.
    expect(data.providerDocumentId).not.toBe('mock-doc-123');
    expect(data.requestId).not.toBe('mock-req-123');
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

type InitiateResponse = {
  success: boolean;
  message?: string;
  data?: {
    providerDocumentId?: string;
    requestId?: string;
    agreementStatus?: string;
    providerSigningUrl?: string | null;
    signerUrls?: unknown[];
  };
  raw?: unknown;
  __unreadable?: boolean;
  __status?: number;
};

async function captureLiveInitiateAgreement(
  page: Page,
  applicationId: string,
): Promise<{ req: InitiateBody; res: InitiateResponse }> {
  let capturedReq: InitiateBody | null = null;
  let capturedRes: InitiateResponse | null = null;

  const urlMatch = `/api/admin/dealer-verifications/${applicationId}/initiate-agreement`;

  // Route-level intercept — captures the outbound POST body BEFORE the browser
  // flushes it, then continues so the real request hits the sandbox and flows
  // through to the live Digio sandbox API (src/app/api/admin/dealer-
  // verifications/[dealerId]/initiate-agreement/route.ts:434-441 makes an
  // in-process call to /api/integrations/digio/create-agreement which hits
  // DIGIO_BASE_URL). We do NOT fulfil here — the point of this spec is to
  // exercise the real Digio integration.
  await page.route(`**${urlMatch}`, async (route) => {
    try {
      capturedReq = route.request().postDataJSON() as InitiateBody;
    } catch {
      capturedReq = null;
    }
    await route.continue();
  });

  // Response-level listener — captures the sandbox's JSON response after the
  // live Digio round-trip completes.
  const onResponse = async (response: any) => {
    if (
      response.request().method() === 'POST' &&
      response.url().includes(urlMatch)
    ) {
      try {
        capturedRes = (await response.json()) as InitiateResponse;
      } catch {
        capturedRes = { success: false, __unreadable: true, __status: response.status() };
      }
    }
  };
  page.on('response', onResponse);

  await page.getByRole('button', { name: /initiate agreement/i }).click();

  // Live Digio path can take a while: sandbox does Puppeteer PDF generation
  // from the agreement template + HTTP round-trip to Digio + upload + signer
  // invitation dispatch. Give it up to 120 s.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && (!capturedReq || !capturedRes)) {
    await page.waitForTimeout(250);
  }
  page.off('response', onResponse);

  if (!capturedReq) {
    throw new Error('initiate-agreement POST was never intercepted');
  }
  if (!capturedRes) {
    throw new Error('initiate-agreement response body never arrived (Digio round-trip may have timed out)');
  }

  return { req: capturedReq, res: capturedRes };
}
