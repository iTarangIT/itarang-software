import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { digilockerTransactions } from "@/lib/db/schema";
import { publicOrigin, PublicOriginError } from "@/lib/public-origin";

/**
 * DigiLocker Callback — PUBLIC endpoint (no auth).
 * GET: Browser redirect from DigiLocker after customer consent.
 * POST: acknowledged and ignored (see the handler) — the document comes from
 *       Decentro through the status poll, never from a request.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ transactionId: string }> },
) {
  try {
    const { transactionId } = await params;
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const decentroTxnId = url.searchParams.get("initiation_decentro_transaction_id");

    console.log("[DigiLocker Callback GET]", { transactionId, status, decentroTxnId });

    // Validate transaction exists
    const txnRows = await db
      .select()
      .from(digilockerTransactions)
      .where(eq(digilockerTransactions.id, transactionId))
      .limit(1);

    const txn = txnRows[0];
    if (!txn) {
      return new NextResponse("Invalid transaction", { status: 400 });
    }

    const now = new Date();

    if (status === "SUCCESS" && txn.status !== "document_fetched") {
      // Customer gave consent — update status so polling can pick up and fetch eAadhaar
      await db
        .update(digilockerTransactions)
        .set({
          status: "consent_given",
          customer_authorized_at: now,
          decentro_txn_id: decentroTxnId || txn.decentro_txn_id,
          updated_at: now,
        })
        .where(eq(digilockerTransactions.id, transactionId));
    } else if (status === "FAILURE" || status === "DENIED") {
      await db
        .update(digilockerTransactions)
        .set({ status: "failed", updated_at: now })
        .where(eq(digilockerTransactions.id, transactionId));
    }

    // Post-consent redirect back to the app. Route through publicOrigin so
    // the safe-host allow-list applies here too — otherwise a stale ngrok
    // value in NEXT_PUBLIC_APP_URL lands the customer on a dead tunnel
    // (2026-04-23 incident; full writeup in src/lib/public-origin.ts).
    let redirectBase: string;
    try {
      redirectBase = publicOrigin({ req });
    } catch (err) {
      console.error(
        "[DigiLocker Callback GET] No safe public origin available:",
        err instanceof PublicOriginError ? err.message : err,
      );
      return new NextResponse(
        status === "SUCCESS"
          ? "Aadhaar verification complete. You can close this window."
          : "Aadhaar verification did not complete. Please contact support.",
        { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }

    const redirectPath =
      status === "SUCCESS" ? "/kyc/digilocker/success" : "/kyc/digilocker/failed";
    return NextResponse.redirect(new URL(redirectPath, redirectBase));
  } catch (error) {
    console.error("[DigiLocker Callback GET] Error:", error);
    return new NextResponse("Something went wrong. Please close this window.", { status: 200 });
  }
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ transactionId: string }> },
) {
  // ID 118 — this handler used to take the Aadhaar fields FROM THE REQUEST BODY,
  // cross-match them against the lead and mark the KYC verification "success".
  // Nothing proves who is calling: the transaction id is in the redirect URL the
  // customer's own browser sees, so anyone holding it could post made-up Aadhaar
  // details and pass the check.
  //
  // Decentro does not call it either — the session is initiated with a
  // redirect_url only (lib/kyc/digilocker.ts), which is the GET above. The real
  // e-Aadhaar is fetched from Decentro by the status poll, with our own
  // credentials (digilockerCheckStatus), and that is the only thing that writes
  // the document, the cross-match and the verification result.
  //
  // So a POST is acknowledged and changes nothing.
  try {
    const { transactionId } = await params;
    const txnRows = await db
      .select({ id: digilockerTransactions.id })
      .from(digilockerTransactions)
      .where(eq(digilockerTransactions.id, transactionId))
      .limit(1);
    if (!txnRows[0]) {
      return NextResponse.json(
        { success: false, error: "Invalid transaction ID" },
        { status: 400 },
      );
    }
    console.warn(
      "[DigiLocker Callback] POST ignored — e-Aadhaar is read from Decentro, never from a request body",
      { transactionId },
    );
    return NextResponse.json({ success: true, message: "Acknowledged" });
  } catch (error) {
    console.error("[DigiLocker Callback] Error:", error);
    return NextResponse.json(
      { success: false, error: "Internal processing error" },
      { status: 200 },
    );
  }
}
