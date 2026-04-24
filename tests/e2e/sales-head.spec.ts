import { test, expect } from './fixtures';

// Read-only smoke tests for the sales_head dashboard surfaces.
// Verifies role-gated routes render when authenticated via the
// storageState saved by global.setup.ts (anirudh@itarang.com).

test.use({ storageState: 'tests/.auth/sales_head.json' });

test.describe('Sales head dashboard', () => {
  test('renders the sales head landing page [other] [smoke]', async ({ page }) => {
    await page.goto('/sales-head');

    await expect(
      page.getByRole('heading', { name: /sales head dashboard/i })
    ).toBeVisible({ timeout: 15_000 });

    // Middleware should not have bounced us to /login or /change-password.
    await expect(page).toHaveURL(/\/sales-head(\/|$)/);
  });

  test('renders the approvals page [other] [smoke]', async ({ page }) => {
    await page.goto('/sales-head/approvals');
    await expect(page).toHaveURL(/\/sales-head\/approvals/);
    await expect(
      page.getByRole('heading', { name: /level 1 approvals/i })
    ).toBeVisible({ timeout: 15_000 });
  });

  test('renders the scraper page [other] [smoke]', async ({ page }) => {
    await page.goto('/sales-head/scraper');
    await expect(page).toHaveURL(/\/sales-head\/scraper/);
    await expect(page.getByText(/dealer lead scraper/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
