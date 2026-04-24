import { expect, type Page, type Locator } from '@playwright/test';

export type VerificationType = 'pan' | 'aadhaar' | 'bank' | 'cibil' | 'rc';

const CARD_LABEL: Record<VerificationType, RegExp> = {
  pan: /PAN Verification/i,
  aadhaar: /Aadhaar Verification/i,
  bank: /Bank Verification/i,
  cibil: /CIBIL/i,
  rc: /RC Verification/i,
};

const RUN_BUTTON: Record<VerificationType, RegExp> = {
  pan: /Re-?run PAN Verification|Run PAN Verification/i,
  aadhaar: /Re-?run Aadhaar Verification|Run Aadhaar Verification/i,
  bank: /Re-?run Bank Verification|Run Bank Verification/i,
  cibil: /Pull CIBIL|Re-?run CIBIL|Run CIBIL/i,
  rc: /Re-?run RC Verification|Run RC Verification|Verify RC/i,
};

/**
 * Represents one verification card (PAN, Bank, Aadhaar, CIBIL, RC) on the
 * /admin/kyc-review/[leadId] page. Scoped to the card's root section.
 */
export class VerificationCard {
  constructor(
    private readonly page: Page,
    private readonly type: VerificationType,
  ) {}

  /**
   * Card root — we locate the section that contains the card's title, then
   * scope button/status lookups inside it.
   */
  get root(): Locator {
    return this.page
      .locator('section, div')
      .filter({ has: this.page.getByText(CARD_LABEL[this.type]).first() })
      .first();
  }

  async isVisible(): Promise<boolean> {
    return (await this.page.getByText(CARD_LABEL[this.type]).first().isVisible().catch(() => false));
  }

  /**
   * Click the verify button. Returns the captured admin verify POST request
   * so specs can assert on its body.
   */
  async runVerification(): Promise<void> {
    const pathSegment = this.type === 'aadhaar'
      ? 'aadhaar/digilocker/initiate'
      : `${this.type}/verify`;
    const reqPromise = this.page.waitForRequest(
      (req) =>
        req.url().includes(`/api/admin/kyc/`) &&
        req.url().includes(pathSegment) &&
        req.method() === 'POST',
      { timeout: 15_000 },
    );
    await this.root.getByRole('button', { name: RUN_BUTTON[this.type] }).first().click();
    await reqPromise;
  }

  async expectStatusBadge(pattern: RegExp, timeoutMs = 10_000): Promise<void> {
    await expect(this.root.getByText(pattern)).toBeVisible({ timeout: timeoutMs });
  }

  async expectResultField(pattern: RegExp, timeoutMs = 10_000): Promise<void> {
    await expect(this.root.getByText(pattern)).toBeVisible({ timeout: timeoutMs });
  }
}

export class KycReviewPage {
  constructor(public readonly page: Page) {}

  async goto(leadId: string): Promise<void> {
    await this.page.goto(`/admin/kyc-review/${leadId}`);
  }

  async expectShellRendered(): Promise<void> {
    // The page shows either a lead summary header or KYC-related heading. Either signals the shell mounted.
    await expect(
      this.page
        .getByText(/KYC Review|KYC Verification|Lead Details|Verification/i)
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  }

  card(type: VerificationType): VerificationCard {
    return new VerificationCard(this.page, type);
  }

  async submitManualDecision(
    decision: 'approve' | 'reject',
    note = 'E2E automated decision',
  ): Promise<void> {
    const noteField = this.page.getByPlaceholder(/notes?|remarks?/i).first();
    if (await noteField.isVisible().catch(() => false)) {
      await noteField.fill(note);
    }
    const buttonName = decision === 'approve' ? /^approve$/i : /^reject$/i;
    await this.page.getByRole('button', { name: buttonName }).first().click();
  }
}
