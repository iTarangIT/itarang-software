export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leads, personalDetails } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";

type RouteContext = {
    params: Promise<{ leadId: string }>;
};

export async function GET(_req: NextRequest, { params }: RouteContext) {
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
                { success: false, error: { message: "Access denied" } },
                { status: 403 }
            );
        }

        // Load personal details
        const personalRows = await db
            .select()
            .from(personalDetails)
            .where(eq(personalDetails.lead_id, leadId))
            .limit(1);

        const personal = personalRows[0] || null;

        return NextResponse.json({
            success: true,
            data: {
                // From personal_details table
                aadhaar_no: personal?.aadhaar_no || null,
                pan_no: personal?.pan_no || null,
                dob: personal?.dob || lead.dob || null,
                email: personal?.email || null,
                income: personal?.income || null,
                finance_type: personal?.finance_type || null,
                financier: personal?.financier || null,
                father_husband_name: personal?.father_husband_name || null,
                marital_status: personal?.marital_status || null,
                spouse_name: personal?.spouse_name || null,
                local_address: personal?.local_address || null,
            },
        });
    } catch (error) {
        console.error("[Borrower Details] Error:", error);
        const message =
            error instanceof Error ? error.message : "Failed to fetch borrower details";

        return NextResponse.json(
            { success: false, error: { message } },
            { status: 500 }
        );
    }
}
