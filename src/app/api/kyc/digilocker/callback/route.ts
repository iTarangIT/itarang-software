import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { kycVerifications } from "@/lib/db/schema";
import { publicOrigin } from "@/lib/public-origin";

/**
 * No-segment DigiLocker callback handler — used by the co-borrower flow.
 *
 * Why this exists separately from
 * `/api/kyc/digilocker/callback/[transactionId]/route.ts`: the co-borrower
 * init helper writes to `kyc_verifications.api_response.data` (no
 * `digilockerTransactions` row), and the path-segment callback looks up by
 * `digilockerTransactions.id`. So the co-borrower init passes a redirect
 * URL without a path segment and Decentro hits this handler instead.
 *
 * What this handler MUST do — and the previous implementation did NOT:
 * mark the matching co-borrower verification row as "consent received".
 * The status helper at `executeCoBorrowerDigilockerStatus` polls Decentro's
 * eAadhaar endpoint, but Decentro's docs (and primary's status route at
 * src/app/api/admin/kyc/[leadId]/aadhaar/digilocker/status/[transactionId]/route.ts:128-138)
 * warn that calling /v2/kyc/digilocker/eaadhaar BEFORE the customer has
 * consented can invalidate the session. After invalidation Decentro keeps
 * returning "no consent" even after the customer signs — which is exactly
 * the symptom the user reported. The fix: set
 * api_response.data.consent_given_at here so the status helper can defer
 * its eAadhaar fetch until consent has actually landed.
 *
 * Host resolution: behind a reverse proxy (nginx → 127.0.0.1:3003)
 * `req.nextUrl.origin` resolves to the internal host. Use publicOrigin so
 * the customer's browser is sent back to the public host they came from.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const status = (searchParams.get("status") || "").toUpperCase();
  const ok = status === "SUCCESS";

  // Decentro returns its session/transaction id as
  // `initiation_decentro_transaction_id` on the redirect query string. That
  // matches whatever the init helper stored under
  // api_response.data.decentro_txn_id, so we can find the right
  // co-borrower verification row by JSON-path filter.
  const initDecentroTxnId =
    searchParams.get("initiation_decentro_transaction_id") ||
    searchParams.get("decentro_txn_id") ||
    searchParams.get("decentroTxnId") ||
    null;

  if (initDecentroTxnId) {
    try {
      // Postgres jsonb path filter — find the co-borrower aadhaar row
      // whose api_response.data.decentro_txn_id matches.
      const rows = await db
        .select({
          id: kycVerifications.id,
          api_response: kycVerifications.api_response,
        })
        .from(kycVerifications)
        .where(
          and(
            eq(kycVerifications.verification_type, "aadhaar"),
            eq(kycVerifications.applicant, "co_borrower"),
            sql`${kycVerifications.api_response}->'data'->>'decentro_txn_id' = ${initDecentroTxnId}`,
          ),
        )
        .orderBy(desc(kycVerifications.created_at))
        .limit(1);

      const row = rows[0];
      if (row) {
        const apiResp = (row.api_response ?? {}) as Record<string, unknown>;
        const apiData = (apiResp.data ?? {}) as Record<string, unknown>;
        const now = new Date();
        const updatedData = {
          ...apiData,
          consent_given_at: ok ? now.toISOString() : (apiData.consent_given_at ?? null),
          consent_status: ok ? "given" : "denied",
          callback_received_at: now.toISOString(),
        };
        await db
          .update(kycVerifications)
          .set({
            api_response: { ...apiResp, data: updatedData },
            updated_at: now,
          })
          .where(eq(kycVerifications.id, row.id));
        console.log(
          `[Co-Borrower DigiLocker Callback] Recorded consent for verification ${row.id} (status=${status})`,
        );
      } else {
        console.warn(
          `[Co-Borrower DigiLocker Callback] No matching co-borrower aadhaar verification for initiation_decentro_transaction_id=${initDecentroTxnId}`,
        );
      }
    } catch (err) {
      // Don't block the customer-facing redirect on a DB error — log and
      // proceed. The customer should still see the friendly success page.
      console.error("[Co-Borrower DigiLocker Callback] DB update failed:", err);
    }
  } else {
    console.warn(
      "[Co-Borrower DigiLocker Callback] No initiation_decentro_transaction_id in query string — skipping consent update",
    );
  }

  const path = ok ? "/kyc/digilocker/success" : "/kyc/digilocker/failed";
  let base: string;
  try {
    base = publicOrigin({ req });
  } catch {
    base = req.nextUrl.origin;
  }
  return NextResponse.redirect(new URL(path, base));
}
