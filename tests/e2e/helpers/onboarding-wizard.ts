import { expect, type Page } from '@playwright/test';
import { preloadAllSamples } from './sample-docs';
import { findApplicationIdByCompanyName } from './dealer-creds';

export type OnboardingWizardInputs = {
  companyName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  gstin: string;
  pan: string;
};

/**
 * Drives the 6-step public dealer-onboarding wizard at /dealer-onboarding
 * end-to-end: Company → Documents → Ownership (sole-prop) → Finance (no) →
 * Review → Submit. Returns the applicationId from the submit response (or
 * via DB lookup fallback when the page redirect eats the response body).
 *
 * The fillers always select Company Type = sole_proprietorship and
 * Finance = No so Step 5 (Agreement) is skipped.
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

  // STEP 1 — Company
  await page.locator('input[placeholder="Company Name"]').fill(inputs.companyName);
  await page.locator('select').first().selectOption('sole_proprietorship');
  await page.locator('input[placeholder="Company Address"]').fill('221B Test Street, Mumbai, Maharashtra 400001');
  await page.locator('input[placeholder="GST Number"]').fill(inputs.gstin);
  await page.locator('input[placeholder="Company PAN Number"]').fill(inputs.pan);
  await page.locator('textarea[placeholder="Business Details - Summary"]').fill('E2E sole-prop test dealer.');

  // 2 file uploads on Step 1: GST cert + Company PAN
  const step1FileInputs = page.locator('input[type="file"]');
  await step1FileInputs.nth(0).setInputFiles(samples.pdfs.gst);
  await step1FileInputs.nth(1).setInputFiles(samples.pdfs.panFile);

  await waitForUploadsToReach(2, 'step 1');
  await page.getByRole('button', { name: /next/i }).click();

  // STEP 2 — Documents (5 uploads)
  await expect(page.getByRole('heading', { name: /financial.*compliance documents/i })).toBeVisible({ timeout: 15_000 });
  const step2FileInputs = page.locator('input[type="file"]');
  await step2FileInputs.nth(0).setInputFiles(samples.pdfs.itr);
  await step2FileInputs.nth(1).setInputFiles(samples.pdfs.bank);
  await step2FileInputs.nth(2).setInputFiles(samples.pdfs.cheques);
  await step2FileInputs.nth(3).setInputFiles(samples.pngs.photo);
  await step2FileInputs.nth(4).setInputFiles(samples.pdfs.udyam);

  await waitForUploadsToReach(2 + 5, 'step 2');
  await page.getByRole('button', { name: /next/i }).click();

  // STEP 3 — Ownership (sole prop branch)
  await expect(page.getByRole('heading', { name: /ownership.*banking/i })).toBeVisible({ timeout: 15_000 });

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

  // STEP 4 — Finance: choose "No, continue without finance"
  await expect(page.getByRole('heading', { name: /finance enablement/i })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /no, continue without finance/i }).click();
  await page.getByRole('button', { name: /next/i }).click();

  // STEP 6 — Review (Step 5 skipped because finance=no)
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
