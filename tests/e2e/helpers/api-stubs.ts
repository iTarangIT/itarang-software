import type { Page } from '@playwright/test';

/**
 * Reusable route handlers for external services the suite never hits live.
 * Stubs are scoped to a single Page.
 *
 * Design: each stubX returns a controller object that lets a test mutate the
 * response on the fly without re-registering the route. Use case: "default to
 * success, but for this one test swap PAN to a name-mismatch payload."
 */

type StubMode = 'success' | 'mismatch' | 'failure' | 'cancelled' | 'notFound';

type PanResponse = {
  status: string;
  kycResult: {
    idStatus: string;
    fullName: string;
    fatherName?: string;
  };
  decentroTxnId: string;
};

type BankResponse = {
  status: string;
  kycResult: {
    accountName?: string;
    nameMatch?: boolean;
    idStatus?: string;
  };
  decentroTxnId: string;
};

const PAN_PAYLOADS: Record<StubMode, PanResponse> = {
  success: {
    status: 'SUCCESS',
    kycResult: {
      idStatus: 'VALID',
      fullName: 'PLAYWRIGHT TEST USER',
      fatherName: 'TEST FATHER',
    },
    decentroTxnId: 'stub-pan-success',
  },
  mismatch: {
    status: 'SUCCESS',
    kycResult: {
      idStatus: 'VALID',
      fullName: 'COMPLETELY DIFFERENT NAME',
    },
    decentroTxnId: 'stub-pan-mismatch',
  },
  failure: {
    status: 'FAILURE',
    kycResult: { idStatus: 'INVALID', fullName: '' },
    decentroTxnId: 'stub-pan-failure',
  },
  cancelled: {
    status: 'FAILURE',
    kycResult: { idStatus: 'CANCELLED', fullName: '' },
    decentroTxnId: 'stub-pan-cancelled',
  },
  notFound: {
    status: 'FAILURE',
    kycResult: { idStatus: 'NOT_FOUND', fullName: '' },
    decentroTxnId: 'stub-pan-notfound',
  },
};

const BANK_PAYLOADS: Record<StubMode, BankResponse> = {
  success: {
    status: 'SUCCESS',
    kycResult: { accountName: 'Playwright Test User', nameMatch: true, idStatus: 'VALID' },
    decentroTxnId: 'stub-bank-success',
  },
  mismatch: {
    status: 'SUCCESS',
    kycResult: { accountName: 'Different Name', nameMatch: false, idStatus: 'VALID' },
    decentroTxnId: 'stub-bank-mismatch',
  },
  failure: {
    status: 'FAILURE',
    kycResult: { accountName: '', idStatus: 'INVALID' },
    decentroTxnId: 'stub-bank-failure',
  },
  cancelled: {
    status: 'FAILURE',
    kycResult: { idStatus: 'CANCELLED' },
    decentroTxnId: 'stub-bank-cancelled',
  },
  notFound: {
    status: 'FAILURE',
    kycResult: { idStatus: 'ACCOUNT_NOT_FOUND' },
    decentroTxnId: 'stub-bank-notfound',
  },
};

export type StubController = {
  pan: (mode: StubMode) => void;
  bank: (mode: StubMode) => void;
  aadhaar: (mode: StubMode) => void;
};

function json(status: number, body: unknown) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

/**
 * Install stubs for the KYC admin + dealer-portal verification endpoints.
 * Matches both /api/admin/kyc/... (admin review) and /api/kyc/... (dealer portal).
 */
export async function stubDecentro(page: Page): Promise<StubController> {
  let panMode: StubMode = 'success';
  let bankMode: StubMode = 'success';
  let aadhaarMode: StubMode = 'success';

  await page.route('**/api/admin/kyc/**/pan/verify', (route) =>
    route.fulfill(
      json(200, { success: true, message: 'PAN verified', data: PAN_PAYLOADS[panMode] }),
    ),
  );
  await page.route('**/api/admin/kyc/**/bank/verify', (route) =>
    route.fulfill(
      json(200, { success: true, message: 'Bank verified', data: BANK_PAYLOADS[bankMode] }),
    ),
  );
  await page.route('**/api/admin/kyc/**/aadhaar/digilocker/initiate', (route) =>
    route.fulfill(
      json(200, {
        success: true,
        data: {
          transactionId: 'stub-dl-txn',
          redirectUrl: 'https://example.invalid/digilocker-stub',
        },
      }),
    ),
  );
  await page.route('**/api/admin/kyc/**/aadhaar/digilocker/status/**', (route) =>
    route.fulfill(
      json(200, {
        success: true,
        data: {
          status: aadhaarMode === 'cancelled' ? 'cancelled' : 'document_fetched',
          aadhaarExtractedData:
            aadhaarMode === 'cancelled'
              ? null
              : { name: 'Playwright Test User', uid: 'XXXXXXXX1234', dob: '01-01-1990' },
        },
      }),
    ),
  );

  // Dealer-portal counterparts
  await page.route('**/api/kyc/**/pan', (route) =>
    route.fulfill(
      json(200, { success: true, data: PAN_PAYLOADS[panMode] }),
    ),
  );
  await page.route('**/api/kyc/**/bank', (route) =>
    route.fulfill(
      json(200, { success: true, data: BANK_PAYLOADS[bankMode] }),
    ),
  );

  return {
    pan: (mode) => {
      panMode = mode;
    },
    bank: (mode) => {
      bankMode = mode;
    },
    aadhaar: (mode) => {
      aadhaarMode = mode;
    },
  };
}

