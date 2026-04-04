// app/api/scraper-leads/[id]/promote/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerLeads, scraperLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

export async function POST(req: NextRequest, { params }: any) {
  try {
    const { id } = await params;

    // 1. Find scraper lead
    const scraperLead = await db.query.scraperLeads.findFirst({
      where: (l, { eq }) => eq(l.id, id),
    });

    if (!scraperLead) {
      return NextResponse.json({ success: false, error: "Scraper lead not found" }, { status: 404 });
    }

    // 2. Check if already promoted (phone already in dealer_leads)
    if (scraperLead.phone) {
      const existing = await db.query.dealerLeads.findFirst({
        where: (l, { eq }) => eq(l.phone, scraperLead.phone!),
      });
      if (existing) {
        return NextResponse.json({ success: true, dealerLeadId: existing.id, alreadyExisted: true });
      }
    }

    // 3. Promote — insert into dealer_leads
    const newId = `L-${nanoid(8)}`;

    await db.insert(dealerLeads).values({
      id: newId,
      dealer_name: scraperLead.name ?? null,
      shop_name:   scraperLead.name ?? null,
      phone:       scraperLead.phone ?? null,
      location:    scraperLead.city ?? null,
      language:    "hindi",
      current_status: "new",
      total_attempts: 0,
      follow_up_history: [],
      created_at: new Date(),
    });

    // 4. Update scraper lead status to promoted
    await db
      .update(scraperLeads)
      .set({ status: "promoted" })
      .where(eq(scraperLeads.id, id));

    return NextResponse.json({ success: true, dealerLeadId: newId, alreadyExisted: false });
  } catch (err: any) {
    console.error("[PROMOTE] error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}