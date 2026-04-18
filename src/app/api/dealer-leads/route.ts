import { db } from "@/lib/db";
import { dealerLeads, scraperLeads } from "@/lib/db/schema";
import { and, desc, ilike, isNotNull, ne, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const { dealer_name, phone, shop_name, location, language, current_status } = body;

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

    await db.execute(
      sql`INSERT INTO dealer_leads (id, dealer_name, phone, shop_name, location, language, current_status, total_attempts, final_intent_score, follow_up_history, created_at)
          VALUES (${id}, ${dealer_name}, ${phone}, ${shop_name || null}, ${location || null}, ${language || "hindi"}, ${current_status || "new"}, 0, 0, '[]'::jsonb, NOW())`
    );

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
    const limit = Math.min(50, parseInt(searchParams.get("limit") ?? "10"));
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
