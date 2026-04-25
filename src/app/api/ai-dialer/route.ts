import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";
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

    const result = await triggerBolnaCall({
      phone: lead.phone!,
      leadId: lead.id,
    });
    // hello world

    return NextResponse.json({
      success: result.success,
      lead,
      call_id: result.call_id,
      error: result.error,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}