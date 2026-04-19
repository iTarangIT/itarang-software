import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { kycVerifications } from "@/lib/db/schema";
import { verifyBankAccount } from "@/lib/decentro";

export type BankVerificationInput = {
  accountNumber: string;
  ifsc: string;
  name?: string;
  performNameMatch?: boolean;
  validationType?: 'penniless' | 'pennydrop' | 'hybrid';
};

export type BankVerificationResult = {
  success: boolean;
  responseStatus?: string;
  message?: string;
  data: (Record<string, unknown> & { verificationId?: string }) | null;
};

export type BankVerificationError = {
  success: false;
  status: number;
  error: string;
};

export async function executeBankVerification(
  leadId: string,
  input: BankVerificationInput,
): Promise<BankVerificationResult | BankVerificationError> {
  const { accountNumber, ifsc, name, performNameMatch, validationType } = input;

  if (!accountNumber || !ifsc) {
    return {
      success: false,
      status: 400,
      error: "account_number and ifsc are required",
    };
  }

  const decentroRes = await verifyBankAccount({
    account_number: accountNumber,
    ifsc: ifsc.toUpperCase().trim(),
    name,
    perform_name_match: performNameMatch,
    validation_type: validationType,
  });

  console.log("[Decentro Bank V2] Response:", JSON.stringify(decentroRes));

  const success =
    decentroRes.api_status === "Success" ||
    decentroRes.responseStatus === "SUCCESS" ||
    decentroRes.response_key === "success";

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");

  const existing = await db
    .select({ id: kycVerifications.id })
    .from(kycVerifications)
    .where(
      and(
        eq(kycVerifications.lead_id, leadId),
        eq(kycVerifications.verification_type, "bank"),
      ),
    )
    .limit(1);

  const verificationId = existing[0]?.id || `KYCVER-${dateStr}-${seq}`;

  const verData = {
    status: success ? ("success" as const) : ("failed" as const),
    api_provider: "decentro",
    api_request: {
      account_number: accountNumber,
      ifsc,
      perform_name_match: performNameMatch,
      validation_type: validationType,
    },
    api_response: decentroRes,
    failed_reason: success
      ? null
      : (decentroRes.message as string | undefined) || "Bank verification failed",
    completed_at: now,
    updated_at: now,
  };

  if (existing.length > 0) {
    await db
      .update(kycVerifications)
      .set(verData)
      .where(
        and(
          eq(kycVerifications.lead_id, leadId),
          eq(kycVerifications.verification_type, "bank"),
        ),
      );
  } else {
    await db.insert(kycVerifications).values({
      id: verificationId,
      lead_id: leadId,
      verification_type: "bank",
      submitted_at: now,
      created_at: now,
      ...verData,
    });
  }

  // Decentro v2 /core_banking returns fields at the top level (no `data` envelope).
  // Pass the whole response through so the UI can read accountStatus, beneficiaryName,
  // bankReferenceNumber, etc. directly.
  const nested = (decentroRes.data || null) as Record<string, unknown> | null;
  const data: Record<string, unknown> = { ...decentroRes, ...(nested || {}), verificationId };

  return {
    success,
    responseStatus: decentroRes.responseStatus,
    message: decentroRes.message as string | undefined,
    data,
  };
}
