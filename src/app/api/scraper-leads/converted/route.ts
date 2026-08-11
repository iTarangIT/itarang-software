import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { and, desc, ilike, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth-utils";
import { LEADS_PAGE_ROLES } from "@/lib/leads/access";

export async function GET(req: NextRequest) {
  // Was completely unauthenticated, like GET /api/dealer-leads before the
  // Leads/Leads-Info merge — middleware does not gate /api/*, so anyone could
  // read every converted dealer's name and phone. Same gate as the list.
  //
  // ⚠ MUST sit OUTSIDE the try/catch below. requireRole → requireAuth →
  // redirect("/login") signals by THROWING a NEXT_REDIRECT error; the catch
  // below turns any throw into a 500, so an unauthenticated request would
  // surface as "Internal error" instead of a redirect. (withErrorHandler
  // re-throws NEXT_REDIRECT for exactly this reason; this route predates it and
  // rolls its own try/catch.)
  await requireRole([...LEADS_PAGE_ROLES]);

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

    // Owner names for the page's rows. Read as a SEPARATE query rather than a
    // join so `rows` keeps the flat bare-select shape every caller expects.
    // The card used to show dealer_leads.assigned_to, a free-text column that
    // is NULL on every production row; real ownership is current_owner_id.
    const ownerNames: Record<string, string> = {};
    const ownerIds = [
      ...new Set(rows.map((l) => l.current_owner_id).filter(Boolean)),
    ] as string[];
    if (ownerIds.length) {
      // Raw SQL for the cast: dealer_leads.current_owner_id is `text` while
      // users.id is uuid, so the comparison needs ::text on the uuid side.
      const owners = await db.execute<{ id: string; name: string | null }>(sql`
        SELECT u.id::text AS id, u.name
        FROM users u
        WHERE u.id::text IN (${sql.join(ownerIds.map((i) => sql`${i}`), sql`, `)})
      `);
      for (const o of owners as unknown as { id: string; name: string | null }[]) {
        if (o.name) ownerNames[o.id] = o.name;
      }
    }

    return NextResponse.json({
      success: true,
      leads: rows.map((l) => ({
        ...l,
        current_owner_name: l.current_owner_id
          ? (ownerNames[l.current_owner_id] ?? null)
          : null,
      })),
      total: Number(countResult[0].count),
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
