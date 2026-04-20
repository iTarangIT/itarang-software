import { test, expect } from './fixtures';

// Scraper dashboard lives at /sales-head/scraper. Triggering a run POSTs to
// /api/scraper/run after fetching /api/scraper/queries for the active query.
// Firecrawl / Apify / Google Places must all be stubbed — they cost money per call.
test.use({ storageState: 'tests/.auth/sales_head.json' });

test.describe('Lead scraper', () => {
  test('loads scraper dashboard', async ({ page }) => {
    await page.route('**/api/scraper/queries', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            { id: 'q1', query_text: '3 wheeler battery dealer pune', is_active: true },
          ],
        }),
      })
    );
    await page.route('**/api/scraper/runs**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      })
    );

    await page.goto('/sales-head/scraper');

    await expect(page.getByRole('heading', { name: /dealer lead scraper/i })).toBeVisible();
  });

  test('triggers a scraper run with stubbed Firecrawl backend', async ({ page }) => {
    await page.route('**/api/scraper/queries', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            { id: 'q1', query_text: 'e-rickshaw battery dealer mumbai', is_active: true },
          ],
        }),
      })
    );

    // Block live Firecrawl/Apify/Places anywhere they might leak through.
    await page.route('**/api.firecrawl.dev/**', (route) => route.abort());
    await page.route('**/api.apify.com/**', (route) => route.abort());
    await page.route('**/maps.googleapis.com/**', (route) => route.abort());

    await page.route('**/api/scraper/run', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { run_id: 'test-run-abc' },
        }),
      })
    );

    await page.route('**/api/scraper/runs**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      })
    );

    await page.goto('/sales-head/scraper');

    const runRequest = page.waitForRequest(
      (req) => req.url().includes('/api/scraper/run') && req.method() === 'POST'
    );

    // The trigger button text varies — match anything that looks like Start / Run / Trigger.
    await page.getByRole('button', { name: /start|run|trigger/i }).first().click();

    const req = await runRequest;
    expect(req.postDataJSON()).toMatchObject({
      query: 'e-rickshaw battery dealer mumbai',
    });

    await expect(page.getByText(/scraper started/i)).toBeVisible({ timeout: 10_000 });
  });

  test('surfaces error when no active query is configured', async ({ page }) => {
    await page.route('**/api/scraper/queries', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      })
    );
    await page.route('**/api/scraper/runs**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      })
    );

    await page.goto('/sales-head/scraper');
    await page.getByRole('button', { name: /start|run|trigger/i }).first().click();

    await expect(page.getByText(/no active query/i)).toBeVisible({ timeout: 10_000 });
  });
});
