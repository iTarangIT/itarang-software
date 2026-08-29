/**
 * POST /api/admin/lead/[id]/resubmit
 *
 * E-275 — admin resubmits a recalled file to the NBFCs. Ends the pause the
 * recall started; every NBFC on the lead is asked to review again.
 * Auth: requireAdminAppUser().
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, notInArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, nbfc, nbfcLeadAssignments } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { DECIDED_ASSIGNMENT_STATUSES } from "@/lib/nbfc/offer-negotiation";
import { isLeadRecalled } from "@/lib/nbfc/recall";
import { notifyLeadResubmitted } from "@/lib/notifications/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdminAppUser();
    if (!admin) {
      return NextResponse.json({ success: false, error: { message: "Unauthorized" } }, { status: 403 });
    }
    const { id: leadId } = await params;

    const [lead] = await db
      .select({ id: leads.id, recalled_at: leads.recalled_at, resubmitted_at: leads.resubmitted_at })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) {
      return NextResponse.json({ success: false, error: { message: "Lead not found" } }, { status: 404 });
    }
    if (!isLeadRecalled(lead)) {
      return NextResponse.json({ success: false, error: { message: "This file is not recalled" } }, { status: 409 });
    }

    const now = new Date();
    await db.update(leads).set({ resubmitted_at: now, updated_at: now }).where(eq(leads.id, leadId));

    // The lender(s) still in the race — named in the dealer's WhatsApp copy.
    const live = await db
      .select({ short_name: nbfc.short_name })
      .from(nbfcLeadAssignments)
      .leftJoin(nbfc, eq(nbfc.id, nbfcLeadAssignments.nbfc_id))
      .where(
        and(
          eq(nbfcLeadAssignments.lead_id, leadId),
          notInArray(nbfcLeadAssignments.status, [...DECIDED_ASSIGNMENT_STATUSES]),
        ),
      );
    const nbfcName = live.map((r) => r.short_name).filter(Boolean).join(", ") || undefined;

    await notifyLeadResubmitted({ leadId, adminName: admin.name });
    void import("@/lib/whatsapp/recall-flow")
      .then((m) => m.pushRecallToWhatsApp(leadId, { kind: "resubmitted", nbfcName }))
      .catch((err) => console.error("[admin/resubmit] WhatsApp push failed:", err));

    return NextResponse.json({ success: true, data: { resubmitted_at: now.toISOString() } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resubmit file";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
