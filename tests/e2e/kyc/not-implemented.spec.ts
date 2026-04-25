import { test } from '../fixtures';

/**
 * Documented unimplemented backend flows. Each entry is a test.skip with a
 * structured NOT_IMPLEMENTED: reason that the Excel reporter picks up and
 * surfaces in the dedicated "Not Implemented" sheet.
 *
 * Remove (or convert to real tests) once the referenced backend route is built.
 */
test.describe('KYC flows awaiting backend implementation', () => {
  test('co-borrower send-consent dispatches SMS + WhatsApp [kyc-review] [not-implemented]', () => {
    test.skip(
      true,
      'NOT_IMPLEMENTED: co-borrower send-consent SMS/WhatsApp dispatch (src/app/api/coborrower/[leadId]/send-consent/route.ts)',
    );
  });

  test('co-borrower submit-verification triggers third-party API [kyc-review] [not-implemented]', () => {
    test.skip(
      true,
      'NOT_IMPLEMENTED: co-borrower submit-verification third-party integration (src/app/api/coborrower/[leadId]/submit-verification/route.ts)',
    );
  });

  test('co-borrower submit-other-docs-review creates admin notification [kyc-review] [not-implemented]', () => {
    test.skip(
      true,
      'NOT_IMPLEMENTED: co-borrower submit-other-docs-review admin notification + email (src/app/api/coborrower/[leadId]/submit-other-docs-review/route.ts)',
    );
  });

  test('KYC complete-and-next fires dealer + sales notifications [kyc-review] [not-implemented]', () => {
    test.skip(
      true,
      'NOT_IMPLEMENTED: KYC complete-and-next notifications (src/app/api/kyc/[leadId]/complete-and-next/route.ts)',
    );
  });

  test('KYC re-upload triggers re-verification [kyc-review] [not-implemented]', () => {
    test.skip(
      true,
      'NOT_IMPLEMENTED: KYC re-upload re-verification (src/app/api/kyc/[leadId]/re-upload/route.ts)',
    );
  });

  test('sales-manager request-doc sends SMS to customer [kyc-review] [not-implemented]', () => {
    test.skip(
      true,
      'NOT_IMPLEMENTED: SM request-doc SMS via Twilio/MSG91 (src/app/api/sm/leads/[id]/request-doc/route.ts)',
    );
  });
});
