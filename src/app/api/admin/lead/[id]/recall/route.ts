/**
 * POST /api/admin/lead/[id]/recall   body { note?: string }
 *
 * E-275 — admin recalls a financed file from the NBFCs for revision. Manual,
 * no SLA: the file stays paused until the admin hits Resubmit. Allowed only
 * while the lead is at pending_final_approval / awaiting_enach and no loan has
 * been sanctioned. Auth: requireAdminAppUser().
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { leads, loanSanctions } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { RECALLABLE_KYC_STATUSES, isLeadRecalled } from "@/lib/nbfc/recall";
import { notifyLeadRecalled } from "@/lib/notifications/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ note: z.string().trim().max(2000).optional().nullable() });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdminAppUser();
    if (!admin) {
      return NextResponse.json({ success: false, error: { message: "Unauthorized" } }, { status: 403 });
    }
    const { id: leadId } = await params;
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { message: "Validation failed", details: parsed.error.flatten() } },
        { status: 400 },
      );
    }
    const note = parsed.data.note?.trim() || null;

    const [lead] = await db
      .select({
        id: leads.id,
        kyc_status: leads.kyc_status,
        recalled_at: leads.recalled_at,
        resubmitted_at: leads.resubmitted_at,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) {
      return NextResponse.json({ success: false, error: { message: "Lead not found" } }, { status: 404 });
    }
    if (isLeadRecalled(lead)) {
      return NextResponse.json({ success: false, error: { message: "This file is already recalled" } }, { status: 409 });
    }
    if (!(RECALLABLE_KYC_STATUSES as readonly string[]).includes(lead.kyc_status ?? "")) {
      return NextResponse.json(
        { success: false, error: { message: `A file can only be recalled while awaiting final approval or E-NACH (current status: ${lead.kyc_status ?? "unknown"})` } },
        { status: 409 },
      );
    }
    const [sanction] = await db
      .select({ id: loanSanctions.id })
      .from(loanSanctions)
      .where(eq(loanSanctions.lead_id, leadId))
      .limit(1);
    if (sanction) {
      return NextResponse.json(
        { success: false, error: { message: "A loan has already been sanctioned on this lead — it can no longer be recalled" } },
        { status: 409 },
      );
    }

    const now = new Date();
    await db
      .update(leads)
      .set({ recalled_at: now, recalled_by: admin.id, recall_note: note, updated_at: now })
      .where(eq(leads.id, leadId));

    await notifyLeadRecalled({ leadId, note, adminName: admin.name });
    void import("@/lib/whatsapp/recall-flow")
      .then((m) => m.pushRecallToWhatsApp(leadId, { kind: "recalled", note: note ?? undefined }))
      .catch((err) => console.error("[admin/recall] WhatsApp push failed:", err));

    return NextResponse.json({ success: true, data: { recalled_at: now.toISOString(), note } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to recall file";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
