import { test, expect } from './fixtures';

// Runs as sales_head. /leads/new posts to /api/dealer-leads.
// On success the app flashes a card and redirects to /leads after ~1.2s.
test.use({ storageState: 'tests/.auth/sales_admin.json' });

test.describe('Lead creation', () => {
  test('creates a new dealer lead via the form', async ({ page }, testInfo) => {
    const testPhone = `+91999${String(900_000 + testInfo.workerIndex * 100 + 1).padStart(6, '0')}`;
    const dealerName = `Playwright Dealer ${testInfo.testId}`;

    await page.goto('/leads/new');

    await expect(page.getByRole('heading', { name: /new dealer lead/i })).toBeVisible();

    await page.getByPlaceholder('e.g. Ramesh Kumar').fill(dealerName);
    await page.getByPlaceholder('+919876543210').fill(testPhone);
    await page.getByPlaceholder('e.g. Ramesh Battery Shop').fill('PW Test Shop');
    await page.getByPlaceholder('e.g. Nashik, Maharashtra').fill('Pune, Maharashtra');

    await page.getByRole('button', { name: /^hinglish$/i }).click();
    await page.getByRole('button', { name: /^warm$/i }).click();

    const apiRequest = page.waitForRequest(
      (req) => req.url().includes('/api/dealer-leads') && req.method() === 'POST'
    );
    await page.getByRole('button', { name: /create lead/i }).click();

    const req = await apiRequest;
    expect(req.postDataJSON()).toMatchObject({
      dealer_name: dealerName,
      phone: testPhone,
      location: 'Pune, Maharashtra',
      language: 'hinglish',
      current_status: 'warm',
    });

    // Success flash → redirect to /leads.
    await expect(page.getByText(/lead created/i)).toBeVisible({ timeout: 5_000 });
    await expect(page).toHaveURL(/\/leads(\?|$|\/)/, { timeout: 10_000 });
  });

  test('validates phone format before submitting', async ({ page }) => {
    await page.goto('/leads/new');

    await page.getByPlaceholder('e.g. Ramesh Kumar').fill('Bad Phone Dealer');
    await page.getByPlaceholder('+919876543210').fill('abc123');
    await page.getByPlaceholder('e.g. Nashik, Maharashtra').fill('Somewhere');

    await page.getByRole('button', { name: /create lead/i }).click();

    await expect(page.getByText(/valid 10.{0,3}13 digit phone/i)).toBeVisible();
  });

  test('surfaces duplicate phone error from API', async ({ page }) => {
    await page.route('**/api/dealer-leads', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'unique constraint violation' }),
      })
    );

    await page.goto('/leads/new');
    await page.getByPlaceholder('e.g. Ramesh Kumar').fill('Duplicate Dealer');
    await page.getByPlaceholder('+919876543210').fill('+919999900099');
    await page.getByPlaceholder('e.g. Nashik, Maharashtra').fill('Mumbai');
    await page.getByRole('button', { name: /create lead/i }).click();

    await expect(page.getByText(/phone number already exists/i)).toBeVisible();
  });
});
