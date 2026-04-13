import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  auditLogs,
  coBorrowerRequests,
  coBorrowers,
  leads,
} from "@/lib/db/schema";
import {
  createWorkflowId,
  requireAdminAppUser,
} from "@/lib/kyc/admin-workflow";

// BRD §2.9.3 "Request Co-Borrower KYC" — admin opens this form from the CIBIL
// card or the primary final-decision panel. The route creates a stub
// coBorrowers row (if none exists) and a co_borrower_requests row tracking the
// attempt number. Lead kyc_status flips into a Step 3 co-borrower waiting
// state so the dealer's interim KYC page becomes accessible.

const bodySchema = z.object({
  reason: z.string().min(1, "Reason is required"),
  is_replacement: z.boolean().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { leadId } = await params;
    const body = await req.json();
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: "Validation failed",
            details: parsed.error.flatten(),
          },
        },
        { status: 400 },
      );
    }

    const { reason, is_replacement } = parsed.data;

    const leadRows = await db
      .select({ id: leads.id, kyc_status: leads.kyc_status })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    const lead = leadRows[0];
    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
    const seq = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, "0");

    // Find or stub a co-borrower row. If we are replacing, wipe the phone /
    // identity fields so the dealer can enter fresh details.
    const existingCob = await db
      .select()
      .from(coBorrowers)
      .where(eq(coBorrowers.lead_id, leadId))
      .limit(1);

    if (!existingCob[0]) {
      await db.insert(coBorrowers).values({
        id: `COBOR-${dateStr}-${seq}`,
        lead_id: leadId,
        full_name: "",
        phone: "",
        kyc_status: "not_started",
        created_at: now,
        updated_at: now,
      });
    } else if (is_replacement) {
      await db
        .update(coBorrowers)
        .set({
          full_name: "",
          father_or_husband_name: null,
          dob: null,
          phone: "",
          permanent_address: null,
          current_address: null,
          is_current_same: false,
          pan_no: null,
          aadhaar_no: null,
          kyc_status: "not_started",
          consent_status: "awaiting_signature",
          verification_submitted_at: null,
          updated_at: now,
        })
        .where(eq(coBorrowers.id, existingCob[0].id));
    }

    // Attempt number = (max attempt on existing requests) + 1
    const prior = await db
      .select({ attempt_number: coBorrowerRequests.attempt_number })
      .from(coBorrowerRequests)
      .where(eq(coBorrowerRequests.lead_id, leadId))
      .orderBy(desc(coBorrowerRequests.attempt_number))
      .limit(1);
    const nextAttempt = (prior[0]?.attempt_number ?? 0) + 1;

    // Close any open prior requests so only one is active at a time.
    await db
      .update(coBorrowerRequests)
      .set({ status: "replaced", updated_at: now })
      .where(
        and(
          eq(coBorrowerRequests.lead_id, leadId),
          eq(coBorrowerRequests.status, "open"),
        ),
      );

    const requestId = `COBREQ-${dateStr}-${seq}`;
    await db.insert(coBorrowerRequests).values({
      id: requestId,
      lead_id: leadId,
      attempt_number: nextAttempt,
      reason,
      status: "open",
      created_by: appUser.id,
      created_at: now,
      updated_at: now,
    });

    const currentStatus = lead.kyc_status ?? "";
    let nextStatus: string;
    if (is_replacement) {
      nextStatus = "awaiting_co_borrower_replacement";
    } else if (
      currentStatus === "awaiting_additional_docs" ||
      currentStatus === "awaiting_both"
    ) {
      nextStatus = "awaiting_both";
    } else {
      nextStatus = "awaiting_co_borrower_kyc";
    }

    await db
      .update(leads)
      .set({ kyc_status: nextStatus, updated_at: now })
      .where(eq(leads.id, leadId));

    await db.insert(auditLogs).values({
      id: createWorkflowId("AUDIT", now),
      entity_type: "step3_request_coborrower",
      entity_id: leadId,
      action: is_replacement ? "replacement" : "create",
      changes: {
        request_id: requestId,
        attempt_number: nextAttempt,
        reason,
        previous_status: currentStatus,
        new_status: nextStatus,
      },
      performed_by: appUser.id,
      timestamp: now,
    });

    return NextResponse.json({
      success: true,
      data: {
        request_id: requestId,
        attempt_number: nextAttempt,
        lead_status: nextStatus,
      },
    });
  } catch (error) {
    console.error("[Admin Step3 Request Co-Borrower] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to request co-borrower KYC";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
