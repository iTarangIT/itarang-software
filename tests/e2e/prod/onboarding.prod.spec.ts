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

    // Capture the submit response status independently — the wizard helper's
    // built-in DB lookup uses sandbox DATABASE_URL which can't see prod-written
    // rows. Treat any 2xx submit as success even if the helper can't recover
    // the application id afterwards.
    let submitStatus: number | null = null;
    page.on('response', (res) => {
      if (
        res.url().includes('/api/dealer/onboarding/submit') &&
        res.request().method() === 'POST' &&
        submitStatus === null
      ) {
        submitStatus = res.status();
      }
    });

    let applicationId: string | null = null;
    try {
      applicationId = await fillDealerOnboardingWizard(page, samples, {
        companyName: dealer.companyName,
        ownerName: dealer.ownerName,
        ownerEmail: dealer.ownerEmail,
        ownerPhone: dealer.ownerPhone,
        gstin: dealer.gstin,
        pan: dealer.pan,
        enableFinance: 'no',
      });
    } catch (err) {
      // The helper's DB-lookup fallback fails on prod because it uses sandbox
      // DATABASE_URL. If submit returned 2xx, that's still a successful E2E.
      if (submitStatus !== null && submitStatus >= 200 && submitStatus < 300) {
        console.log(`[onboarding.prod] submit returned ${submitStatus}; DB lookup unavailable on prod — treating as success`);
      } else {
        throw err;
      }
    }

    expect(submitStatus, 'submit POST status').toBeGreaterThanOrEqual(200);
    expect(submitStatus!).toBeLessThan(300);

    testInfo.attachments.push({
      name: 'prod-application-id',
      contentType: 'text/plain',
      body: Buffer.from(
        `submitStatus=${submitStatus}\napplicationId=${applicationId ?? '(unknown — DB lookup unavailable on prod)'}\nrunId=${dealer.runId}\ncompany=${dealer.companyName}`,
      ),
    });
    await ctx.close();
  });
});
