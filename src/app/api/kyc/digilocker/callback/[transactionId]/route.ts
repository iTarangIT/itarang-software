import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  dealerLeads,
  digilockerTransactions,
  kycVerifications,
  personalDetails,
} from "@/lib/db/schema";
import { crossMatchAadhaarData } from "@/lib/kyc/cross-match";
import { publicOrigin, PublicOriginError } from "@/lib/public-origin";

/**
 * DigiLocker Callback — PUBLIC endpoint (no auth).
 * GET: Browser redirect from DigiLocker after customer consent.
 * POST: Webhook from Decentro with document data.
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
  req: NextRequest,
  { params }: { params: Promise<{ transactionId: string }> },
) {
  try {
    const { transactionId } = await params;
    const body = await req.json();

    // Validate transaction exists
    const txnRows = await db
      .select()
      .from(digilockerTransactions)
      .where(eq(digilockerTransactions.id, transactionId))
      .limit(1);

    const txn = txnRows[0];
    if (!txn) {
      return NextResponse.json(
        { success: false, error: "Invalid transaction ID" },
        { status: 400 },
      );
    }

    // Prevent duplicate processing
    if (txn.status === "document_fetched") {
      return NextResponse.json({ success: true, message: "Already processed" });
    }

    const now = new Date();

    // Extract Aadhaar data from callback payload
    const documents = body.documents || [];
    const aadhaarDoc = documents.find(
      (d: { type?: string }) => d.type === "aadhaar",
    );
    const rawData = aadhaarDoc?.data || body.data || body;

    const aadhaarData = {
      uid: rawData.uid || rawData.aadhaar_number || null,
      name: rawData.name || null,
      gender: rawData.gender || null,
      dob: rawData.dob || rawData.date_of_birth || null,
      careof: rawData.careof || rawData.care_of || null,
      house: rawData.house || null,
      street: rawData.street || null,
      landmark: rawData.landmark || null,
      locality: rawData.locality || null,
      vtc: rawData.vtc || null,
      district: rawData.dist || rawData.district || null,
      state: rawData.state || null,
      pincode: rawData.pincode || rawData.zip || null,
      address: rawData.address || rawData.full_address || null,
      photo_base64: rawData.photo_base64 || rawData.photo || null,
      mobile: rawData.mobile || rawData.phone || null,
    };

    // Build full address if individual components provided
    if (!aadhaarData.address && (aadhaarData.house || aadhaarData.street)) {
      aadhaarData.address = [
        aadhaarData.house,
        aadhaarData.street,
        aadhaarData.landmark,
        aadhaarData.locality,
        aadhaarData.vtc,
        aadhaarData.district,
        aadhaarData.state,
        aadhaarData.pincode,
      ]
        .filter(Boolean)
        .join(", ");
    }

    // Cross-match with lead data
    const leadId = txn.lead_id;
    const [leadRows, personalRows] = await Promise.all([
      db
        .select()
        .from(dealerLeads)
        .where(eq(dealerLeads.id, leadId))
        .limit(1),
      db
        .select()
        .from(personalDetails)
        .where(eq(personalDetails.lead_id, leadId))
        .limit(1),
    ]);

    const lead = leadRows[0];
    const personal = personalRows[0];
    let crossMatchResult = null;

    if (lead) {
      crossMatchResult = crossMatchAadhaarData(
        {
          name: aadhaarData.name,
          dob: aadhaarData.dob,
          phone: aadhaarData.mobile,
          address: aadhaarData.address,
          gender: aadhaarData.gender,
          fatherOrHusbandName: aadhaarData.careof,
        },
        {
          name: lead.dealer_name,
          dob: personal?.dob
            ? new Date(personal.dob).toISOString().slice(0, 10)
            : null,
          phone: lead.phone,
          address: personal?.local_address || lead.location,
          gender: null,
          fatherOrHusbandName: personal?.father_husband_name,
        },
      );
    }

    // Update DigiLocker transaction
    await db
      .update(digilockerTransactions)
      .set({
        status: "document_fetched",
        customer_authorized_at: body.consent_given_at
          ? new Date(body.consent_given_at)
          : now,
        digilocker_raw_response: body,
        aadhaar_extracted_data: aadhaarData,
        cross_match_result: crossMatchResult,
        updated_at: now,
      })
      .where(eq(digilockerTransactions.id, transactionId));

    // Update verification record
    if (txn.verification_id) {
      await db
        .update(kycVerifications)
        .set({
          status: crossMatchResult?.overallPass ? "success" : "failed",
          api_response: body,
          match_score: crossMatchResult?.nameSimilarity
            ? String(crossMatchResult.nameSimilarity)
            : null,
          completed_at: now,
          updated_at: now,
        })
        .where(eq(kycVerifications.id, txn.verification_id));
    }

    return NextResponse.json({ success: true, message: "Callback processed" });
  } catch (error) {
    console.error("[DigiLocker Callback] Error:", error);
    // Return 200 to prevent Decentro from retrying on our error
    return NextResponse.json(
      { success: false, error: "Internal processing error" },
      { status: 200 },
    );
  }
}
