import { test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { installAllStubs } from '../helpers/api-stubs';
import { SANDBOX_ROLES } from '../coverage/roles';

const AUTH_DIR = path.join('tests', '.auth');

/** Resolve a role's storage-state file at RUN time (setup has written it by now). */
export function authStateFor(role: string): string | null {
  const entry = SANDBOX_ROLES.find((r) => r.role === role);
  if (!entry) return null;
  const p = path.join(AUTH_DIR, entry.stateFile);
  return fs.existsSync(p) ? p : null;
}

/**
 * Open a page with the given storage state (or unauthenticated when null) and
 * the full stubbed-external-world already installed (paid-host abort net +
 * Decentro/Digio/S3/Bolna/Razorpay/scraper/AI stubs). Extra per-test route
 * stubs should be added on the returned page BEFORE navigating.
 */
export async function stubbedPage(
  browser: Browser,
  storageState: string | null,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(
    storageState ? { storageState } : {},
  );
  const page = await context.newPage();
  await installAllStubs(page);
  return { context, page };
}

/**
 * Open an authenticated page WITHOUT the external-stub world installed. Some
 * routes (e.g. /leads/new) trigger a client-side Supabase session refresh that
 * the paid-host abort net interferes with, dropping the session and bouncing to
 * /login. When a spec only needs to stub its own app endpoint, use this and add
 * that single page.route(...) itself.
 */
export async function plainAuthPage(
  browser: Browser,
  storageState: string | null,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(
    storageState ? { storageState } : {},
  );
  const page = await context.newPage();
  return { context, page };
}

/** JSON shape attached per step; the workflow reporter reads these to build the
 * "Detailed Steps" worksheet. Keep field names stable — the reporter parses them. */
export type StepDetail = {
  description: string;
  expected: string;
  actual: string;
  status: 'Pass' | 'Fail';
  error: string;
  durationMs: number;
};

export const STEP_ATTACHMENT = 'step-detail';

/**
 * Run one "code-by-code" test step and record it for the Excel report.
 *
 * Wraps the body in a named `test.step` (so it also shows in the HTML report /
 * trace) and attaches a `step-detail` JSON blob capturing the human-readable
 * description, what we expected, what we actually observed, pass/fail, and the
 * step duration. The reporter turns each attachment into one row of the
 * "Detailed Steps" sheet.
 *
 * `fn` should perform the action/assertion and RETURN a short human string
 * describing what it actually observed (e.g. "redirected to …/kyc",
 * "field value = Vijay Sharma", "3 required-field errors shown"). If `fn`
 * throws (e.g. an expect() assertion fails) the step is recorded as Fail with
 * the error message, then the error is re-thrown so Playwright fails the test
 * as usual — the summary sheet stays honest.
 */
export async function detailStep(
  testInfo: TestInfo,
  meta: { description: string; expected: string },
  fn: () => Promise<string> | string,
): Promise<void> {
  await test.step(meta.description, async () => {
    const start = Date.now();
    let actual = '';
    let status: StepDetail['status'] = 'Pass';
    let error = '';
    try {
      actual = (await fn()) ?? '';
    } catch (e) {
      status = 'Fail';
      error = (e as Error)?.message ?? String(e);
      actual = actual || '(step threw before observing a value)';
      throw e;
    } finally {
      const rec: StepDetail = {
        description: meta.description,
        expected: meta.expected,
        actual,
        status,
        error,
        durationMs: Date.now() - start,
      };
      await testInfo.attach(STEP_ATTACHMENT, {
        body: JSON.stringify(rec),
        contentType: 'application/json',
      });
    }
  });
}
