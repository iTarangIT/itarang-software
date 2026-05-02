import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { kycVerifications } from "@/lib/db/schema";
import { publicOrigin } from "@/lib/public-origin";

/**
 * Path-segment DigiLocker callback for the co-borrower flow.
 *
 * Why this exists separately from `/callback/[transactionId]`:
 * - The path-segment-aware primary callback at
 *   src/app/api/kyc/digilocker/callback/[transactionId]/route.ts looks up
 *   `digilockerTransactions.id`, but co-borrower init doesn't write a row
 *   to that table — it stores session data in
 *   `kyc_verifications.api_response.data` instead.
 * - The earlier no-segment callback at
 *   src/app/api/kyc/digilocker/callback/route.ts tried to find the row via
 *   a JSONB equality match (`api_response.data.decentro_txn_id =
 *   ?initiation_decentro_transaction_id`). That misses if Decentro's
 *   redirect param doesn't byte-equal the value we captured at init time —
 *   exactly the failure mode the user kept hitting (consent never
 *   recorded, polling gate never opened, table empty).
 *
 * Path-segment lookup by `lead_id` removes the equality-match fragility:
 * there's at most one in-progress co-borrower aadhaar verification per
 * lead, so a `where lead_id = $1 AND verification_type = 'aadhaar' AND
 * applicant = 'co_borrower'` lookup can't miss when the row exists.
 *
 * Mirrors primary's `[transactionId]/route.ts:52` pattern of letting the
 * callback's `initiation_decentro_transaction_id` query param OVERRIDE
 * the stored `decentro_txn_id` — primary specifically works because of
 * that override (Decentro's redirect-time txn id may differ from the one
 * returned by the initiate call).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const { leadId } = await params;
    const url = new URL(req.url);
    const status = (url.searchParams.get("status") || "").toUpperCase();
    const ok = status === "SUCCESS";
    const callbackDecentroTxnId =
      url.searchParams.get("initiation_decentro_transaction_id") ||
      url.searchParams.get("decentro_txn_id") ||
      url.searchParams.get("decentroTxnId") ||
      null;

    const rows = await db
      .select({
        id: kycVerifications.id,
        api_response: kycVerifications.api_response,
      })
      .from(kycVerifications)
      .where(
        and(
          eq(kycVerifications.lead_id, leadId),
          eq(kycVerifications.verification_type, "aadhaar"),
          eq(kycVerifications.applicant, "co_borrower"),
        ),
      )
      .orderBy(desc(kycVerifications.created_at))
      .limit(1);

    const row = rows[0];
    if (row) {
      const apiResp = (row.api_response ?? {}) as Record<string, unknown>;
      const apiData = (apiResp.data ?? {}) as Record<string, unknown>;
      const now = new Date();
      const updatedData: Record<string, unknown> = {
        ...apiData,
        // Mirror primary's [transactionId]/route.ts:52 — let the callback's
        // query param override the init-time captured value when present.
        decentro_txn_id:
          callbackDecentroTxnId ||
          (apiData.decentro_txn_id as string | undefined) ||
          null,
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
        `[Co-Borrower DigiLocker Callback] Recorded consent for lead=${leadId} verification=${row.id} (status=${status}, decentroTxnIdFromCallback=${callbackDecentroTxnId ?? "null"})`,
      );
    } else {
      console.warn(
        `[Co-Borrower DigiLocker Callback] No co-borrower aadhaar verification for lead=${leadId} (initiation_decentro_transaction_id=${callbackDecentroTxnId ?? "null"})`,
      );
    }

    let base: string;
    try {
      base = publicOrigin({ req });
    } catch {
      // Last-resort fallback — keeps the redirect from crashing if no safe
      // public host can be derived. Worse than publicOrigin (may be the
      // proxy-internal host) but better than throwing on a customer-facing
      // redirect.
      base = req.nextUrl.origin;
    }
    const path = ok ? "/kyc/digilocker/success" : "/kyc/digilocker/failed";
    return NextResponse.redirect(new URL(path, base));
  } catch (error) {
    console.error(
      "[Co-Borrower DigiLocker Callback] Unexpected error:",
      error,
    );
    // Don't crash the customer-facing redirect — fall through to a plain
    // success/failed page based on whatever query param we have.
    const url = new URL(req.url);
    const ok = (url.searchParams.get("status") || "").toUpperCase() === "SUCCESS";
    const path = ok ? "/kyc/digilocker/success" : "/kyc/digilocker/failed";
    return NextResponse.redirect(new URL(path, req.nextUrl.origin));
  }
}
