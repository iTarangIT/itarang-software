// app/api/leads/import/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

export async function POST(req: NextRequest) {
  try {
    const { leads } = await req.json();

    if (!Array.isArray(leads) || leads.length === 0) {
      return NextResponse.json({ success: false, error: "No leads provided" });
    }

    let inserted = 0;
    let skipped = 0;

    for (const lead of leads) {
      if (!lead.phone) { skipped++; continue; }

      // Check for duplicate phone
      const existing = await db.query.dealerLeads.findFirst({
        where: (l, { eq }) => eq(l.phone, lead.phone),
      });

      if (existing) { skipped++; continue; }

      await db.insert(dealerLeads).values({
        id: uuidv4(),
        shop_name:      lead.shop_name   || null,
        dealer_name:    lead.dealer_name || null,
        phone:          lead.phone,
        location:       lead.location    || null,
        language:       lead.language    || "hindi",
        current_status: lead.current_status || "new",
        follow_up_history: [],
        total_attempts: 0,
        final_intent_score: 0,
        created_at: new Date().toISOString(),
      });

      inserted++;
    }

    return NextResponse.json({ success: true, inserted, skipped });
  } catch (err: any) {
    console.error("[IMPORT] error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}