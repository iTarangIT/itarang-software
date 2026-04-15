export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { consentRecords, leads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";

type RouteContext = {
    params: Promise<{ leadId: string }>;
};

function isConsentVerified(status?: string | null) {
    const value = String(status || "").toLowerCase();
    return ["verified", "admin_verified", "manual_verified"].includes(value);
}

export async function POST(_req: NextRequest, { params }: RouteContext) {
    try {
        const user = await requireRole(["dealer"]);
        const { leadId } = await params;

        if (!leadId) {
            return NextResponse.json(
                { success: false, error: { message: "Lead id missing" } },
                { status: 400 }
            );
        }

        // Load lead
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

        // Ownership check
        const ownerUserId = (lead as any)?.created_by ?? (lead as any)?.uploader_id ?? null;
        if (ownerUserId && ownerUserId !== user.id) {
            return NextResponse.json(
                { success: false, error: { message: "You do not have access to this lead" } },
                { status: 403 }
            );
        }

        // Step 3 access rule: must be hot + non-cash
        const paymentMethod = String(lead.payment_method || "").toLowerCase();
        const interestLevel = String(lead.interest_level || "").toLowerCase();

        if (interestLevel !== "hot" || paymentMethod === "cash") {
            return NextResponse.json(
                {
                    success: false,
                    error: {
                        message: "Step 3 allowed only for hot leads with non-cash payment method",
                    },
                },
                { status: 400 }
            );
        }

        // Consent check
        const consentRows = await db
            .select()
            .from(consentRecords)
            .where(eq(consentRecords.lead_id, leadId));

        const latestConsent = consentRows
            .sort(
                (a, b) =>
                    new Date(b.updated_at || b.created_at || 0).getTime() -
                    new Date(a.updated_at || a.created_at || 0).getTime()
            )[0];

        const leadConsentStatus = String(lead.consent_status || "");
        const consentRecordStatus = String(latestConsent?.consent_status || "");

        if (!isConsentVerified(leadConsentStatus) && !isConsentVerified(consentRecordStatus)) {
            return NextResponse.json(
                {
                    success: false,
                    error: {
                        message: "Borrower consent is not admin verified yet",
                    },
                },
                { status: 400 }
            );
        }

        // Complete Step 3
        const now = new Date();

        await db
            .update(leads)
            .set({
                workflow_step: 4,
                updated_at: now,
            })
            .where(eq(leads.id, leadId));

        return NextResponse.json({
            success: true,
            data: {
                leadId,
                workflow_step: 4,
                nextStep: `/dealer-portal/leads/${leadId}/kyc/interim`,
                completedAt: now.toISOString(),
                message: "Step 3 completed. Proceed to co-borrower & additional documents.",
            },
        });
    } catch (error) {
        console.error("[Complete Step3] Error:", error);
        const message =
            error instanceof Error ? error.message : "Failed to complete Step 3";

        return NextResponse.json(
            { success: false, error: { message } },
            { status: 500 }
        );
    }
}
