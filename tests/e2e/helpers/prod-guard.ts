/**
 * Hard gate for any test that targets crm.itarang.com. Production runs trigger
 * real Decentro KYC, DigiO esign, Razorpay, and Bolna calls — they cost money
 * and write to the real customer database. Two independent signals must agree
 * before any prod test is allowed to start:
 *
 *   1. E2E_ALLOW_PROD === '1'              (deliberate operator opt-in)
 *   2. E2E_BASE_URL points at crm.itarang  (config really targets prod)
 *
 * If either is missing the helper throws synchronously so the test fails before
 * the browser even launches.
 */

const PROD_HOST_REGEX = /^https?:\/\/crm\.itarang\.com\/?/i;

export function isProdRun(): boolean {
  return (
    process.env.E2E_ALLOW_PROD === '1' &&
    PROD_HOST_REGEX.test(process.env.E2E_BASE_URL ?? '')
  );
}

export function assertProdAllowed(): void {
  const allowFlag = process.env.E2E_ALLOW_PROD === '1';
  const baseURL = process.env.E2E_BASE_URL ?? '';
  const baseURLOk = PROD_HOST_REGEX.test(baseURL);

  if (!allowFlag || !baseURLOk) {
    throw new Error(
      [
        '[prod-guard] refusing to run — production guardrail tripped.',
        `  E2E_ALLOW_PROD = ${process.env.E2E_ALLOW_PROD ?? '(unset)'}  (must be "1")`,
        `  E2E_BASE_URL   = ${baseURL || '(unset)'}                 (must match https://crm.itarang.com)`,
      ].join('\n'),
    );
  }
}

/**
 * Mutating actions (Approve dealer, Final-decision KYC, e-sign initiate) require
 * a second flag on top of the prod gate. Read-only specs ignore this; specs that
 * trigger real charges or create real Supabase auth users wrap the dangerous
 * step in `if (mutationsAllowed()) { … } else test.skip(true, '…')`.
 */
export function mutationsAllowed(): boolean {
  return process.env.E2E_PROD_MUTATIONS === '1';
}
