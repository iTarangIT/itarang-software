// app/api/scraper/progress/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { scraperCityQueue } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const baseQuery = searchParams.get("base_query");
    const state = searchParams.get("state");

    if (!baseQuery || !state) {
      return NextResponse.json({ success: false, error: "base_query and state required" });
    }

    const queue = await db
      .select()
      .from(scraperCityQueue)
      .where(
        and(
          eq(scraperCityQueue.base_query, baseQuery),
          eq(scraperCityQueue.state, state)
        )
      );

    const total = queue.length;
    const done = queue.filter((c) => c.status === "scraped").length;
    const pending = queue.filter((c) => c.status === "pending").length;
    const scraping = queue.filter((c) => c.status === "scraping").length;
    const failed = queue.filter((c) => c.status === "failed").length;
    const totalNewLeads = queue.reduce((sum, c) => sum + (c.new_leads ?? 0), 0);
    const totalLeadsFound = queue.reduce((sum, c) => sum + (c.leads_found ?? 0), 0);

    return NextResponse.json({
      success: true,
      summary: {
        total,
        done,
        pending,
        scraping,
        failed,
        total_new_leads: totalNewLeads,
        total_leads_found: totalLeadsFound,
        percent_complete: total > 0 ? Math.round((done / total) * 100) : 0,
      },
      cities: queue.map((c) => ({
        city: c.city,
        status: c.status,
        leads_found: c.leads_found,
        new_leads: c.new_leads,
        duplicates: c.duplicates,
        scraped_at: c.scraped_at,
      })),
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}