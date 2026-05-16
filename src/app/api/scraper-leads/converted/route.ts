import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { and, desc, ilike, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
    const limit = Math.min(50, parseInt(searchParams.get("limit") ?? "10"));
    const search = searchParams.get("search")?.trim() ?? "";
    const offset = (page - 1) * limit;

    // Filter is "the last entry in follow_up_history has analysis.intent_score
    // >= 75". This MUST run in SQL — the previous implementation filtered
    // after pagination, so if a converted lead wasn't in the first page of
    // newest leads it disappeared from the UI even though the data existed.
    // We use jsonb_array_length to skip empty histories cheaply, then read
    // the last element via the negative index supported by postgres jsonb.
    const convertedFilter = sql`
      ${dealerLeads.follow_up_history} IS NOT NULL
      AND jsonb_array_length(${dealerLeads.follow_up_history}) > 0
      AND COALESCE(
        ((${dealerLeads.follow_up_history} ->
          (jsonb_array_length(${dealerLeads.follow_up_history}) - 1))
          -> 'analysis' ->> 'intent_score')::int,
        0
      ) >= 75
    `;

    const searchFilter = search
      ? or(
          ilike(dealerLeads.shop_name, `%${search}%`),
          ilike(dealerLeads.phone, `%${search}%`),
          ilike(dealerLeads.location, `%${search}%`),
        )
      : undefined;

    const where = searchFilter
      ? and(convertedFilter, searchFilter)
      : convertedFilter;

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
      leads: rows,
      total: Number(countResult[0].count),
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
