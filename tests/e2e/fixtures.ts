import { test as base, expect } from '@playwright/test';
import { installAllStubs, type StubController } from './helpers/api-stubs';
import {
  seedDealerLead,
  cleanupDealerLead,
  seedCustomerLead,
  cleanupCustomerLead,
  closeDbSeedClient,
} from './helpers/db-seed';
import { buildDealerLead } from './factories/lead.factory';

type Fixtures = {
  /**
   * Always-on noise blocker — aborts maps/analytics, fulfills n8n/s3 with empty
   * responses. Prevents flake from unrelated third-party calls.
   */
  noiseBlocker: void;

  /**
   * One-shot installer for external-API stubs (Decentro, Digio, S3, N8N,
   * Supabase storage). Returns a controller that lets a test switch the
   * PAN/Bank/Aadhaar stub mode on the fly:
   *
   *   const stubs = await stubbedApis;
   *   stubs.pan('mismatch');
   *   await page.goto(...);
   */
  stubbedApis: StubController;

  /**
   * A seeded dealer_leads row unique to this worker. Cleaned up in teardown.
   * Use for sales-head lead-list / dealer-lead workflows.
   */
  freshDealerLead: { id: string; phone: string; dealer_name: string };

  /**
   * A seeded customer `leads` row — the table /admin/kyc-review/[leadId]
   * actually looks up. Cleaned up in teardown. Use for KYC admin-review specs.
   */
  freshKycLead: { id: string; phone: string; full_name: string };
};

export const test = base.extend<Fixtures>({
  noiseBlocker: [
    async ({ page }, use) => {
      await page.route('**/maps.googleapis.com/**', (route) => route.abort());
      await page.route('**/supabase.co/analytics/**', (route) => route.abort());
      await page.route('**/n8n*/**', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
      );
      await page.route('**/*.s3.*.amazonaws.com/**', (route) =>
        route.fulfill({ status: 200, body: '' }),
      );
      await use();
    },
    { auto: true },
  ],

  stubbedApis: async ({ page }, use) => {
    const controller = await installAllStubs(page);
    await use(controller);
  },

  freshDealerLead: async ({}, use, testInfo) => {
    const input = buildDealerLead(testInfo.workerIndex, testInfo.testId);
    const id = await seedDealerLead({
      phone: input.phone.replace(/[^0-9]/g, '').slice(-10),
      dealer_name: input.dealerName,
      shop_name: input.shopName,
      location: input.location,
      language: input.language,
    });
    await use({ id, phone: input.phone, dealer_name: input.dealerName });
    await cleanupDealerLead(id).catch(() => {});
  },

  freshKycLead: async ({}, use, testInfo) => {
    const input = buildDealerLead(testInfo.workerIndex, testInfo.testId);
    const fullName = `E2E KYC Lead ${testInfo.testId.slice(-6)}`;
    const id = await seedCustomerLead({
      full_name: fullName,
      phone: input.phone,
      payment_method: 'finance',
    });
    await use({ id, phone: input.phone, full_name: fullName });
    await cleanupCustomerLead(id).catch(() => {});
  },
});

test.afterAll(async () => {
  await closeDbSeedClient().catch(() => {});
});

export { expect };
