// Centralised SQL builder for the 5 queue tabs (BRD §0.5).
// Raw SQL via db.execute() so we can hand-tune the JOINs to users + the
// "team" tab's status-open filter without verbose Drizzle chains.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { QueueRow, QueueTab } from "./types";
import { OPEN_STATUSES, TERMINAL_STATUSES } from "@/lib/lifecycle/transitions";

const OPEN_LIST = sql.raw(
    OPEN_STATUSES.map((s) => `'${s}'`).join(", "),
);
const TERMINAL_LIST = sql.raw(
    TERMINAL_STATUSES.map((s) => `'${s}'`).join(", "),
);

type BuildArgs = {
    tab: QueueTab;
    userId: string;
    page: number;
    limit: number;
    q?: string | null;
};

function tabFilter(tab: QueueTab, userId: string) {
    switch (tab) {
        case "my_open":
            return sql`dl.current_owner_id = ${userId} AND dl.lead_status IN (${OPEN_LIST}) AND dl.is_active IS NOT FALSE`;
        case "follow_ups":
            return sql`dl.current_owner_id = ${userId} AND dl.next_follow_up_at IS NOT NULL AND dl.next_follow_up_at <= NOW() AND dl.lead_status IN (${OPEN_LIST}) AND dl.is_active IS NOT FALSE`;
        case "unassigned":
            return sql`dl.lead_status = 'New_Unassigned' AND dl.is_active IS NOT FALSE`;
        case "team":
            return sql`dl.lead_status IN (${OPEN_LIST}) AND dl.is_active IS NOT FALSE`;
        case "my_closed":
            return sql`dl.current_owner_id = ${userId} AND dl.lead_status IN (${TERMINAL_LIST}) AND dl.closed_at >= NOW() - INTERVAL '90 days' AND dl.is_active IS NOT FALSE`;
    }
}

function tabOrder(tab: QueueTab) {
    switch (tab) {
        case "follow_ups":
            return sql`ORDER BY dl.next_follow_up_at ASC NULLS LAST`;
        case "unassigned":
            return sql`ORDER BY dl.final_intent_score DESC NULLS LAST, dl.created_at DESC`;
        case "my_closed":
            return sql`ORDER BY dl.closed_at DESC NULLS LAST`;
        case "team":
        case "my_open":
        default:
            return sql`ORDER BY COALESCE(dl.last_touchpoint_at, dl.assigned_at, dl.created_at) DESC NULLS LAST`;
    }
}

export async function fetchQueueRows({
    tab,
    userId,
    page,
    limit,
    q,
}: BuildArgs): Promise<QueueRow[]> {
    const offset = (page - 1) * limit;
    const where = tabFilter(tab, userId);
    const order = tabOrder(tab);
    const search = q
        ? sql` AND (dl.dealer_name ILIKE ${"%" + q + "%"} OR dl.phone ILIKE ${"%" + q + "%"} OR dl.shop_name ILIKE ${"%" + q + "%"})`
        : sql``;

    const rows = await db.execute<QueueRow>(sql`
        SELECT
            dl.id,
            dl.dealer_name,
            dl.shop_name,
            dl.phone,
            dl.city,
            dl.state,
            dl.language,
            dl.final_intent_score,
            dl.lead_status,
            dl.interest_level,
            dl.current_owner_id,
            owner.name AS current_owner_name,
            dl.last_touchpoint_at,
            dl.next_follow_up_at,
            dl.total_attempts,
            dl.assigned_at,
            dl.created_at,
            dl.updated_at
        FROM dealer_leads dl
        LEFT JOIN users owner ON owner.id::text = dl.current_owner_id
        WHERE ${where} ${search}
        ${order}
        LIMIT ${limit} OFFSET ${offset}
    `);

    return rows as unknown as QueueRow[];
}

export async function countQueueRows({
    tab,
    userId,
    q,
}: Pick<BuildArgs, "tab" | "userId" | "q">): Promise<number> {
    const where = tabFilter(tab, userId);
    const search = q
        ? sql` AND (dl.dealer_name ILIKE ${"%" + q + "%"} OR dl.phone ILIKE ${"%" + q + "%"} OR dl.shop_name ILIKE ${"%" + q + "%"})`
        : sql``;
    const rows = await db.execute<{ c: string }>(sql`
        SELECT COUNT(*)::text AS c FROM dealer_leads dl WHERE ${where} ${search}
    `);
    return Number(rows[0]?.c ?? 0);
}

export async function fetchAllTabCounts(userId: string): Promise<Record<QueueTab, number>> {
    const rows = await db.execute<{
        my_open: string;
        follow_ups: string;
        unassigned: string;
        team: string;
        my_closed: string;
    }>(sql`
        SELECT
            (SELECT COUNT(*)::text FROM dealer_leads dl WHERE ${tabFilter("my_open", userId)}) AS my_open,
            (SELECT COUNT(*)::text FROM dealer_leads dl WHERE ${tabFilter("follow_ups", userId)}) AS follow_ups,
            (SELECT COUNT(*)::text FROM dealer_leads dl WHERE ${tabFilter("unassigned", userId)}) AS unassigned,
            (SELECT COUNT(*)::text FROM dealer_leads dl WHERE ${tabFilter("team", userId)}) AS team,
            (SELECT COUNT(*)::text FROM dealer_leads dl WHERE ${tabFilter("my_closed", userId)}) AS my_closed
    `);
    const r = rows[0]!;
    return {
        my_open: Number(r.my_open ?? 0),
        follow_ups: Number(r.follow_ups ?? 0),
        unassigned: Number(r.unassigned ?? 0),
        team: Number(r.team ?? 0),
        my_closed: Number(r.my_closed ?? 0),
    };
}
