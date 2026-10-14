// Dealer-scoped polling endpoint for the DigiLocker popup flow.
//
// The popup runs through Decentro → UIDAI → back to our callback. Browser
// COOP often nulls window.opener by the time the popup returns, which
// makes window.postMessage unreliable. Instead, the parent window polls
// this endpoint every ~2 seconds. When the callback has finished
// fetching eAadhaar, `status === "document_fetched"` and `data` carries
// the normalized fields ready to prefill the lead form.

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { digilockerTransactions, leads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { dealerMayActOnLead } from "@/lib/auth/requireLeadAccess";
import { maskAadhaarDeep } from "@/lib/kyc/aadhaarMask";

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ transactionId: string }> },
) {
    try {
        const user = await requireRole(["dealer"]);
        const { transactionId } = await params;

        const rows = await db
            .select()
            .from(digilockerTransactions)
            .where(eq(digilockerTransactions.id, transactionId))
            .limit(1);

        const txn = rows[0];
        if (!txn) {
            return NextResponse.json(
                { success: false, error: { message: "Transaction not found" } },
                { status: 404 },
            );
        }

        // ID 119: the transaction's lead must be this dealer's (its dealership,
        // with the onboarding-code fallback for a login with no dealer_id, or
        // the person who created it). The old check only asked whether the
        // caller had ANY dealer code, so any dealer could read any customer's
        // DigiLocker data by transaction id.
        const [lead] = txn.lead_id
            ? await db
                  .select({ dealer_id: leads.dealer_id, uploader_id: leads.uploader_id })
                  .from(leads)
                  .where(eq(leads.id, txn.lead_id))
                  .limit(1)
            : [];
        const mine =
            !!lead && (lead.uploader_id === user.id || (await dealerMayActOnLead(user, lead.dealer_id, txn.lead_id)));
        if (!mine) {
            return NextResponse.json(
                { success: false, error: { message: "Transaction not found" } },
                { status: 404 },
            );
        }

        return NextResponse.json({
            success: true,
            data: {
                transactionId: txn.id,
                leadId: txn.lead_id,
                status: txn.status,
                // ID 119: the Aadhaar number leaves masked; the prefill uses
                // the name, date of birth, address and photo, not the digits.
                data:
                    txn.status === "document_fetched"
                        ? maskAadhaarDeep(txn.aadhaar_extracted_data)
                        : null,
                verificationId: txn.verification_id ?? null,
            },
        });
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message === "Forbidden: Insufficient permissions"
                    ? "Forbidden"
                    : error.message
                : "Status lookup failed";
        const status = message === "Forbidden" ? 403 : 500;
        return NextResponse.json(
            { success: false, error: { message } },
            { status },
        );
    }
}
