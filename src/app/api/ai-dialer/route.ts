import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { desc, isNotNull } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    const leads = await db
      .select()
      .from(dealerLeads)
      .where(isNotNull(dealerLeads.phone))
      .orderBy(desc(dealerLeads.final_intent_score))
      .limit(1);

    const lead = leads[0];

    if (!lead) {
      return NextResponse.json({ error: "No leads found" }, { status: 404 });
    }

    const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/bolna/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phone: lead.phone,
        leadId: lead.id,
      }),
    });

    return NextResponse.json({
      success: true,
      lead,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}