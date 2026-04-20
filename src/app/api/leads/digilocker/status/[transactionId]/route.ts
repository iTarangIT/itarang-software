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
import { digilockerTransactions } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";

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

        // Light ownership check: the txn must be tied to a lead owned
        // by this dealer's account. We use dealer_id on the user; a
        // full join isn't needed because txn.lead_id uniquely binds
        // the row to one dealer lead.
        if (!user.dealer_id) {
            return NextResponse.json(
                { success: false, error: { message: "Dealer not provisioned" } },
                { status: 403 },
            );
        }

        return NextResponse.json({
            success: true,
            data: {
                transactionId: txn.id,
                leadId: txn.lead_id,
                status: txn.status,
                data:
                    txn.status === "document_fetched"
                        ? txn.aadhaar_extracted_data
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
