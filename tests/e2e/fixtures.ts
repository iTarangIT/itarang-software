import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route('**/maps.googleapis.com/**', (route) => route.abort());
    await page.route('**/supabase.co/analytics/**', (route) => route.abort());
    await page.route('**/n8n*/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    );
    await page.route('**/*.s3.*.amazonaws.com/**', (route) =>
      route.fulfill({ status: 200, body: '' })
    );
    await use(page);
  },
});

export { expect };
