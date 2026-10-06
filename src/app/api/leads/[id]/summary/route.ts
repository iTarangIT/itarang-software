import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { LEADS_PAGE_ROLES, exportsOwnLeadsOnly } from "@/lib/leads/access";
import { leadOwnedBy } from "@/lib/ai-dialer/campaignAccess";
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

  // A rep / ASM / partner may only write the summary of a lead they own (the
  // ID 58 own-leads-only roles). 404, not 403 — same answer as "no such lead".
  const { user } = authGate;
  if (exportsOwnLeadsOnly(user.role) && !(await leadOwnedBy(id, user.id))) {
    return NextResponse.json({ success: false, error: { message: "Lead not found" } }, { status: 404 });
  }

  await db
    .update(dealerLeads)
    .set({ overall_summary: summary })
    .where(eq(dealerLeads.id, id));

  return NextResponse.json({ success: true });
}