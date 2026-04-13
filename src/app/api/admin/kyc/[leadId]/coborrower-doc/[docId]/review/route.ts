import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  auditLogs,
  coBorrowerDocuments,
} from "@/lib/db/schema";
import {
  createWorkflowId,
  requireAdminAppUser,
} from "@/lib/kyc/admin-workflow";

// BRD §2.9.3 Panel 3 "Co-Borrower Document Cards — Per-Check Action Buttons"
// Admin approves or rejects individual co-borrower documents from the case
// review screen. Each action writes an audit row; rejection triggers a
// dealer re-upload loop (dealer already has the upload flow wired from the
// existing interim KYC page).

const bodySchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().optional(),
  rejection_reason: z.string().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string; docId: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { leadId, docId } = await params;
    const parsed = bodySchema.safeParse(await req.json());
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

    const { action, note, rejection_reason } = parsed.data;

    if (action === "reject" && !rejection_reason?.trim()) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "rejection_reason is required when rejecting" },
        },
        { status: 400 },
      );
    }

    const existing = await db
      .select()
      .from(coBorrowerDocuments)
      .where(
        and(
          eq(coBorrowerDocuments.id, docId),
          eq(coBorrowerDocuments.lead_id, leadId),
        ),
      )
      .limit(1);
    const row = existing[0];
    if (!row) {
      return NextResponse.json(
        { success: false, error: { message: "Co-borrower doc not found" } },
        { status: 404 },
      );
    }

    const now = new Date();
    const newStatus = action === "approve" ? "verified" : "rejected";

    await db
      .update(coBorrowerDocuments)
      .set({ status: newStatus, updated_at: now })
      .where(eq(coBorrowerDocuments.id, docId));

    await db.insert(auditLogs).values({
      id: createWorkflowId("AUDIT", now),
      entity_type: "co_borrower_doc_review",
      entity_id: docId,
      action,
      changes: {
        lead_id: leadId,
        doc_type: row.doc_type,
        previous_status: row.status,
        new_status: newStatus,
        note: note ?? null,
        rejection_reason: rejection_reason ?? null,
      },
      performed_by: appUser.id,
      timestamp: now,
    });

    return NextResponse.json({
      success: true,
      data: { doc_id: docId, status: newStatus },
    });
  } catch (error) {
    console.error("[Co-Borrower Doc Review] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to review co-borrower document";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
