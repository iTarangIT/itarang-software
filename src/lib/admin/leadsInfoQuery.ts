// Raw-SQL builder for the admin "Leads Info" oversight page. Lists every lead
// in the inside-sales + ASM pipeline (dealer_leads) joined to its owner, its
// ASM and the latest lead_visits row. Mirrors the pattern of
// src/lib/asm/queryBuilder.ts and src/lib/admin/listQueries.ts.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { UNASSIGNED_FILTER } from "@/lib/admin/leadsInfoFilters";

export type LeadsInfoRow = {
    id: string;
    dealer_name: string | null;
    shop_name: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    lead_status: string | null;
    source: string | null;
    final_intent_score: number | null;
    interest_level: string | null;
    current_owner_id: string | null;
    current_owner_name: string | null;
    current_owner_role: string | null;
    asm_id: string | null;
    asm_name: string | null;
    last_touchpoint_at: string | null;
    assigned_at: string | null;
    created_at: string | null;
    visit_status: string | null;
    visit_outcome: string | null;
};

export type LeadsInfoFilters = {
    status?: string | null;
    ownerId?: string | null;
    asmId?: string | null;
    source?: string | null;
    state?: string | null;
    city?: string | null;
    search?: string | null;
};

// Re-exported for existing server-side callers. Definition lives in the
// client-safe leadsInfoFilters.ts (see import above).
export { UNASSIGNED_FILTER };

export type LeadsInfoFacets = {
    owners: { id: string; name: string | null; role: string | null }[];
    asms: { id: string; name: string | null }[];
    sources: string[];
};

// Latest lead_visits row per lead — drives the visit_status / visit_outcome
// columns. LATERAL keeps it to one row even when a lead has several visits.
const LATEST_VISIT_JOIN = sql`
    LEFT JOIN LATERAL (
        SELECT visit_status, visit_outcome
        FROM lead_visits
        WHERE dealer_lead_id = dl.id
        ORDER BY COALESCE(actual_visit_date, scheduled_date, created_at) DESC
        LIMIT 1
    ) lv ON true
`;

function buildWhere(f: LeadsInfoFilters) {
    const conds = [sql`dl.is_active IS NOT FALSE`];
    if (f.status === UNASSIGNED_FILTER) {
        conds.push(sql`dl.current_owner_id IS NULL`);
    } else if (f.status) {
        conds.push(sql`dl.lead_status = ${f.status}`);
    }
    if (f.ownerId) conds.push(sql`dl.current_owner_id = ${f.ownerId}`);
    if (f.asmId) conds.push(sql`dl.asm_id = ${f.asmId}`);
    if (f.source) conds.push(sql`dl.source = ${f.source}`);
    if (f.state) conds.push(sql`dl.state ILIKE ${`%${f.state}%`}`);
    if (f.city) conds.push(sql`dl.city ILIKE ${`%${f.city}%`}`);
    if (f.search) {
        const like = `%${f.search}%`;
        conds.push(
            sql`(dl.dealer_name ILIKE ${like} OR dl.phone ILIKE ${like} OR dl.shop_name ILIKE ${like})`,
        );
    }
    return sql.join(conds, sql` AND `);
}

export async function fetchLeadsInfoRows(
    f: LeadsInfoFilters,
    page: number,
    limit: number,
): Promise<LeadsInfoRow[]> {
    const offset = (page - 1) * limit;
    const where = buildWhere(f);
    const rows = await db.execute<LeadsInfoRow>(sql`
        SELECT
            dl.id,
            dl.dealer_name,
            dl.shop_name,
            dl.phone,
            dl.city,
            dl.state,
            dl.lead_status,
            dl.source,
            dl.final_intent_score,
            dl.interest_level,
            dl.current_owner_id,
            owner.name AS current_owner_name,
            owner.role AS current_owner_role,
            dl.asm_id,
            asm.name AS asm_name,
            dl.last_touchpoint_at,
            dl.assigned_at,
            dl.created_at,
            lv.visit_status,
            lv.visit_outcome
        FROM dealer_leads dl
        ${LATEST_VISIT_JOIN}
        LEFT JOIN users owner ON owner.id::text = dl.current_owner_id
        LEFT JOIN users asm ON asm.id::text = dl.asm_id
        WHERE ${where}
        ORDER BY dl.last_touchpoint_at DESC NULLS LAST, dl.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
    `);
    return rows as unknown as LeadsInfoRow[];
}

export async function countLeadsInfoRows(f: LeadsInfoFilters): Promise<number> {
    const where = buildWhere(f);
    const rows = await db.execute<{ c: string }>(sql`
        SELECT COUNT(*)::text AS c FROM dealer_leads dl WHERE ${where}
    `);
    return Number(rows[0]?.c ?? 0);
}

// Distinct owners / ASMs / sources present on active leads — populates the
// filter dropdowns on the page.
export async function fetchLeadsInfoFacets(): Promise<LeadsInfoFacets> {
    const owners = await db.execute<{ id: string; name: string | null; role: string | null }>(sql`
        SELECT DISTINCT u.id::text AS id, u.name, u.role
        FROM users u
        JOIN dealer_leads dl ON dl.current_owner_id = u.id::text
        WHERE dl.is_active IS NOT FALSE
        ORDER BY u.name NULLS LAST
    `);
    const asms = await db.execute<{ id: string; name: string | null }>(sql`
        SELECT DISTINCT u.id::text AS id, u.name
        FROM users u
        JOIN dealer_leads dl ON dl.asm_id = u.id::text
        WHERE dl.is_active IS NOT FALSE
        ORDER BY u.name NULLS LAST
    `);
    const sources = await db.execute<{ source: string }>(sql`
        SELECT DISTINCT source FROM dealer_leads
        WHERE is_active IS NOT FALSE AND source IS NOT NULL
        ORDER BY source
    `);
    return {
        owners: owners as unknown as LeadsInfoFacets["owners"],
        asms: asms as unknown as LeadsInfoFacets["asms"],
        sources: (sources as unknown as { source: string }[]).map((r) => r.source),
    };
}
