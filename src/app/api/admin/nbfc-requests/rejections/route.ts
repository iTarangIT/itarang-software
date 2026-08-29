/**
 * GET /api/admin/nbfc-requests/rejections?leadId=
 *
 * E-275 — every NBFC file rejection on a lead, for the "File rejections"
 * section of the admin NBFC Actions card, plus the lead's recall state so the
 * same card can offer Recall / Resubmit. Auth: requireAdminAppUser().
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, loanSanctions, nbfc, nbfcLeadAssignments } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { RECALLABLE_KYC_STATUSES, isLeadRecalled } from "@/lib/nbfc/recall";
import { getNbfcRequestSlaSettings } from "@/lib/nbfc/request-sla-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json({ success: false, error: { message: "Unauthorized" } }, { status: 403 });
    }
    const leadId = req.nextUrl.searchParams.get("leadId");
    if (!leadId) {
      return NextResponse.json({ success: false, error: { message: "leadId is required" } }, { status: 400 });
    }

    const rows = await db
      .select({
        assignmentId: nbfcLeadAssignments.id,
        nbfcName: nbfc.short_name,
        note: nbfcLeadAssignments.rejection_note,
        decided_at: nbfcLeadAssignments.decided_at,
        rejection_admin_due_at: nbfcLeadAssignments.rejection_admin_due_at,
        rejection_forwarded_at: nbfcLeadAssignments.rejection_forwarded_at,
        rejection_forward_source: nbfcLeadAssignments.rejection_forward_source,
      })
      .from(nbfcLeadAssignments)
      .leftJoin(nbfc, eq(nbfc.id, nbfcLeadAssignments.nbfc_id))
      .where(
        and(
          eq(nbfcLeadAssignments.lead_id, leadId),
          eq(nbfcLeadAssignments.status, "declined"),
          eq(nbfcLeadAssignments.decision_reason, "nbfc_rejected"),
        ),
      )
      .orderBy(desc(nbfcLeadAssignments.decided_at));

    const [lead] = await db
      .select({
        kyc_status: leads.kyc_status,
        recalled_at: leads.recalled_at,
        recall_note: leads.recall_note,
        resubmitted_at: leads.resubmitted_at,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    const [sanction] = await db
      .select({ id: loanSanctions.id })
      .from(loanSanctions)
      .where(eq(loanSanctions.lead_id, leadId))
      .limit(1);
    const recalled = isLeadRecalled(lead);
    const canRecall =
      !!lead &&
      !recalled &&
      !sanction &&
      (RECALLABLE_KYC_STATUSES as readonly string[]).includes(lead.kyc_status ?? "");

    const sla = await getNbfcRequestSlaSettings();
    return NextResponse.json({
      success: true,
      data: {
        rejections: rows,
        recall: {
          recalled,
          canRecall,
          canResubmit: recalled,
          recalled_at: lead?.recalled_at ?? null,
          recall_note: lead?.recall_note ?? null,
          resubmitted_at: lead?.resubmitted_at ?? null,
        },
        sla: {
          enabled: sla.enabled,
          rejectionSlaMinutes: sla.rejectionSlaMinutes,
          autoForwardRejection: sla.autoForwardRejection,
        },
        serverNow: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load rejections";
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
