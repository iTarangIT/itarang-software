import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { leadId } = await req.json();

    if (!leadId) {
      return NextResponse.json({ success: false, error: "Missing leadId" });
    }

    await db
      .update(dealerLeads)
      .set({
        current_status: "assigned",
      })
      .where(eq(dealerLeads.id, leadId));

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}