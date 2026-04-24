import { test } from '../fixtures';
import { OnboardingWizardPage } from '../pages/OnboardingWizardPage';
import { preloadAllSamples } from '../helpers/sample-docs';
import { buildDealerSeed } from '../factories/dealer.factory';
import type { SigningMethod } from '../helpers/onboarding-wizard';

/**
 * finance=yes exercises Step 5 (Agreement) — dealer signatory auto-populates
 * from owner fields captured on Step 3. Covers all three signing-method
 * variants for the dealer signatory. Digio /initiate-agreement is NOT hit
 * here; that belongs in the [live] onboarding-digio spec.
 */
test.describe('Dealer onboarding — finance flow (Agreement step)', () => {
  for (const signingMethod of ['aadhaar_esign', 'electronic_signature', 'dsc_signature'] as SigningMethod[]) {
    test(`finance=yes with signing method=${signingMethod} [onboarding] [happy-path]`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(4 * 60_000);

      const samples = await preloadAllSamples();
      const seed = buildDealerSeed(testInfo.workerIndex, testInfo.testId);

      await OnboardingWizardPage.runFullFlow(page, samples, {
        companyName: seed.companyName,
        ownerName: seed.ownerName,
        ownerEmail: seed.ownerEmail,
        ownerPhone: seed.ownerPhone,
        gstin: seed.gstin,
        pan: seed.pan,
        enableFinance: 'yes',
        agreement: {
          dateOfSigning: '2026-04-23',
          mouDate: '2026-04-23',
          dealerSigningMethod: signingMethod,
          itarangSignatory1: {
            name: 'iTarang E2E Signatory',
            designation: 'Director',
            email: 'signatory@itarang.test',
            mobile: '+919888000111',
            address: 'iTarang HQ, Pune',
            signingMethod: 'electronic_signature',
          },
          salesManager: {
            name: 'E2E Sales Manager',
            email: 'sm@itarang.test',
            mobile: '+919888000222',
          },
        },
      });
    });
  }
});
