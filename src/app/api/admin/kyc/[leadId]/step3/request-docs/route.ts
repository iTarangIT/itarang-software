import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  auditLogs,
  leads,
  otherDocumentRequests,
} from "@/lib/db/schema";
import {
  createWorkflowId,
  requireAdminAppUser,
} from "@/lib/kyc/admin-workflow";

// BRD §2.9.3 "Request Additional Documents" — admin opens the Request More Docs
// form from any primary KYC verification card or supporting-docs card and the
// backend creates one otherDocumentRequests row per checklist item.
//
// This route only creates rows + flips the lead kyc_status into a Step 3
// waiting state. Customer outreach (SMS/WhatsApp) is triggered from the dealer
// dashboard's existing Send Link buttons.

const itemSchema = z.object({
  doc_label: z.string().min(1),
  doc_key: z.string().min(1).optional(),
  is_required: z.boolean().default(true),
  reason: z.string().optional(),
});

const bodySchema = z.object({
  items: z.array(itemSchema).min(1),
  doc_for: z.enum(["primary", "co_borrower"]).default("primary"),
  source_verification_id: z.string().optional(),
});

function slugKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 100);
}

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

    const { items, doc_for, source_verification_id } = parsed.data;

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
    const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");

    const created: Array<{
      id: string;
      doc_label: string;
      upload_link: string;
    }> = [];

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const seq = Math.floor(Math.random() * 10000)
        .toString()
        .padStart(4, "0");
      const id = `OTHERDOC-${dateStr}-${seq}-${i}`;
      const token = crypto.randomBytes(32).toString("hex");
      const doc_key = item.doc_key?.trim() || slugKey(item.doc_label);

      await db.insert(otherDocumentRequests).values({
        id,
        lead_id: leadId,
        doc_for,
        doc_label: item.doc_label,
        doc_key,
        is_required: item.is_required,
        upload_status: "not_uploaded",
        rejection_reason: item.reason ?? null,
        requested_by: appUser.id,
        upload_token: token,
        token_expires_at: expires,
        created_at: now,
      });

      const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
      created.push({
        id,
        doc_label: item.doc_label,
        upload_link: `${base}/upload-docs/${leadId}/${id}/${token}`,
      });
    }

    // Flip the lead into a Step 3 waiting state. If it was already awaiting a
    // co-borrower, promote it to awaiting_both so the dealer sees both sections.
    const currentStatus = lead.kyc_status ?? "";
    const nextStatus =
      currentStatus === "awaiting_co_borrower_kyc" ||
      currentStatus === "awaiting_co_borrower_replacement" ||
      currentStatus === "awaiting_both"
        ? "awaiting_both"
        : "awaiting_additional_docs";

    await db
      .update(leads)
      .set({ kyc_status: nextStatus, updated_at: now })
      .where(eq(leads.id, leadId));

    await db.insert(auditLogs).values({
      id: createWorkflowId("AUDIT", now),
      entity_type: "step3_request_docs",
      entity_id: leadId,
      action: "create",
      changes: {
        doc_for,
        source_verification_id: source_verification_id ?? null,
        previous_status: currentStatus,
        new_status: nextStatus,
        items: created.map((c) => ({ id: c.id, doc_label: c.doc_label })),
      },
      performed_by: appUser.id,
      timestamp: now,
    });

    return NextResponse.json({
      success: true,
      data: {
        lead_status: nextStatus,
        requests: created,
      },
    });
  } catch (error) {
    console.error("[Admin Step3 Request Docs] Error:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to create document request";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