/** Stub Digio — session creation + callback. Good enough for the onboarding finance flow. */
export async function stubDigio(page: Page): Promise<void> {
  await page.route('**/api/kyc/digio/session', (route) =>
    route.fulfill(
      json(200, {
        sessionId: 'stub-digio-session',
        signUrl: '/api/kyc/digio/callback?status=SUCCESS&sessionId=stub-digio-session',
      }),
    ),
  );
  await page.route('**/api/digio/**', (route) =>
    route.fulfill(json(200, { success: true })),
  );
}

/** Stub presigned S3 upload URL + the PUT upload itself. */
export async function stubS3(page: Page): Promise<void> {
  await page.route('**/api/uploads/presign', (route) =>
    route.fulfill(
      json(200, {
        url: 'https://fake-s3.invalid/test-upload',
        key: 'test/doc.pdf',
      }),
    ),
  );
  await page.route('**/*.s3.*.amazonaws.com/**', (route) =>
    route.fulfill({ status: 200, body: '' }),
  );
  await page.route('**/fake-s3.invalid/**', (route) =>
    route.fulfill({ status: 200, body: '' }),
  );
}

/** Stub N8N webhook firing so we don't hit an external endpoint. */
export async function stubN8N(page: Page): Promise<void> {
  await page.route('**/n8n*/**', (route) =>
    route.fulfill(json(200, {})),
  );
}

/** Stub Supabase storage image GETs with a 1×1 transparent PNG. */
export async function stubSupabaseImages(page: Page): Promise<void> {
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  await page.route('**/storage/v1/object/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(pngBase64, 'base64'),
    }),
  );
}

/**
 * Stub the app's OWN endpoints that would otherwise trigger a paid third-party
 * call server-side. page.route only intercepts BROWSER requests, so the only
 * way to stop a paid call the Next server makes (Bolna, Razorpay order create,
 * Firecrawl/Apify/Places scrape, Gemini/OpenAI, Gupshup WhatsApp) is to fulfil
 * the browser→/api hop before it ever reaches the server. Every action a UI
 * test could click that dispatches one of these is short-circuited here with a
 * benign success payload.
 */
export async function stubPaidTriggers(page: Page): Promise<void> {
  const ok = (body: unknown = { success: true }) => (route: import('@playwright/test').Route) =>
    route.fulfill(json(200, body));

  // Bolna voice dialer — call trigger, scheduler, single-call dispatch.
  await page.route('**/api/bolna/**', ok({ success: true, callId: 'stub-bolna-call' }));
  await page.route('**/api/calls/**/trigger', ok({ success: true, callId: 'stub-call' }));
  await page.route('**/api/calls/trigger**', ok({ success: true, callId: 'stub-call' }));

  // Razorpay — order/payment creation from our API + the hosted checkout script.
  await page.route('**/api/**/razorpay/**', ok({ id: 'order_stub', amount: 0, currency: 'INR' }));
  await page.route('**/api/payments/**', ok({ id: 'order_stub', status: 'created' }));

  // Scraper trigger endpoints (fan out to Firecrawl / Apify / Google Places).
  await page.route('**/api/scraper/**/run', ok({ success: true, runId: 'stub-run' }));
  await page.route('**/api/scraper/**/start', ok({ success: true, runId: 'stub-run' }));

  // AI/LLM-backed routes (Gemini / OpenAI) — analysis, whatsapp intent, summaries.
  await page.route('**/api/ai/**', ok({ success: true, result: 'stub' }));
  await page.route('**/api/whatsapp/**', ok({ success: true }));
  await page.route('**/api/analysis/**', ok({ success: true }));
}

/**
 * Hard safety net: abort any BROWSER request to a known paid third-party host.
 * Defence in depth on top of stubPaidTriggers — if a page fires a client-side
 * call straight to one of these hosts, kill it so a run can never spend money.
 * (Server-side calls can't be seen here; those are covered by stubPaidTriggers.)
 */
export async function blockPaidHosts(page: Page): Promise<void> {
  const PAID_HOSTS = [
    '**/api.razorpay.com/**',
    '**/checkout.razorpay.com/**',
    '**/*.bolna.ai/**',
    '**/api.bolna.dev/**',
    '**/*.firecrawl.dev/**',
    '**/api.apify.com/**',
    '**/*.apify.com/**',
    '**/places.googleapis.com/**',
    '**/maps.googleapis.com/**',
    '**/generativelanguage.googleapis.com/**',
    '**/api.openai.com/**',
    '**/*.elevenlabs.io/**',
    '**/*.gupshup.io/**',
    '**/api.decentro.tech/**',
    '**/*.digio.in/**',
  ];
  for (const pattern of PAID_HOSTS) {
    await page.route(pattern, (route) => route.abort());
  }
}

/** One-shot installer for the full stubbed-external-world, used by `stubbedApis` fixture. */
export async function installAllStubs(page: Page): Promise<StubController> {
  await blockPaidHosts(page);
  await stubS3(page);
  await stubN8N(page);
  await stubSupabaseImages(page);
  await stubDigio(page);
  await stubPaidTriggers(page);
  const decentro = await stubDecentro(page);
  return decentro;
}
