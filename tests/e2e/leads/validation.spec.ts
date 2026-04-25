import { test } from '../fixtures';
import { LeadCreationPage } from '../pages/LeadCreationPage';

test.use({ storageState: 'tests/.auth/sales_head.json' });

test.describe('Dealer lead creation — validation', () => {
  test('phone format validation [lead-creation] [smoke]', async ({ page }) => {
    const leadPage = new LeadCreationPage(page);
    await leadPage.gotoNew();
    await page.getByPlaceholder('e.g. Ramesh Kumar').fill('Bad Phone Dealer');
    await page.getByPlaceholder('+919876543210').fill('abc123');
    await page.getByPlaceholder('e.g. Nashik, Maharashtra').fill('Somewhere');
    await leadPage.clickSubmit();
    await leadPage.expectValidationError(/valid 10.{0,3}13 digit phone/i);
  });
});
