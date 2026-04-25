import { test, expect } from '@playwright/test';
import { assertProdAllowed } from '../helpers/prod-guard';
import { fillDealerOnboardingWizard } from '../helpers/onboarding-wizard';
import { preloadAllSamples } from '../helpers/sample-docs';
import { buildRealisticDealer } from '../helpers/realistic-data';

/**
 * Public dealer onboarding wizard against prod. Walks all 6 steps with realistic
 * faker + IFSC + pincode data, namespaced via the [E2E] tag + runId so teardown
 * can purge later. Stops at submit — never approves the dealer (that's a
 * separate mutation-gated spec).
 */

test.describe('dealer-onboarding [prod] [onboarding]', () => {
  test.beforeAll(() => assertProdAllowed());

  test('full wizard submission with realistic data [prod] [onboarding]', async ({ browser }, testInfo) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    const samples = await preloadAllSamples();
    const dealer = await buildRealisticDealer(testInfo.workerIndex);

    const applicationId = await fillDealerOnboardingWizard(page, samples, {
      companyName: dealer.companyName,
      ownerName: dealer.ownerName,
      ownerEmail: dealer.ownerEmail,
      ownerPhone: dealer.ownerPhone,
      gstin: dealer.gstin,
      pan: dealer.pan,
      enableFinance: 'no',
    });

    expect(applicationId, 'submit returned an applicationId').toBeTruthy();
    testInfo.attachments.push({
      name: 'prod-application-id',
      contentType: 'text/plain',
      body: Buffer.from(`applicationId=${applicationId}\nrunId=${dealer.runId}\ncompany=${dealer.companyName}`),
    });
    await ctx.close();
  });
});
