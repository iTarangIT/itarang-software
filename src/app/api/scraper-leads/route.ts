import { db } from "@/lib/db";
import { scraperLeads } from "@/lib/db/schema";
import { desc, ilike, or, sql, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
    const limit = Math.min(50, parseInt(searchParams.get("limit") ?? "10"));
    const search = searchParams.get("search")?.trim() ?? "";
    const offset = (page - 1) * limit;

    const where = search
      ? or(
          ilike(scraperLeads.name, `%${search}%`),
          ilike(scraperLeads.phone, `%${search}%`),
          ilike(scraperLeads.city, `%${search}%`),
        )
      : undefined;

    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(scraperLeads)
        .where(where)
        .orderBy(
          sql`CASE WHEN ${scraperLeads.phone} IS NOT NULL AND ${scraperLeads.phone} != '' THEN 0 ELSE 1 END`,
          desc(scraperLeads.createdAt),
        )
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(scraperLeads)
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
