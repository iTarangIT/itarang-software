/**
 * E-033 — Borrower Notice Preview UI test (BRD §6.1.6)
 *
 * AC4: Borrower Notice Preview component renders the five mandated components
 *      (lender identity, LSP identity, outstanding amount + restoration steps,
 *      grievance channel + helpline, plain-language confirmation checkbox)
 *      before the submit button enables.
 *
 * Strategy: navigate to `/loop-test/borrower-notice-preview` (gated to
 * non-production) which mounts <BorrowerNoticePreview/>, then assert each of
 * the five components is visible and that the submit button is initially
 * disabled, becoming enabled only after the confirmation checkbox is ticked.
 */
import { test, expect } from "@playwright/test";

test.describe("E-033 — Borrower Notice Preview UI", () => {
  test("AC4: shows five RBI-mandated components and gates submit on confirmation", async ({
    page,
  }) => {
    await page.goto("/loop-test/borrower-notice-preview");

    const preview = page.getByTestId("borrower-notice-preview");
    await expect(preview).toBeVisible();

    // 1. Lender identity
    await expect(page.getByTestId("notice-lender-identity")).toBeVisible();
    await expect(page.getByTestId("notice-lender-identity")).toContainText(
      /NBFC/i,
    );

    // 2. LSP identity (iTarang Battery Solutions)
    await expect(page.getByTestId("notice-lsp-identity")).toBeVisible();
    await expect(page.getByTestId("notice-lsp-identity")).toContainText(
      /iTarang Battery Solutions/i,
    );

    // 3. Outstanding amount + restoration steps
    await expect(page.getByTestId("notice-outstanding")).toBeVisible();
    await expect(page.getByTestId("notice-outstanding")).toContainText(
      /Outstanding amount/i,
    );
    await expect(page.getByTestId("notice-outstanding")).toContainText(
      /Restoration steps/i,
    );

    // 4. Grievance channel URL + helpline
    await expect(page.getByTestId("notice-grievance")).toBeVisible();
    await expect(page.getByTestId("notice-grievance")).toContainText(
      /Grievance channel/i,
    );
    await expect(page.getByTestId("notice-grievance")).toContainText(
      /Helpline/i,
    );

    // 5. Plain-language statement
    await expect(page.getByTestId("notice-plain-language")).toBeVisible();
    await expect(page.getByTestId("notice-plain-language")).toContainText(
      /plain/i,
    );
    await expect(page.getByTestId("notice-plain-language")).toContainText(
      /non-coercive/i,
    );

    // Confirmation checkbox + gated submit button
    const checkbox = page.getByTestId("notice-confirm-checkbox");
    const submit = page.getByTestId("notice-submit-button");
    await expect(checkbox).toBeVisible();
    await expect(submit).toBeVisible();
    await expect(submit).toBeDisabled();

    await checkbox.check();
    await expect(submit).toBeEnabled();
  });
});
