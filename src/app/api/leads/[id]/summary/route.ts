import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function POST(req: NextRequest, { params }: any) {
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