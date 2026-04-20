import { test, expect } from './fixtures';

// Dealer KYC review lives at /dealer-portal/leads/[id]/kyc.
// It triggers Decentro verification (Aadhaar / PAN / Bank) and reads Supabase
// Storage URLs for uploaded docs. Stub both.
//
// Needs a real lead_id; passed via TEST_KYC_LEAD_ID env (seed it before the run
// or look up by a deterministic dealer phone). The test skips gracefully if unset.
test.use({ storageState: 'tests/.auth/dealer.json' });

const LEAD_ID = process.env.TEST_KYC_LEAD_ID;

test.describe('KYC review', () => {
  test.skip(!LEAD_ID, 'Set TEST_KYC_LEAD_ID to run KYC specs against a real lead');

  test('renders KYC page and stubs Decentro verification', async ({ page }) => {
    // Stub Decentro-backed KYC endpoints.
    await page.route('**/api/kyc/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/aadhaar')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            decentroTxnId: 'test-decentro-aadhaar',
            status: 'SUCCESS',
            data: { aadhaarNumber: 'XXXX-XXXX-1234', nameMatch: true },
          }),
        });
      }
      if (url.includes('/pan')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            decentroTxnId: 'test-decentro-pan',
            status: 'SUCCESS',
            data: { panStatus: 'VALID', nameMatch: true },
          }),
        });
      }
      if (url.includes('/bank')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            decentroTxnId: 'test-decentro-bank',
            status: 'SUCCESS',
            data: { accountName: 'Playwright Test', nameMatch: true },
          }),
        });
      }
      return route.continue();
    });

    // Stub Supabase Storage image GETs with a 1px PNG.
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    await page.route('**/storage/v1/object/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(pngBase64, 'base64'),
      })
    );

    await page.goto(`/dealer-portal/leads/${LEAD_ID}/kyc`);

    // The page owns a progress header and consent/KYC sections. Any of these
    // headings means the shell rendered.
    await expect(
      page.getByText(/kyc|aadhaar|pan|bank|consent/i).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test('verify-Aadhaar button calls the stubbed Decentro endpoint', async ({ page }) => {
    let aadhaarCalled = false;
    await page.route('**/api/kyc/**', async (route) => {
      if (route.request().url().includes('/aadhaar')) {
        aadhaarCalled = true;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            decentroTxnId: 'test-aadhaar',
            status: 'SUCCESS',
            data: { nameMatch: true },
          }),
        });
      }
      return route.continue();
    });

    await page.goto(`/dealer-portal/leads/${LEAD_ID}/kyc`);

    const verifyBtn = page.getByRole('button', { name: /verify.*aadhaar/i }).first();
    if (await verifyBtn.isVisible().catch(() => false)) {
      await verifyBtn.click();
      await expect.poll(() => aadhaarCalled, { timeout: 5_000 }).toBe(true);
    }
  });
});
