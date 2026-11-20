export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { consentRecords, kycDocuments, leads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { requireLeadAccess } from "@/lib/auth/requireLeadAccess";
import { requireLeadWriter } from "@/lib/leads/actForDealerGuard";
import { recordKycMilestone } from "@/lib/kyc/kycEventLog";

type RouteContext = {
    params: Promise<{ leadId: string }>;
};

// E-392 — the finance document list now comes from Settings › Customer KYC
// documents (src/lib/kyc/customer-doc-config.ts).

const UPFRONT_DOCUMENTS = [
    { key: "aadhaar_front", label: "Aadhaar Front", required: true },
    { key: "aadhaar_back", label: "Aadhaar Back", required: true },
    { key: "pan_card", label: "PAN Card", required: true },
] as const;

function isConsentVerified(status?: string | null) {
    const value = String(status || "").toLowerCase();
    return ["verified", "admin_verified", "manual_verified"].includes(value);
}

export async function POST(_req: NextRequest, { params }: RouteContext) {
    try {
        await requireRole(["dealer"]);
        const { leadId } = await params;

        if (!leadId) {
            return NextResponse.json(
                { success: false, error: { message: "Lead id missing" } },
                { status: 400 }
            );
        }

        // ---------------------------
        // Load lead
        // ---------------------------
        const leadRows = await db
            .select()
            .from(leads)
            .where(eq(leads.id, leadId))
            .limit(1);

        const lead = leadRows[0];

        if (!lead) {
            return NextResponse.json(
                { success: false, error: { message: "Lead not found" } },
                { status: 404 }
            );
        }

        // ---------------------------
        // Ownership check
        // ---------------------------
        // On the lead's dealership (leads.dealer_id), not its creator: the old
        // created_by comparison was skipped whenever the lead had no recorded
        // creator, which let any dealer through.
        const leadGate = await requireLeadAccess(leadId);
        if (!leadGate.ok) return leadGate.response;
        // ID 183: the file's own dealer (stamps the dealer's action); the
        // house login only sees a file it pushed to another dealer.
        const writer = await requireLeadWriter(leadId, _req, leadGate.user);
        if (!writer.ok) return writer.response;

        // ---------------------------
        // Step 2 access rule
        // ---------------------------
        const paymentMethod = String(lead.payment_method || "").toLowerCase();
        const interestLevel = String(lead.interest_level || "").toLowerCase();

        // Step 2 allowed only for hot leads with non-cash payment method
        const canBeInStep2 =
            interestLevel === "hot" &&
            paymentMethod !== "cash";

        if (!canBeInStep2) {
            return NextResponse.json(
                {
                    success: false,
                    error: {
                        message: "Step 2 completion allowed only for hot leads with non-cash payment method",
                    },
                },
                { status: 400 }
            );
        }

        // ---------------------------
        // Required documents by flow
        // ---------------------------
        const isFinance = ["finance", "dealer_finance", "other_finance", "loan"].includes(
            paymentMethod
        );

        // E-392 — a finance lead asks what the iTarang sales head configured
        // (Aadhaar front/back + PAN always); skipped-with-reason counts as met.
        const docCfg = await import("@/lib/kyc/customer-doc-config");
        const skippedDocs = isFinance ? (await docCfg.listSkips(leadId)).map((s) => s.docType) : [];
        const requiredDocs = isFinance
            ? docCfg.askedDocs(await docCfg.getCustomerDocConfig()).filter((k) => !(docCfg.canSkip(k) && skippedDocs.includes(k)))
            : UPFRONT_DOCUMENTS.filter((doc) => doc.required).map((doc) => doc.key);

        // ---------------------------
        // Load documents
        // ---------------------------
        const docRows = await db
            .select()
            .from(kycDocuments)
            .where(eq(kycDocuments.lead_id, leadId));

        const docMap = new Map(docRows.map((row) => [String(row.doc_type), row]));

        const missingDocuments = requiredDocs.filter((docType) => {
            const row = docMap.get(docType);
            return !row || !row.file_url;
        });

        if (missingDocuments.length > 0) {
            return NextResponse.json(
                {
                    success: false,
                    error: {
                        message: `Missing required documents: ${missingDocuments.join(", ")}`,
                    },
                },
                { status: 400 }
            );
        }

        // ---------------------------
        // Enforce admin verification
        // Dealer uploaded docs are not enough
        // ---------------------------
        const unverifiedDocuments = requiredDocs.filter((docType) => {
            const row = docMap.get(docType);
            const verificationStatus = String(row?.verification_status || "").toLowerCase();
            return verificationStatus !== "success";
        });

        if (unverifiedDocuments.length > 0) {
            return NextResponse.json(
                {
                    success: false,
                    error: {
                        message: `Admin verification pending for: ${unverifiedDocuments.join(", ")}`,
                    },
                },
                { status: 400 }
            );
        }

        // ---------------------------
        // Consent check skipped — consent is now handled in Step 3
        // ---------------------------

        // ---------------------------
        // Complete Step 2
        // ---------------------------
        const now = new Date();

        await db
            .update(leads)
            .set({
                workflow_step: 3,
                kyc_status: "completed",
                kyc_completed_at: now,
                status: "ACTIVE",
                updated_at: now,
            })
            .where(eq(leads.id, leadId));

        await recordKycMilestone(writer.actor, 'finished KYC step 2');
        return NextResponse.json({
            success: true,
            data: {
                leadId,
                workflow_step: 3,
                kyc_status: "completed",
                // ID 183: the old loan-options page is retired; Step 3 comes next.
                nextStep: "/dealer-portal/leads/" + leadId + "/borrower-consent",
                completedAt: now.toISOString(),
                message: "Step 2 completed successfully",
            },
        });
    } catch (error) {
        console.error("[Complete Step2] Error:", error);
        const message =
            error instanceof Error ? error.message : "Failed to complete Step 2";

        return NextResponse.json(
            { success: false, error: { message } },
            { status: 500 }
        );
    }
}
