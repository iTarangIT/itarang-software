import { db } from "@/lib/db";
import { dealerLeads, scraperLeads } from "@/lib/db/schema";
import { and, desc, ilike, isNotNull, ne, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import {
  normalizeCity,
  normalizeState,
  inferStateFromCity,
} from "@/lib/scraper-enrichment";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const {
      dealer_name,
      phone,
      shop_name,
      location,
      language,
      current_status,
      state,
      city,
      area,
      pincode,
    } = body;

    if (!dealer_name || !phone) {
      return NextResponse.json(
        { success: false, error: "dealer_name and phone are required" },
        { status: 400 },
      );
    }

    // Check for duplicate phone
    const existing = await db
      .select({ id: dealerLeads.id })
      .from(dealerLeads)
      .where(sql`${dealerLeads.phone} = ${phone}`)
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json(
        { success: false, error: "A lead with this phone number already exists (duplicate)" },
        { status: 409 },
      );
    }

    const id = `DL-${Date.now()}-${nanoid(8)}`;

    // Normalize the structured region. If the caller only sent `location`,
    // treat it as a city string so the region selector still sees the row.
    const canonicalCity =
      normalizeCity(city ?? location ?? undefined) ?? null;
    const canonicalState =
      normalizeState(state ?? undefined) ??
      inferStateFromCity(canonicalCity) ??
      null;

    await db.insert(dealerLeads).values({
      id,
      dealer_name,
      phone,
      shop_name: shop_name || null,
      location: location || canonicalCity,
      state: canonicalState,
      city: canonicalCity,
      area: area || null,
      pincode: pincode || null,
      language: language || "hindi",
      current_status: current_status || "new",
      total_attempts: 0,
      final_intent_score: 0,
      follow_up_history: [],
      created_at: new Date(),
    });

    return NextResponse.json({ success: true, id });
  } catch (err: any) {
    // Catch unique constraint violation from DB as a fallback
    if (err.message?.includes("unique") || err.code === "23505") {
      return NextResponse.json(
        { success: false, error: "A lead with this phone number already exists (duplicate)" },
        { status: 409 },
      );
    }
    console.error("[DEALER-LEADS] Create error:", err);
    return NextResponse.json(
      { success: false, error: "Failed to create lead. Please try again." },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
    // Cap raised to 500 so the AI Dialer can fetch the full lead pool in
    // one request (typical workspace has <500 dialable leads). Paginated
    // table views still pass limit=10 explicitly.
    const limit = Math.min(500, parseInt(searchParams.get("limit") ?? "10"));
    const search = searchParams.get("search")?.trim() ?? "";
    const offset = (page - 1) * limit;

    // Only surface leads with a phone — the AI dialer can't do anything with
    // phoneless rows, and the Leads UI's Call button would be dead otherwise.
    const phonePresent = and(
      isNotNull(dealerLeads.phone),
      ne(dealerLeads.phone, ""),
    );

    const where = search
      ? and(
          phonePresent,
          or(
            ilike(dealerLeads.dealer_name, `%${search}%`),
            ilike(dealerLeads.phone, `%${search}%`),
            ilike(dealerLeads.location, `%${search}%`),
            ilike(dealerLeads.shop_name, `%${search}%`),
          ),
        )
      : phonePresent;

    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(dealerLeads)
        .where(where)
        .orderBy(desc(dealerLeads.created_at))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(dealerLeads)
        .where(where),
    ]);

    return NextResponse.json({
      success: true,
      leads: rows.map((l) => ({ ...l, _source: "dealer" })),
      total: Number(countResult[0].count),
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
