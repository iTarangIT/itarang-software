import { db } from "@/lib/db";
import { scraperLeads } from "@/lib/db/schema";
import { desc, ilike, or, sql, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth-utils";
import { LEADS_PAGE_ROLES } from "@/lib/leads/access";

export async function GET(req: NextRequest) {
  // Was completely unauthenticated — middleware does not gate /api/*
  // (src/middleware.ts), so anyone could page through every scraped prospect's
  // name, phone, email and address. Same gate as the converted sibling,
  // /api/scraper-leads/converted.
  //
  // ⚠ MUST sit OUTSIDE the try/catch below. requireRole → requireAuth →
  // redirect("/login") signals by THROWING a NEXT_REDIRECT error; the catch
  // below turns any throw into a 500, so an unauthenticated request would
  // surface as "Internal error" instead of a redirect.
  await requireRole([...LEADS_PAGE_ROLES]);

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
          desc(scraperLeads.created_at),
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
