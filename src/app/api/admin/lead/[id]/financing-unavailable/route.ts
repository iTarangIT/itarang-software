/**
 * POST /api/admin/lead/[id]/financing-unavailable
 *
 * BRD Addendum V0.2 §12.1 — admin-confirmed terminal "Financing Unavailable".
 * A lead reaches this when all financing avenues are exhausted (every routed
 * NBFC declined / not selected, OR BRE zero-match, OR manual-handoff
 * unanswered). It is admin-confirmed, never auto-killed.
 *
 * Records the category-level decline reason, flips the lead to the terminal
 * state, and purges finance-only sensitive data (§12.3) while retaining the
 * minimal audit record. The dealer may afterwards Convert to Cash (§12.2).
 *
 * Body: { category: 'all_declined'|'no_match'|'handoff_unanswered', notes?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditLogs, leads } from "@/lib/db/schema";
import { requireAdminAppUser } from "@/lib/kyc/admin-workflow";
import { purgeFinanceData } from "@/lib/nbfc/purge-finance-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  category: z.enum(["all_declined", "no_match", "handoff_unanswered"]),
  notes: z.string().max(2000).optional(),
});

// Already-terminal / post-sanction states can't be re-routed to a dead-end.
const BLOCKED_STATES = new Set(["loan_sanctioned", "sold", "financing_unavailable"]);

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
        { success: false, error: { message: "category required (all_declined|no_match|handoff_unanswered)" } },
        { status: 400 },
      );
    }
    const { category, notes } = parsed.data;

    const [lead] = await db
      .select({ id: leads.id, kyc_status: leads.kyc_status, payment_method: leads.payment_method })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) {
      return NextResponse.json({ success: false, error: { message: "Lead not found" } }, { status: 404 });
    }
    if (lead.kyc_status && BLOCKED_STATES.has(lead.kyc_status)) {
      return NextResponse.json(
        { success: false, error: { message: `Lead cannot be marked Financing Unavailable from '${lead.kyc_status}'.` } },
        { status: 400 },
      );
    }

    const now = new Date();
    await db
      .update(leads)
      .set({
        kyc_status: "financing_unavailable",
        financing_decline_category: category,
        financing_unavailable_at: now,
        updated_at: now,
      })
      .where(eq(leads.id, leadId));

    await db.insert(auditLogs).values({
      id: randomUUID(),
      entity_type: "lead",
      entity_id: leadId,
      action: "lead.financing_unavailable",
      performed_by: admin.id,
      new_data: { category, notes: notes ?? null, prior_status: lead.kyc_status, at: now.toISOString() },
    });

    // §12.3 — purge finance-only sensitive data now that finance is abandoned.
    let purged: Awaited<ReturnType<typeof purgeFinanceData>> | null = null;
    try {
      purged = await purgeFinanceData({ leadId, performedBy: admin.id, reason: "dead_end" });
    } catch (err) {
      console.error("[financing-unavailable] purge failed (state still set):", err);
    }

    return NextResponse.json({
      success: true,
      data: { leadId, kycStatus: "financing_unavailable", category, purged },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to mark financing unavailable";
    console.error("[financing-unavailable] error:", error);
    return NextResponse.json({ success: false, error: { message } }, { status: 500 });
  }
}
