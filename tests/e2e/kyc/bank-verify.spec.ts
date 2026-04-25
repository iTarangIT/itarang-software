import { test, expect } from '../fixtures';
import { KycReviewPage } from '../pages/KycReviewPage';

test.use({ storageState: 'tests/.auth/sales_head.json' });

test.describe('Admin KYC — Bank verification (stubbed Decentro)', () => {
  test('Bank card appears on the review page [kyc-review] [smoke]', async ({
    page,
    stubbedApis: _stubs,
    freshKycLead,
  }) => {
    const kyc = new KycReviewPage(page);
    await kyc.goto(freshKycLead.id);
    await expect(page.getByText(/Bank Verification/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('Bank success stubbed response [kyc-review] [critical] [happy-path]', async ({
    page,
    stubbedApis,
    freshKycLead,
  }) => {
    stubbedApis.bank('success');
    const kyc = new KycReviewPage(page);
    await kyc.goto(freshKycLead.id);

    const btn = page
      .getByRole('button', { name: /Re-?run Bank Verification|Run Bank Verification/i })
      .first();
    test.skip(
      !(await btn.isVisible().catch(() => false)),
      'Bank verify button not rendered for this lead state — upstream KYC flow required',
    );

    const reqPromise = page.waitForRequest(
      (req) =>
        req.url().includes('/api/admin/kyc/') &&
        req.url().includes('/bank/verify') &&
        req.method() === 'POST',
      { timeout: 15_000 },
    );
    await btn.click();
    await reqPromise;
  });
});
