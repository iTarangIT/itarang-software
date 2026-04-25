import { expect, type Page, type Request } from '@playwright/test';

export type DealerLeadInput = {
  dealerName: string;
  phone: string;
  shopName: string;
  location: string;
  language: 'hindi' | 'hinglish' | 'english';
  interest: 'hot' | 'warm' | 'cold';
};

/**
 * POM for /leads/new — the sales-head "Create dealer lead" form.
 * Selectors mirror the existing spec (which we know works with the current UI).
 * Posts to /api/dealer-leads on submit.
 */
export class LeadCreationPage {
  constructor(public readonly page: Page) {}

  async gotoNew(): Promise<void> {
    await this.page.goto('/leads/new');
    await expect(
      this.page.getByRole('heading', { name: /new dealer lead/i }),
    ).toBeVisible({ timeout: 15_000 });
  }

  async fillDealerLeadForm(data: DealerLeadInput): Promise<void> {
    await this.page.getByPlaceholder('e.g. Ramesh Kumar').fill(data.dealerName);
    await this.page.getByPlaceholder('+919876543210').fill(data.phone);
    await this.page.getByPlaceholder('e.g. Ramesh Battery Shop').fill(data.shopName);
    await this.page.getByPlaceholder('e.g. Nashik, Maharashtra').fill(data.location);
    await this.page
      .getByRole('button', { name: new RegExp(`^${data.language}$`, 'i') })
      .click();
    await this.page
      .getByRole('button', { name: new RegExp(`^${data.interest}$`, 'i') })
      .click();
  }

  /**
   * Click Create Lead and wait for the POST to /api/dealer-leads. Returns the
   * request for assertion in the spec.
   */
  async submitAndWaitForRequest(): Promise<Request> {
    const requestPromise = this.page.waitForRequest(
      (req) => req.url().includes('/api/dealer-leads') && req.method() === 'POST',
    );
    await this.page.getByRole('button', { name: /create lead/i }).click();
    return requestPromise;
  }

  /** Click Create Lead without waiting — useful for validation-error specs. */
  async clickSubmit(): Promise<void> {
    await this.page.getByRole('button', { name: /create lead/i }).click();
  }

  async expectValidationError(pattern: RegExp): Promise<void> {
    await expect(this.page.getByText(pattern)).toBeVisible({ timeout: 5_000 });
  }
}
