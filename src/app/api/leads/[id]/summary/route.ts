import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { LEADS_PAGE_ROLES } from "@/lib/leads/access";
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

  await db
    .update(dealerLeads)
    .set({ overall_summary: summary })
    .where(eq(dealerLeads.id, id));

  return NextResponse.json({ success: true });
}