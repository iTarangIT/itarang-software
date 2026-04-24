import { test, expect } from '../fixtures';
import { KycReviewPage } from '../pages/KycReviewPage';

test.use({ storageState: 'tests/.auth/sales_head.json' });

test.describe('Admin KYC — Aadhaar verification (stubbed DigiLocker)', () => {
  test('Aadhaar card appears on the review page [kyc-review] [smoke]', async ({
    page,
    stubbedApis: _stubs,
    freshKycLead,
  }) => {
    const kyc = new KycReviewPage(page);
    await kyc.goto(freshKycLead.id);
    await expect(page.getByText(/Aadhaar Verification/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
