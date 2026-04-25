import { expect, type Page } from '@playwright/test';
import { preloadAllSamples } from './sample-docs';
import { findApplicationIdByCompanyName } from './dealer-creds';

export type SigningMethod =
  | "aadhaar_esign"
  | "electronic_signature"
  | "dsc_signature";

export type AgreementInputs = {
  dateOfSigning: string;
  mouDate: string;
  dealerSigningMethod: SigningMethod;
  itarangSignatory1: {
    name: string;
    designation: string;
    email: string;
    mobile: string;
    address: string;
    signingMethod: SigningMethod;
  };
  salesManager?: {
    name: string;
    email: string;
    mobile: string;
  };
};

export type OnboardingWizardInputs = {
  companyName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  gstin: string;
  pan: string;
  /**
   * Controls the Step 4 (Finance Enablement) branch.
   * - "no" (default): click "No, continue without finance" → Step 5 is skipped
   *   and the wizard jumps straight to Review. Matches the historical behavior.
   * - "yes": click "Yes, enable finance" → Step 5 (Agreement) is rendered and
   *   must be filled via `agreement`. Required fields mirror
   *   onboardingSchemas.ts:283-345.
   */
  enableFinance?: "yes" | "no";
  /**
   * Required when enableFinance === "yes". Feeds Step 5.
   * The dealer signatory dropdown auto-populates from the owner fields
   * already captured on Step 3, so no dealer-signer name/email/phone is
   * needed here — only the signing method.
   */
  agreement?: AgreementInputs;
};

/**
 * Drives the 6-step public dealer-onboarding wizard at /dealer-onboarding
 * end-to-end: Company → Documents → Ownership (sole-prop) → Finance →
 * [Agreement if finance=yes] → Review → Submit. Returns the applicationId
 * from the submit response (or via DB lookup fallback when the page redirect
 * eats the response body).
 *
 * The fillers always select Company Type = sole_proprietorship. The finance
 * branch is controlled by `inputs.enableFinance` (default "no").
 */
