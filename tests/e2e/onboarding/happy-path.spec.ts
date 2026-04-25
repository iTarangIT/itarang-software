import { test } from '../fixtures';
import { OnboardingWizardPage } from '../pages/OnboardingWizardPage';
import { preloadAllSamples } from '../helpers/sample-docs';
import { buildDealerSeed } from '../factories/dealer.factory';

/**
 * Full-flow happy path delegates to the existing wizard helper. File uploads
 * in particular are mandatory and require real sample docs — the helper
 * handles that. This spec asserts that a finance=no sole-prop submission
 * completes and returns an applicationId.
 *
 * NOTE: The current wizard helper uses placeholder-based selectors that may
 * drift from the UI. If this fails with a selector error, prefer running the
 * [live] variant in tests/e2e/live/onboarding-approve.live.spec.ts which
 * exercises the same path end-to-end with real Digio.
 */
test.describe('Dealer onboarding — happy path', () => {
  test('sole-prop finance=no submits and returns applicationId [onboarding] [happy-path] [critical]', async ({
    page,
  }, testInfo) => {
    test.setTimeout(4 * 60_000);

    const samples = await preloadAllSamples();
    const seed = buildDealerSeed(testInfo.workerIndex, testInfo.testId);

    const applicationId = await OnboardingWizardPage.runFullFlow(page, samples, {
      companyName: seed.companyName,
      ownerName: seed.ownerName,
      ownerEmail: seed.ownerEmail,
      ownerPhone: seed.ownerPhone,
      gstin: seed.gstin,
      pan: seed.pan,
      enableFinance: 'no',
    });

    test.info().annotations.push({
      type: 'applicationId',
      description: applicationId,
    });
  });
});
