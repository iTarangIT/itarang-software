export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
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

        const ownerUserId = (lead as any)?.created_by ?? (lead as any)?.uploader_id ?? null;
        if (ownerUserId && ownerUserId !== user.id) {
            return NextResponse.json(
                { success: false, error: { message: "Access denied" } },
                { status: 403 }
            );
        }

        // Borrower details are stored independently of the customer. The
        // borrower draft lives in leads.kyc_draft_data.borrowerForm (written by
        // /api/kyc/[leadId]/save-draft at step 3). Return only that — do not
        // leak the customer's personal_details into the borrower form.
        const draft = (lead as any)?.kyc_draft_data || {};
        const borrowerForm = draft?.borrowerForm || {};

        return NextResponse.json({
            success: true,
            data: {
                full_name: borrowerForm.full_name || null,
                phone: borrowerForm.phone || null,
                father_husband_name: borrowerForm.father_or_husband_name || null,
                dob: borrowerForm.dob || null,
                email: borrowerForm.email || null,
                pan_no: borrowerForm.pan_no || null,
                aadhaar_no: borrowerForm.aadhaar_no || null,
                income: borrowerForm.income || null,
                marital_status: borrowerForm.marital_status || null,
                local_address: borrowerForm.current_address || null,
                permanent_address: borrowerForm.permanent_address || null,
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
