// GET /api/admin/claims/outside-territory — ASM claims that sit outside the
// ASM's own territory (tracker ID 45: allowed, but flagged on the Sales Head
// view), for the "Claimed outside territory" card.
//
// Every ASM claim (lead_claimed touchpoint by a user who is an ASM) in the
// window is re-read against TODAY's territories (claimTerritory.ts), so setting
// a territory up clears the claims it covers — the marker frozen on the
// touchpoint is only the timeline's record. Claims are split by why:
//   outside            in a state / city the ASM does not cover
//   no_location        the lead has no state (or city) — cannot be placed
//   territory_not_set  the ASM has no territory at all — a setup gap
//
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD  claim date, IST days (default: last 30 days)
//   ?state= &city=                  the lead's (the dashboard's filters)
//   ?spoc_id=                       the claimer
//   ?team=all|field|inside          only ASM claims are checked: inside → none

import { sql } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { claimTerritoryStatusSql, type ClaimTerritoryStatus } from "@/lib/leads/claimTerritory";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "ceo", "sales_head", "sales_manager", "business_head", "partner"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 200;

export type OutsideClaimRow = {
    lead_id: string;
    dealer_name: string | null;
    city: string | null;
    state: string | null;
    claimed_by: string | null;
    claimed_by_id: string | null;
    claimed_at: string;
    status: Exclude<ClaimTerritoryStatus, "in">;
};

export type OutsideClaimsResponse = {
    rows: OutsideClaimRow[];
    counts: Record<Exclude<ClaimTerritoryStatus, "in">, number>;
    /** ASMs who claimed in the window with no territory set up, most claims first. */
    no_territory: { name: string | null; claims: number }[];
    from: string | null;
    to: string | null;
};

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(READ_ROLES);
    const p = new URL(req.url).searchParams;
    const from = DAY.test(p.get("from") ?? "") ? p.get("from")! : null;
    const to = DAY.test(p.get("to") ?? "") ? p.get("to")! : null;
    const state = p.get("state")?.trim() || null;
    const city = p.get("city")?.trim() || null;
    const spoc = p.get("spoc_id")?.trim() || null;
    const team = p.get("team");

    const empty: OutsideClaimsResponse = {
        rows: [],
        counts: { outside: 0, no_location: 0, territory_not_set: 0 },
        no_territory: [],
        from,
        to,
    };
    // Inside-sales reps have no territory; only ASM claims are checked.
    if (team === "inside") return successResponse(empty);

    const conds = [sql`t.touchpoint_type = 'lead_claimed'`, sql`lower(u.role) = 'asm'`];
    conds.push(
        from
            ? sql`t.performed_at >= ((${from})::date::timestamp AT TIME ZONE 'Asia/Kolkata')`
            : sql`t.performed_at >= NOW() - INTERVAL '30 days'`,
    );
    if (to) conds.push(sql`t.performed_at < (((${to})::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);
    if (state) conds.push(sql`lower(trim(dl.state)) = lower(trim(${state}))`);
    if (city) conds.push(sql`lower(trim(dl.city)) = lower(trim(${city}))`);
    if (spoc) conds.push(sql`t.performed_by = ${spoc}`);

    const rows = (await db.execute(sql`
        SELECT * FROM (
            SELECT t.dealer_lead_id AS lead_id,
                   COALESCE(dl.dealer_name, dl.shop_name) AS dealer_name,
                   dl.city, dl.state,
                   u.name AS claimed_by,
                   t.performed_by AS claimed_by_id,
                   t.performed_at::text AS claimed_at,
                   ${claimTerritoryStatusSql(sql`t.performed_by`)} AS status
              FROM lead_touchpoints t
              JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
              JOIN users u ON u.id::text = t.performed_by
             WHERE ${sql.join(conds, sql` AND `)}
        ) x
         WHERE x.status <> 'in'
         ORDER BY x.claimed_at DESC
    `)) as unknown as OutsideClaimRow[];

    const counts = { ...empty.counts };
    const noTerritory = new Map<string, { name: string | null; claims: number }>();
    for (const r of rows) {
        counts[r.status]++;
        if (r.status === "territory_not_set") {
            const k = r.claimed_by_id ?? "";
            const e = noTerritory.get(k) ?? { name: r.claimed_by, claims: 0 };
            e.claims++;
            noTerritory.set(k, e);
        }
    }
    const body: OutsideClaimsResponse = {
        rows: rows.slice(0, MAX_ROWS),
        counts,
        no_territory: [...noTerritory.values()].sort((a, b) => b.claims - a.claims),
        from,
        to,
    };
    return successResponse(body);
});
