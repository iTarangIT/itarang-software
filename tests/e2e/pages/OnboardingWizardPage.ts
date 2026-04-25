import { expect, type Page } from '@playwright/test';
import {
  fillDealerOnboardingWizard,
  type OnboardingWizardInputs,
} from '../helpers/onboarding-wizard';
import type { preloadAllSamples } from '../helpers/sample-docs';

export type CompanyStepInput = {
  companyName: string;
  companyType: 'sole_proprietorship' | 'partnership_firm' | 'private_limited_firm';
  companyAddress: string;
  gstin: string;
  pan: string;
  businessSummary?: string;
};

/**
 * POM for the 6-step dealer onboarding wizard at /dealer-onboarding.
 *
 * Step 1 (Company) is the one used by smoke + validation specs — it's fully
 * POM'd here. Full-flow happy-paths delegate to the existing
 * fillDealerOnboardingWizard helper via `runFullFlow`, which handles uploads,
 * multi-step navigation, and submit — all behaviour the live specs already
 * depend on.
 */
export class OnboardingWizardPage {
  constructor(public readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/dealer-onboarding');
    await expect(
      this.page.getByRole('heading', { name: /business details/i }),
    ).toBeVisible({ timeout: 30_000 });
  }

  async fillCompanyStep(data: CompanyStepInput): Promise<void> {
    await this.page.getByLabel(/Company Name/i).fill(data.companyName);
    await this.page.getByLabel(/Company Type/i).selectOption(data.companyType);
    await this.page.getByLabel(/Company Address/i).fill(data.companyAddress);
    await this.page.getByLabel(/GST Number/i).fill(data.gstin);
    await this.page.getByLabel(/Company PAN Number/i).fill(data.pan);
    if (data.businessSummary) {
      await this.page
        .getByLabel(/Business Details.*Summary/i)
        .fill(data.businessSummary);
    }
  }

  async clickNext(): Promise<void> {
    await this.page
      .getByRole('button', { name: /next|continue/i })
      .first()
      .click();
  }

  async expectStep1Error(fieldPattern: RegExp): Promise<void> {
    // StepCompany renders errors as <p className="...text-red-600">{message}</p>
    await expect(
      this.page.locator('p.text-red-600').filter({ hasText: fieldPattern }),
    ).toBeVisible({ timeout: 5_000 });
  }

  async expectHeading(pattern: RegExp, timeoutMs = 10_000): Promise<void> {
    await expect(
      this.page.getByRole('heading', { name: pattern }),
    ).toBeVisible({ timeout: timeoutMs });
  }

  /**
   * One-shot runner: delegates to the existing helper used by live specs.
   * Requires preloaded sample docs since the wizard mandates file uploads.
   */
  static async runFullFlow(
    page: Page,
    samples: Awaited<ReturnType<typeof preloadAllSamples>>,
    inputs: OnboardingWizardInputs,
  ): Promise<string> {
    return await fillDealerOnboardingWizard(page, samples, inputs);
  }
}
