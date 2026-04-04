import { db } from "@/lib/db";
import { dealerLeads, scraperLeads } from "@/lib/db/schema";
import { desc, ilike, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
    const limit = Math.min(50, parseInt(searchParams.get("limit") ?? "10"));
    const search = searchParams.get("search")?.trim() ?? "";
    const offset = (page - 1) * limit;

    const where = search
      ? or(
          ilike(dealerLeads.dealer_name, `%${search}%`),
          ilike(dealerLeads.phone, `%${search}%`),
          ilike(dealerLeads.location, `%${search}%`),
          ilike(dealerLeads.shop_name, `%${search}%`),
        )
      : undefined;

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
