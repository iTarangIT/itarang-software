import { test } from '../fixtures';
import { OnboardingWizardPage } from '../pages/OnboardingWizardPage';
import { buildDealerSeed } from '../factories/dealer.factory';

test.describe('Dealer onboarding — field validation', () => {
  test('invalid GSTIN is rejected [onboarding] [critical]', async ({ page }, testInfo) => {
    const seed = buildDealerSeed(testInfo.workerIndex, testInfo.testId);
    const wizard = new OnboardingWizardPage(page);
    await wizard.goto();
    await wizard.fillCompanyStep({
      companyName: seed.companyName,
      companyType: 'sole_proprietorship',
      companyAddress: '221B Test Street, Mumbai',
      gstin: 'NOT-A-GSTIN',
      pan: seed.pan,
      businessSummary: 'x',
    });
    await wizard.clickNext();
    await wizard.expectStep1Error(/gst/i);
  });

  test('invalid PAN is rejected [onboarding] [critical]', async ({ page }, testInfo) => {
    const seed = buildDealerSeed(testInfo.workerIndex, testInfo.testId);
    const wizard = new OnboardingWizardPage(page);
    await wizard.goto();
    await wizard.fillCompanyStep({
      companyName: seed.companyName,
      companyType: 'sole_proprietorship',
      companyAddress: '221B Test Street, Mumbai',
      gstin: seed.gstin,
      pan: '1234567890',
      businessSummary: 'x',
    });
    await wizard.clickNext();
    await wizard.expectStep1Error(/pan/i);
  });

  test('missing business summary blocks advance [onboarding]', async ({ page }, testInfo) => {
    const seed = buildDealerSeed(testInfo.workerIndex, testInfo.testId);
    const wizard = new OnboardingWizardPage(page);
    await wizard.goto();
    await wizard.fillCompanyStep({
      companyName: seed.companyName,
      companyType: 'sole_proprietorship',
      companyAddress: '221B Test Street, Mumbai',
      gstin: seed.gstin,
      pan: seed.pan,
      // businessSummary intentionally omitted
    });
    await wizard.clickNext();
    await wizard.expectStep1Error(/business.*summary/i);
  });
});
