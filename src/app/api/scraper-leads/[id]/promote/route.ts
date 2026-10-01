// app/api/scraper-leads/[id]/promote/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerLeads, scraperLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireRole } from "@/lib/auth-utils";
import { LEADS_PAGE_ROLES } from "@/lib/leads/access";
import {
  findExistingLeadByPhone,
  recordLeadCreated,
  recordReinquiry,
  stampLeadSource,
} from "@/lib/leads/leadSource";
import {
  normalizeCity,
  normalizeState,
  inferStateFromCity,
} from "@/lib/scraper-enrichment";

export async function POST(req: NextRequest, { params }: any) {
  // ID 118: this route had no login check at all (middleware does not gate
  // /api/*) — an anonymous POST could create a dealer lead from any scraper
  // record. Same roles as the other single-lead create, POST /api/dealer-leads.
  let user: { id: string };
  try {
    user = await requireRole([...LEADS_PAGE_ROLES]);
  } catch {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }
  try {
    const { id } = await params;

    // 1. Find scraper lead
    const scraperLead = await db.query.scraperLeads.findFirst({
      where: (l, { eq }) => eq(l.id, id),
    });

    if (!scraperLead) {
      return NextResponse.json({ success: false, error: "Scraper lead not found" }, { status: 404 });
    }

    // 2. ID 81: the SHARED duplicate check (last 10 digits). A known dealer is a
    //    Re-inquiry on the existing lead, never a second copy.
    const existingId = await findExistingLeadByPhone(scraperLead.phone);
    if (existingId) {
      await recordReinquiry({ leadId: existingId, door: "scraper", actorId: user.id, note: scraperLead.name ?? null });
      return NextResponse.json({ success: true, dealerLeadId: existingId, alreadyExisted: true });
    }

    // 3. Promote — insert into dealer_leads
    const newId = `L-${nanoid(8)}`;
    const canonicalCity = normalizeCity(scraperLead.city ?? undefined) ?? null;
    const canonicalState =
      normalizeState(undefined) ??
      inferStateFromCity(canonicalCity) ??
      null;

    await db.insert(dealerLeads).values({
      id: newId,
      dealer_name: scraperLead.name ?? null,
      shop_name:   scraperLead.name ?? null,
      phone:       scraperLead.phone ?? null,
      location:    canonicalCity,
      state:       canonicalState,
      city:        canonicalCity,
      language:    "hindi",
      current_status: "new",
      total_attempts: 0,
      follow_up_history: [],
      created_at: new Date(),
    });

    // ID 81: source + "Lead created".
    await stampLeadSource(db, newId, { door: "scraper", origin: "scraped_listing" });
    await recordLeadCreated(db, { leadId: newId, actorId: user.id, door: "scraper", ownerId: null });

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