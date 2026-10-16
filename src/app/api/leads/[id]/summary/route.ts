import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { LEADS_PAGE_ROLES, canEditLead } from "@/lib/leads/access";
import { guardApi } from "@/lib/auth/apiGuard";
import { refreshOverallSummary } from "@/lib/leads/overallSummary";

/**
 * POST /api/leads/[id]/summary — ID 118 option B (Kartik, 10 Oct): "the
 * server writes the summary itself, refreshes it when a new call transcript
 * arrives, and typed notes get their own field."
 *
 * The lead page calls this when it has no summary yet. The server builds it
 * from the call transcripts (src/lib/leads/overallSummary.ts) and saves it;
 * text in the request body is ignored — the summary can no longer be
 * overwritten from the browser. Typed notes go to Edit lead › Notes.
 * Response: { success, summary, status }.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // ID 118: signed in, with a role that reaches this screen.
  const authGate = await guardApi([...LEADS_PAGE_ROLES]);
  if (!authGate.ok) return authGate.response;
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ success: false });
  }

  // ID 118 (Q3, option A): the summary follows the Edit lead rule, so a
  // back-office role that cannot edit the lead cannot overwrite it either.
  // 404, not 403 — same answer as "no such lead".
  const { user } = authGate;
  const [lead] = await db
    .select({ current_owner_id: dealerLeads.current_owner_id, asm_id: dealerLeads.asm_id })
    .from(dealerLeads)
    .where(eq(dealerLeads.id, id))
    .limit(1);
  if (!lead || !canEditLead({ role: user.role, userId: user.id, currentOwnerId: lead.current_owner_id, asmId: lead.asm_id })) {
    return NextResponse.json({ success: false, error: { message: "Lead not found" } }, { status: 404 });
  }

  const result = await refreshOverallSummary(id);
  return NextResponse.json({ success: true, summary: result.summary, status: result.status });
}