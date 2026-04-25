import { test } from '../fixtures';
import { LeadCreationPage } from '../pages/LeadCreationPage';

test.use({ storageState: 'tests/.auth/sales_head.json' });

test.describe('Dealer lead creation — duplicate handling', () => {
  test('surfaces duplicate phone error from API [lead-creation] [critical]', async ({
    page,
  }) => {
    // Stub /api/dealer-leads to return a unique-constraint failure.
    await page.route('**/api/dealer-leads', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'unique constraint violation' }),
      }),
    );

    const leadPage = new LeadCreationPage(page);
    await leadPage.gotoNew();
    await page.getByPlaceholder('e.g. Ramesh Kumar').fill('Duplicate Dealer');
    await page.getByPlaceholder('+919876543210').fill('+919999900099');
    await page.getByPlaceholder('e.g. Nashik, Maharashtra').fill('Mumbai');
    await leadPage.clickSubmit();
    await leadPage.expectValidationError(/phone number already exists/i);
  });
});
