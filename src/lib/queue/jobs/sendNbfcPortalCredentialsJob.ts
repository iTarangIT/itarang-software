/**
 * E-002 — Send NBFC portal credentials to primary_contact_email.
 *
 * Originally this was a BullMQ enqueue with the worker "intentionally out of
 * scope" — but no worker was ever built, so credentials never reached the
 * NBFC. Mirroring the dealer welcome-email pattern, we now send the email
 * inline via nodemailer at activation time.
 *
 * The in-memory recorder branch (NBFC_PORTAL_EMAIL_INMEMORY=1) is preserved
 * so existing tests that assert the function was called with the right
 * email + password keep passing.
 */
import { sendNbfcWelcomeEmail } from "@/lib/email/sendNbfcWelcomeEmail";

export type NbfcPortalCredentialJob = {
  nbfcId: number;
  credentialId: string;
  toEmail: string;
  password: string;
  supabaseUserId: string;
  primaryContactName: string;
  nbfcLegalName: string;
  nbfcCode: string;
  loginUrl: string;
  signedAgreementPdf?: Buffer | null;
  auditTrailPdf?: Buffer | null;
};

export const __inMemoryNbfcCredentialJobs: NbfcPortalCredentialJob[] = [];

function isInMemoryMode(): boolean {
  return process.env.NBFC_PORTAL_EMAIL_INMEMORY === "1";
}

export async function enqueueNbfcPortalCredentialsJob(
  payload: NbfcPortalCredentialJob,
): Promise<{ id: string }> {
  if (isInMemoryMode()) {
    __inMemoryNbfcCredentialJobs.push(payload);
    return { id: `inmem-${__inMemoryNbfcCredentialJobs.length}` };
  }

  await sendNbfcWelcomeEmail({
    toEmail: payload.toEmail,
    primaryContactName: payload.primaryContactName,
    nbfcLegalName: payload.nbfcLegalName,
    nbfcCode: payload.nbfcCode,
    loginEmail: payload.toEmail,
    password: payload.password,
    loginUrl: payload.loginUrl,
    supportEmail:
      process.env.NBFC_SUPPORT_EMAIL ||
      process.env.DEALER_SUPPORT_EMAIL ||
      "support@itarang.com",
    supportPhone:
      process.env.NBFC_SUPPORT_PHONE ||
      process.env.DEALER_SUPPORT_PHONE ||
      "+91-8076841497",
    signedAgreementPdf: payload.signedAgreementPdf,
    auditTrailPdf: payload.auditTrailPdf,
  });

  return { id: payload.credentialId };
}

export function __resetInMemoryNbfcCredentialJobs() {
  __inMemoryNbfcCredentialJobs.length = 0;
}
