// SQL builder for the 4 ASM queue tabs (BRD §0.8). Raw SQL via db.execute().
// All tabs join lead_visits to surface the latest visit row's status/date —
// the queue exists to drive the ASM's visit cadence, not just owner status.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { AsmQueueRow, AsmQueueTab } from "./types";
import { TERMINAL_STATUSES } from "@/lib/lifecycle/transitions";

const TERMINAL_LIST = sql.raw(
    TERMINAL_STATUSES.map((s) => `'${s}'`).join(", "),
);

type BuildArgs = {
    tab: AsmQueueTab;
    asmId: string;
    page: number;
    limit: number;
    q?: string | null;
};

function tabFilter(tab: AsmQueueTab, asmId: string) {
    switch (tab) {
        case "my_visits":
            // Any open lead the ASM owns — not just Transferred_to_ASM. The
            // status-equals filter created ghosts when an admin reassign or
            // any other path set current_owner_id without flipping the status.
            // Ownership + not-terminal is the natural definition of "my active".
            return sql`dl.current_owner_id = ${asmId} AND dl.lead_status NOT IN (${TERMINAL_LIST}) AND dl.is_active IS NOT FALSE`;
        case "today":
            return sql`dl.asm_id = ${asmId} AND lv.scheduled_date = CURRENT_DATE AND lv.visit_status IN ('scheduled','pending_scheduling') AND dl.is_active IS NOT FALSE`;
        case "territory":
            // In-territory leads, OR any lead nobody owns yet — so the ASM sees
            // the same unassigned pool the Inside Sales claim queue surfaces
            // (manual-upload / scraped leads with NULL status included). Either
            // way the lead must be active and not terminal.
            return sql`(
                EXISTS (
                    SELECT 1 FROM asm_territories t
                    WHERE t.asm_id = ${asmId}
                      AND t.state = dl.state
                      AND (t.city IS NULL OR t.city = dl.city)
                      AND (t.active_from IS NULL OR t.active_from <= CURRENT_DATE)
                      AND (t.active_to IS NULL OR t.active_to >= CURRENT_DATE)
                )
                OR dl.current_owner_id IS NULL
            ) AND dl.lead_status IS DISTINCT FROM 'Converted' AND dl.lead_status IS DISTINCT FROM 'Lost' AND dl.is_active IS NOT FALSE`;
        case "my_closed":
            return sql`dl.closing_owner_id = ${asmId} AND dl.lead_status IN (${TERMINAL_LIST}) AND dl.closed_at >= NOW() - INTERVAL '90 days' AND dl.is_active IS NOT FALSE`;
    }
}

function tabOrder(tab: AsmQueueTab) {
    switch (tab) {
        case "today":
            return sql`ORDER BY lv.scheduled_date ASC NULLS LAST, dl.final_intent_score DESC NULLS LAST`;
        case "my_closed":
            return sql`ORDER BY dl.closed_at DESC NULLS LAST`;
        case "territory":
            return sql`ORDER BY dl.final_intent_score DESC NULLS LAST, dl.created_at DESC`;
        case "my_visits":
        default:
            return sql`ORDER BY COALESCE(lv.scheduled_date, dl.assigned_at) ASC NULLS LAST`;
    }
}

// Latest lead_visits row per dealer_lead — drives the visit_status column shown
// in the queue table. LATERAL join keeps it to one row even when a lead has
// multiple visits.
const LATEST_VISIT_JOIN = sql`
    LEFT JOIN LATERAL (
        SELECT visit_status, visit_outcome, scheduled_date, actual_visit_date
        FROM lead_visits
        WHERE dealer_lead_id = dl.id
        ORDER BY COALESCE(actual_visit_date, scheduled_date, created_at) DESC
        LIMIT 1
    ) lv ON true
`;

export async function fetchAsmQueueRows({
    tab,
    asmId,
    page,
    limit,
    q,
}: BuildArgs): Promise<AsmQueueRow[]> {
    const offset = (page - 1) * limit;
    const where = tabFilter(tab, asmId);
    const order = tabOrder(tab);
    const search = q
        ? sql` AND (dl.dealer_name ILIKE ${"%" + q + "%"} OR dl.phone ILIKE ${"%" + q + "%"} OR dl.shop_name ILIKE ${"%" + q + "%"})`
        : sql``;

    const rows = await db.execute<AsmQueueRow>(sql`
        SELECT
            dl.id,
            dl.dealer_name,
            dl.shop_name,
            dl.phone,
            dl.city,
            dl.state,
            dl.final_intent_score,
            dl.lead_status,
            dl.interest_level,
            dl.current_owner_id,
            owner.name AS current_owner_name,
            dl.asm_id,
            asm.name AS asm_name,
            dl.last_touchpoint_at,
            dl.assigned_at,
            lv.visit_status,
            lv.visit_outcome,
            lv.scheduled_date::text AS scheduled_date,
            lv.actual_visit_date::text AS actual_visit_date,
            dl.closed_at
        FROM dealer_leads dl
        ${LATEST_VISIT_JOIN}
        LEFT JOIN users owner ON owner.id::text = dl.current_owner_id
        LEFT JOIN users asm ON asm.id::text = dl.asm_id
        WHERE ${where} ${search}
        ${order}
        LIMIT ${limit} OFFSET ${offset}
    `);
    return rows as unknown as AsmQueueRow[];
}

export async function countAsmQueueRows({
    tab,
    asmId,
    q,
}: Pick<BuildArgs, "tab" | "asmId" | "q">): Promise<number> {
    const where = tabFilter(tab, asmId);
    const search = q
        ? sql` AND (dl.dealer_name ILIKE ${"%" + q + "%"} OR dl.phone ILIKE ${"%" + q + "%"} OR dl.shop_name ILIKE ${"%" + q + "%"})`
        : sql``;
    const rows = await db.execute<{ c: string }>(sql`
        SELECT COUNT(*)::text AS c FROM dealer_leads dl ${LATEST_VISIT_JOIN} WHERE ${where} ${search}
    `);
    return Number(rows[0]?.c ?? 0);
}

export async function fetchAllAsmTabCounts(asmId: string): Promise<Record<AsmQueueTab, number>> {
    const rows = await db.execute<{
        my_visits: string;
        today: string;
        territory: string;
        my_closed: string;
    }>(sql`
        SELECT
            (SELECT COUNT(*)::text FROM dealer_leads dl ${LATEST_VISIT_JOIN} WHERE ${tabFilter("my_visits", asmId)}) AS my_visits,
            (SELECT COUNT(*)::text FROM dealer_leads dl ${LATEST_VISIT_JOIN} WHERE ${tabFilter("today", asmId)}) AS today,
            (SELECT COUNT(*)::text FROM dealer_leads dl ${LATEST_VISIT_JOIN} WHERE ${tabFilter("territory", asmId)}) AS territory,
            (SELECT COUNT(*)::text FROM dealer_leads dl ${LATEST_VISIT_JOIN} WHERE ${tabFilter("my_closed", asmId)}) AS my_closed
    `);
    const r = rows[0]!;
    return {
        my_visits: Number(r.my_visits ?? 0),
        today: Number(r.today ?? 0),
        territory: Number(r.territory ?? 0),
        my_closed: Number(r.my_closed ?? 0),
    };
}
