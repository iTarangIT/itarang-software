import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { LEADS_PAGE_ROLES, canEditLead } from "@/lib/leads/access";
import { guardApi } from "@/lib/auth/apiGuard";

export async function POST(req: NextRequest, { params }: any) {
  // ID 118: signed in, with a role that reaches this screen.
  const authGate = await guardApi([...LEADS_PAGE_ROLES]);
  if (!authGate.ok) return authGate.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const summary = typeof body?.summary === "string" ? body.summary.trim() : "";

  if (!summary || !id) {
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

  await db
    .update(dealerLeads)
    .set({ overall_summary: summary })
    .where(eq(dealerLeads.id, id));

  return NextResponse.json({ success: true });
}