export async function fillDealerOnboardingWizard(
  page: Page,
  samples: Awaited<ReturnType<typeof preloadAllSamples>>,
  inputs: OnboardingWizardInputs,
): Promise<string> {
  // Track every successful upload so we can wait for them to complete before
  // clicking Next/Submit. The wizard does not surface a global "upload pending"
  // state; without this gate the submit fires with documents:[] and the API
  // 4xxs.
  let completedUploads = 0;
  page.on('response', (res) => {
    if (
      res.url().includes('/api/uploads/dealer-documents') &&
      res.request().method() === 'POST' &&
      res.status() < 400
    ) {
      completedUploads += 1;
    }
  });
  const waitForUploadsToReach = async (target: number, label: string) => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (completedUploads >= target) return;
      await page.waitForTimeout(500);
    }
    throw new Error(`uploads stalled at ${completedUploads}/${target} during ${label}`);
  };

  await page.goto('/dealer-onboarding');
  await expect(page.getByRole('heading', { name: /business details/i })).toBeVisible({ timeout: 30_000 });
  console.log('[wizard] step 1 heading visible');

  // STEP 1 — Company. Use #id selectors which are stable across builds; the
  // placeholder text changed between sandbox and prod (was "Company Name",
  // is "e.g. iTarang Pvt Ltd").
  await page.locator('#companyName').fill(inputs.companyName);
  await page.locator('#companyType').selectOption('sole_proprietorship');
  await page.locator('#companyAddress').fill('221B Test Street, Mumbai, Maharashtra 400001');
  await page.locator('#gstNumber').fill(inputs.gstin);
  await page.locator('#companyPanNumber').fill(inputs.pan);
  await page.locator('#businessSummary').fill('E2E sole-prop test dealer.');

  // 2 file uploads on Step 1: GST cert + Company PAN
  const step1FileInputs = page.locator('input[type="file"]');
  await step1FileInputs.nth(0).setInputFiles(samples.pdfs.gst);
  await step1FileInputs.nth(1).setInputFiles(samples.pdfs.panFile);

  console.log('[wizard] step 1 fields filled, waiting for 2 uploads');
  await waitForUploadsToReach(2, 'step 1');
  console.log('[wizard] step 1 uploads done, clicking Next');
  await page.getByRole('button', { name: /next/i }).click();

  // STEP 2 — Documents (5 uploads)
  await expect(page.getByRole('heading', { name: /financial.*compliance documents/i })).toBeVisible({ timeout: 15_000 });
  console.log('[wizard] step 2 heading visible');
  const step2FileInputs = page.locator('input[type="file"]');
  await step2FileInputs.nth(0).setInputFiles(samples.pdfs.itr);
  await step2FileInputs.nth(1).setInputFiles(samples.pdfs.bank);
  await step2FileInputs.nth(2).setInputFiles(samples.pdfs.cheques);
  await step2FileInputs.nth(3).setInputFiles(samples.pngs.photo);
  await step2FileInputs.nth(4).setInputFiles(samples.pdfs.udyam);

  console.log('[wizard] step 2 fields filled, waiting for 7 total uploads');
  await waitForUploadsToReach(2 + 5, 'step 2');
  console.log('[wizard] step 2 uploads done, clicking Next');
  await page.getByRole('button', { name: /next/i }).click();

  // STEP 3 — Ownership (sole prop branch)
  await expect(page.getByRole('heading', { name: /ownership.*banking/i })).toBeVisible({ timeout: 15_000 });
  console.log('[wizard] step 3 heading visible');

  await page.locator('input[placeholder="Owner Name"]').fill(inputs.ownerName);
  await page.locator('input[placeholder="Owner Phone Number"]').fill(inputs.ownerPhone);
  await page.locator('input[placeholder="Owner Email ID"]').fill(inputs.ownerEmail);
  await page.locator('input[placeholder="Owner Age"]').fill('35');

  // Owner photo upload (1 file input on this step before bank fields)
  await page.locator('input[type="file"]').first().setInputFiles(samples.pngs.ownerPhoto);
  await waitForUploadsToReach(2 + 5 + 1, 'step 3 owner photo');

  await page.locator('input[placeholder="Address Line 1"]').fill('221B Test Street');
  await page.locator('input[placeholder="City"]').fill('Mumbai');
  await page.locator('input[placeholder="District"]').fill('Mumbai');
  await page.locator('input[placeholder="State"]').fill('Maharashtra');
  await page.locator('input[placeholder="Pin Code"]').fill('400001');

  await page.locator('input[placeholder="Bank Name"]').fill('State Bank of India');
  await page.locator('input[placeholder="Account Number"]').fill('12345678901234');
  await page.locator('input[placeholder="IFSC"]').fill('SBIN0001234');
  await page.locator('input[placeholder="Beneficiary Name"]').fill(inputs.ownerName);
  await page.locator('input[placeholder="Branch"]').fill('Mumbai Main');
  await page.locator('select').last().selectOption('current');

  await page.getByRole('button', { name: /next/i }).click();

  // STEP 4 — Finance Enablement: branch on inputs.enableFinance
  await expect(page.getByRole('heading', { name: /finance enablement/i })).toBeVisible({ timeout: 15_000 });

  const enableFinance = inputs.enableFinance ?? 'no';

  if (enableFinance === 'yes') {
    if (!inputs.agreement) {
      throw new Error('fillDealerOnboardingWizard: enableFinance="yes" requires `agreement` inputs for Step 5');
    }
    await page.getByRole('button', { name: /yes, enable finance/i }).click();
    await page.getByRole('button', { name: /next/i }).click();

    // STEP 5 — Dealer Finance Agreement Setup
    await expect(page.getByRole('heading', { name: /dealer finance agreement setup/i })).toBeVisible({ timeout: 15_000 });

    const agreementInputs = inputs.agreement;

    // Agreement Meta: the only two `<input type="date">` fields on Step 5 are
    // dateOfSigning (index 0) and mouDate (index 1) — see StepAgreement.tsx:257-270.
    const dateInputs = page.locator('input[type="date"]');
    await dateInputs.nth(0).fill(agreementInputs.dateOfSigning);
    await dateInputs.nth(1).fill(agreementInputs.mouDate);

    // Dealer Signatory dropdown. For a sole-proprietorship the options are
    // [{ value: "", label: "Choose Dealer Signatory" }, { value: ownerName, label: ownerName }]
    // (see dealerSignatoryOptions memo in StepAgreement.tsx:149-160). Picking the
    // owner option fires onDealerSignatoryChange which auto-fills the readOnly
    // designation / email / phone inputs, so no further action is needed there.
    await page
      .locator('select')
      .filter({ has: page.locator('option', { hasText: 'Choose Dealer Signatory' }) })
      .selectOption({ label: inputs.ownerName });

    // Dealer signing method — the next `<select>` after the signatory dropdown
    // (inside the same SectionCard). Without iTarang Signatory 2, Step 5 has
    // exactly 3 selects in DOM order: [0] dealer signatory, [1] dealer signing
    // method, [2] iTarang Signatory 1 signing method.
    await page.locator('select').nth(1).selectOption(agreementInputs.dealerSigningMethod);

    // Sales Manager — optional per schema but filled when provided so the
    // persisted agreementConfig reaching /initiate-agreement is realistic.
    if (agreementInputs.salesManager) {
      await page.locator('input[placeholder="Sales Manager Name"]').fill(agreementInputs.salesManager.name);
      await page.locator('input[placeholder="Sales Manager Email"]').fill(agreementInputs.salesManager.email);
      await page.locator('input[placeholder="Sales Manager Contact Number"]').fill(agreementInputs.salesManager.mobile);
    }

    // iTarang Signatory 1 PartyCard — scope by the h4 inside the card so the
    // generic placeholders ("Signatory Name" / "Designation" / ...) resolve to
    // the correct signatory. We deliberately skip the "+ Add iTarang
    // Signatory 2" button: Signatory 2 is optional (onboardingSchemas.ts:347-380),
    // leaving it absent keeps the DOM with a single PartyCard on this step.
    const itarangS1 = page.locator('div.rounded-2xl').filter({ hasText: 'iTarang Signatory 1' });
    await itarangS1.locator('input[placeholder="Signatory Name"]').fill(agreementInputs.itarangSignatory1.name);
    await itarangS1.locator('input[placeholder="Designation"]').fill(agreementInputs.itarangSignatory1.designation);
    await itarangS1.locator('input[placeholder="Signatory Email"]').fill(agreementInputs.itarangSignatory1.email);
    await itarangS1.locator('input[placeholder="Signatory Mobile"]').fill(agreementInputs.itarangSignatory1.mobile);
    await itarangS1.locator('input[placeholder="Signatory Address"]').fill(agreementInputs.itarangSignatory1.address);
    await itarangS1.locator('select').selectOption(agreementInputs.itarangSignatory1.signingMethod);

    // Step 5 has its own submit button distinct from the Step 4 "Next →"
    // (StepAgreement.tsx:580-595 uses "Continue to Review").
    await page.getByRole('button', { name: /continue to review/i }).click();
  } else {
    await page.getByRole('button', { name: /no, continue without finance/i }).click();
    await page.getByRole('button', { name: /next/i }).click();
  }

  // STEP 6 — Review
  await expect(page.getByRole('heading', { name: /review dealer application/i })).toBeVisible({ timeout: 15_000 });

  const checkboxes = page.locator('input[type="checkbox"]');
  const cbCount = await checkboxes.count();
  for (let i = 0; i < cbCount; i++) {
    const cb = checkboxes.nth(i);
    if (!(await cb.isChecked())) await cb.check();
  }

  // The wizard hard-redirects to /login on success (often to a stale APP_URL
  // baked at build time), which discards the response body. Capture the body
  // in an on('response') handler that runs the moment the response arrives —
  // before the page can navigate.
  let submitBody: any = null;
  const onSubmit = async (res: any) => {
    if (
      res.url().includes('/api/dealer/onboarding/submit') &&
      res.request().method() === 'POST' &&
      !submitBody
    ) {
      try { submitBody = await res.json(); }
      catch { submitBody = { __unreadable: true, status: res.status() }; }
    }
  };
  page.on('response', onSubmit);

  await page.getByRole('button', { name: /submit for admin review/i }).click();

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !submitBody) {
    await page.waitForTimeout(250);
  }
  page.off('response', onSubmit);

  if (!submitBody) throw new Error('submit POST never observed');

  if (submitBody.__unreadable) {
    if (submitBody.status >= 200 && submitBody.status < 300) {
      console.log('[wizard] submit body unreadable but status 2xx — falling back to DB lookup by company name');
      await page.waitForTimeout(1_500);
      return await findApplicationIdByCompanyName(inputs.companyName);
    }
    throw new Error(`submit failed: status=${submitBody.status} body unreadable`);
  }
  if (!submitBody?.success) {
    throw new Error(`submit failed: ${JSON.stringify(submitBody).slice(0, 400)}`);
  }
  const applicationId = submitBody?.data?.applicationId ?? submitBody?.data?.id;
  if (!applicationId) {
    return await findApplicationIdByCompanyName(inputs.companyName);
  }
  return applicationId as string;
}
