import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  auditLogs,
  otherDocumentRequests,
} from "@/lib/db/schema";
import {
  createWorkflowId,
  requireAdminAppUser,
} from "@/lib/kyc/admin-workflow";
import {
  autoPushNbfcIfAllVerified,
  recomputeWrapperStatus,
} from "@/lib/nbfc/doc-requests";
import { notifyNbfcOfUpdate } from "@/lib/nbfc/doc-request-notify";

// BRD §2.9.3 Panel 2 "Per-Document Action Buttons" — admin verifies or
// rejects an uploaded supporting document from the case-review screen.
// On reject the dealer is expected to re-upload; the row stays open with a
// new rejection_reason. On approve the row flips to verified.

const bodySchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().optional(),
  rejection_reason: z.string().optional(),
});

export async function POST(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ leadId: string; requestId: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { leadId, requestId } = await params;
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
      .from(otherDocumentRequests)
      .where(
        and(
          eq(otherDocumentRequests.id, requestId),
          eq(otherDocumentRequests.lead_id, leadId),
        ),
      )
      .limit(1);

    const row = existing[0];
    if (!row) {
      return NextResponse.json(
        { success: false, error: { message: "Supporting doc not found" } },
        { status: 404 },
      );
    }

    if (!row.file_url) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "Document has not been uploaded yet" },
        },
        { status: 400 },
      );
    }

    const now = new Date();
    const newStatus = action === "approve" ? "verified" : "rejected";

    await db
      .update(otherDocumentRequests)
      .set({
        upload_status: newStatus,
        rejection_reason:
          action === "reject" ? (rejection_reason ?? "").trim() : null,
        reviewed_by: appUser.id,
        reviewed_at: now,
      })
      .where(eq(otherDocumentRequests.id, requestId));

    await db.insert(auditLogs).values({
      id: createWorkflowId("AUDIT", now),
      entity_type: "supporting_doc_review",
      entity_id: requestId,
      action,
      changes: {
        lead_id: leadId,
        doc_key: row.doc_key,
        doc_label: row.doc_label,
        previous_status: row.upload_status,
        new_status: newStatus,
        note: note ?? null,
        rejection_reason: rejection_reason ?? null,
      },
      performed_by: appUser.id,
      timestamp: now,
    });

    // E-200 — if this doc is a child of an NBFC request wrapper, reproject the
    // wrapper's hop-status. Guarded: admin-origin rows (nbfc_request_id NULL)
    // never enter the NBFC loop, so the existing admin→dealer flow is untouched.
    let autoPushedToNbfc = false;
    if (row.nbfc_request_id) {
      await recomputeWrapperStatus(row.nbfc_request_id).catch(() => {});
      // E-209 — approving the LAST outstanding doc hands the request straight
      // back to the NBFC (no manual "Push to NBFC" step).
      if (action === "approve") {
        try {
          const pushed = await autoPushNbfcIfAllVerified(
            row.nbfc_request_id,
            appUser.id,
          );
          if (pushed.pushed) {
            autoPushedToNbfc = true;
            await notifyNbfcOfUpdate({
              tenantId: pushed.tenantId!,
              leadId: pushed.leadId!,
              requestId: row.nbfc_request_id,
            }).catch(() => {});
          }
        } catch {
          // best-effort — the manual Push to NBFC control remains as a fallback.
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        request_id: requestId,
        upload_status: newStatus,
        pushed_to_nbfc: autoPushedToNbfc,
      },
    });
  } catch (error) {
    console.error("[Supporting Doc Review] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to review supporting document";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
