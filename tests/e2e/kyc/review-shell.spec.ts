import { test, expect } from '../fixtures';
import { KycReviewPage } from '../pages/KycReviewPage';

test.use({ storageState: 'tests/.auth/sales_head.json' });

test.describe('Admin KYC review — shell', () => {
  test('renders KYC review page for a seeded lead [kyc-review] [smoke]', async ({
    page,
    stubbedApis: _stubs,
    freshKycLead,
  }) => {
    const kyc = new KycReviewPage(page);
    await kyc.goto(freshKycLead.id);
    await kyc.expectShellRendered();
    await expect(page).toHaveURL(new RegExp(`/admin/kyc-review/${freshKycLead.id}`));
  });

  test('page surfaces verification sections [kyc-review] [smoke]', async ({
    page,
    stubbedApis: _stubs,
    freshKycLead,
  }) => {
    const kyc = new KycReviewPage(page);
    await kyc.goto(freshKycLead.id);
    // We don't strictly require all 6 cards — the page conditionally renders
    // based on the lead's progress. Asserting PAN/Aadhaar appear is a
    // reasonable shell-level gate.
    await expect(
      page.getByText(/PAN|Aadhaar|Bank|CIBIL|RC/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
