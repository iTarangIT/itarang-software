import { test, expect } from '../fixtures';
import { LeadCreationPage } from '../pages/LeadCreationPage';
import { buildDealerLead } from '../factories/lead.factory';

test.use({ storageState: 'tests/.auth/sales_head.json' });

test.describe('Dealer lead creation', () => {
  test('form renders [lead-creation] [smoke]', async ({ page }) => {
    const leadPage = new LeadCreationPage(page);
    await leadPage.gotoNew();
    await expect(
      page.getByRole('button', { name: /create lead/i }),
    ).toBeVisible();
  });

  test('creates dealer lead with warm/hinglish [lead-creation] [critical] [happy-path]', async ({
    page,
  }, testInfo) => {
    const input = buildDealerLead(testInfo.workerIndex, testInfo.testId, {
      interest: 'warm',
      language: 'hinglish',
    });
    const leadPage = new LeadCreationPage(page);
    await leadPage.gotoNew();
    await leadPage.fillDealerLeadForm(input);
    const req = await leadPage.submitAndWaitForRequest();
    expect(req.postDataJSON()).toMatchObject({
      dealer_name: input.dealerName,
      phone: input.phone,
      location: input.location,
      language: 'hinglish',
      current_status: 'warm',
    });
    await expect(page.getByText(/lead created/i)).toBeVisible({ timeout: 5_000 });
  });

  test('creates dealer lead with hot/hindi [lead-creation] [happy-path]', async ({
    page,
  }, testInfo) => {
    const input = buildDealerLead(testInfo.workerIndex, testInfo.testId, {
      interest: 'hot',
      language: 'hindi',
    });
    const leadPage = new LeadCreationPage(page);
    await leadPage.gotoNew();
    await leadPage.fillDealerLeadForm(input);
    const req = await leadPage.submitAndWaitForRequest();
    expect(req.postDataJSON()).toMatchObject({
      language: 'hindi',
      current_status: 'hot',
    });
  });
});
