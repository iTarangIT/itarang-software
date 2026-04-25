import { test, expect } from '../fixtures';
import { KycReviewPage } from '../pages/KycReviewPage';

test.use({ storageState: 'tests/.auth/sales_head.json' });

test.describe('Admin KYC — manual decision section', () => {
  test('manual decision section renders [kyc-review] [smoke]', async ({
    page,
    stubbedApis: _stubs,
    freshKycLead,
  }) => {
    const kyc = new KycReviewPage(page);
    await kyc.goto(freshKycLead.id);
    // Manual decision block shows Approve + Reject buttons (and sometimes "Send
    // for Review"). We only assert one of them is visible once the page is up.
    await expect(
      page.getByRole('button', { name: /approve|reject/i }).first(),
    ).toBeVisible({ timeout: 20_000 });
  });
});
