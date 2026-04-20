import { test, expect } from './fixtures';

// AI dialer lives at /ceo/ai-dialer. Calls pass through internal /api/ceo/ai-dialer/*
// proxies which wrap Bolna. Always stub the internal routes — the BullMQ worker
// running alongside `next dev` will otherwise try to dispatch real jobs.
test.use({ storageState: 'tests/.auth/sales_admin.json' });

test.describe('AI dialer', () => {
  test('loads dialer page with stubbed settings + empty queue', async ({ page }) => {
    await page.route('**/api/ceo/ai-dialer/settings', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { enabled: true } }),
      })
    );
    await page.route('**/api/ceo/ai-dialer/queue**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      })
    );
    await page.route('**/api/ceo/ai-dialer/assigned**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      })
    );
    await page.route('**/api/ceo/ai-dialer/history**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      })
    );
    await page.route('**/api/bolna/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    );

    await page.goto('/ceo/ai-dialer');

    await expect(page.getByRole('heading', { name: /ai dialer/i })).toBeVisible();
    await expect(page.getByText(/ai caller/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /call queue/i })).toBeVisible();
  });

  test('toggles the AI caller off and shows the paused banner', async ({ page }) => {
    let enabled = true;
    await page.route('**/api/ceo/ai-dialer/settings', async (route) => {
      const method = route.request().method();
      if (method === 'POST') {
        const body = route.request().postDataJSON() ?? {};
        enabled = !!body.enabled;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { enabled } }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { enabled } }),
      });
    });
    await page.route('**/api/ceo/ai-dialer/queue**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"data":[]}' })
    );

    await page.goto('/ceo/ai-dialer');

    // The toggle is a plain <button>. Click it — the visible label flips.
    await page.getByText(/ai caller\s+on/i).locator('xpath=following-sibling::button[1]').click();

    await expect(page.getByText(/ai automation is paused/i)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/ai caller\s+off/i)).toBeVisible();
  });

  test('manual "Call Now" hits stubbed Bolna endpoint', async ({ page }) => {
    await page.route('**/api/ceo/ai-dialer/settings', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { enabled: true } }),
      })
    );
    await page.route('**/api/ceo/ai-dialer/queue**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            {
              id: 'lead-test-1',
              dealer_name: 'Stub Dealer',
              phone: '+919999911111',
              current_status: 'warm',
              language: 'hinglish',
            },
          ],
        }),
      })
    );

    let callPosted = false;
    await page.route('**/api/ceo/ai-dialer/call', (route) => {
      if (route.request().method() === 'POST') callPosted = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { callId: 'test-call-123' } }),
      });
    });

    // Backstop: any unexpected Bolna proxy call returns empty.
    await page.route('**/api/bolna/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    );

    await page.goto('/ceo/ai-dialer');

    const callBtn = page.getByRole('button', { name: /call/i }).first();
    await callBtn.click();

    await expect.poll(() => callPosted, { timeout: 5_000 }).toBe(true);
  });
});
