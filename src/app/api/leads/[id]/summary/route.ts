import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { LEADS_PAGE_ROLES, readsOwnLeadsOnly } from "@/lib/leads/access";
import { leadOwnedBy } from "@/lib/ai-dialer/campaignAccess";
import { guardApi } from "@/lib/auth/apiGuard";

export async function POST(req: NextRequest, { params }: any) {
  // ID 118: signed in, with a role that reaches this screen.
  const authGate = await guardApi([...LEADS_PAGE_ROLES]);
  if (!authGate.ok) return authGate.response;
  const { id } = await params;
  const { summary } = await req.json();

  if (!summary || !id) {
    return NextResponse.json({ success: false });
  }

  // ID 118 item 5: a rep / ASM writes only the summary of a lead they own;
  // anything else is "no such lead", same as the read routes (ID 45).
  if (readsOwnLeadsOnly(authGate.user.role) && !(await leadOwnedBy(id, authGate.user.id))) {
    return NextResponse.json({ success: false, error: { message: "Lead not found" } }, { status: 404 });
  }

  await db
    .update(dealerLeads)
    .set({ overall_summary: summary })
    .where(eq(dealerLeads.id, id));

  return NextResponse.json({ success: true });
}