// ID 244 — the one-line numbers strip on My visits, for whoever "Showing" points at
// (Me, one team member, or the whole team). Every number uses the same scope as the list
// and the tab counts below it, so the strip adds up:
//   hot + warm + cold + not rated = Open leads (the Open leads tab);
//   Visits today = the Today's visits tab.
// Server only.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { humanCall } from "@/lib/reports/metricDefinitions";
import { visitedRowSql } from "@/lib/visits/freshRepeat";

import { LATEST_VISIT_JOIN, memberClause, tabFilter } from "./queryBuilder";
import { nextBookingJoin } from "./nextBooking";
import type { VisitsStripNumbers } from "./types";

export type VisitsStrip = VisitsStripNumbers;

/**
 * `member` is the resolved pick (pickTeamMember): a person's id, or null for the whole
 * scope (the viewer and their direct reports).
 */
export async function fetchVisitsStrip(asmId: string, teamMemberIds: readonly string[] | null, member: string | null): Promise<VisitsStrip> {
    const people = member ? [member] : [asmId, ...(teamMemberIds ?? [])];
    const peopleList = sql.join(people.map((p) => sql`${p}`), sql`, `);
    const rows = (await db.execute(sql`
        WITH istd AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS today),
        open_leads AS (
            SELECT lower(COALESCE(dl.interest_level, '')) AS t, nb.scheduled_date AS booked
              FROM dealer_leads dl
              ${LATEST_VISIT_JOIN}
              ${nextBookingJoin("nb")}
             WHERE ${tabFilter("my_visits", asmId, teamMemberIds)} ${memberClause("my_visits", member)}
        )
        SELECT
            (SELECT count(*) FROM open_leads)::int AS open_leads,
            (SELECT count(*) FROM open_leads WHERE t = 'hot')::int AS hot,
            (SELECT count(*) FROM open_leads WHERE t = 'warm')::int AS warm,
            (SELECT count(*) FROM open_leads WHERE t = 'cold')::int AS cold,
            (SELECT count(*) FROM open_leads WHERE t NOT IN ('hot', 'warm', 'cold'))::int AS not_rated,
            (SELECT count(*) FROM dealer_leads dl ${LATEST_VISIT_JOIN}
              WHERE ${tabFilter("today", asmId, teamMemberIds)} ${memberClause("today", member)})::int AS visits_today,
            (SELECT count(*) FROM open_leads, istd
              WHERE booked > istd.today AND booked <= istd.today + 7)::int AS next_7_days,
            -- rule 185: one person, one dealer, one IST day, visited rows only.
            (SELECT count(*) FROM (
                SELECT DISTINCT v.asm_id, v.dealer_lead_id, v.actual_visit_date FROM lead_visits v, istd
                 WHERE ${visitedRowSql("v")} AND v.actual_visit_date = istd.today - 1
                   AND v.asm_id IN (${peopleList})) x)::int AS visits_yesterday,
            (SELECT count(*) FROM lead_touchpoints t, istd
              WHERE ${humanCall(sql`t`)} AND t.performed_by IN (${peopleList})
                AND (t.performed_at AT TIME ZONE 'Asia/Kolkata')::date = istd.today - 1)::int AS calls_yesterday
    `)) as unknown as VisitsStrip[];
    const r = rows[0];
    return {
        open_leads: Number(r?.open_leads ?? 0),
        hot: Number(r?.hot ?? 0),
        warm: Number(r?.warm ?? 0),
        cold: Number(r?.cold ?? 0),
        not_rated: Number(r?.not_rated ?? 0),
        visits_today: Number(r?.visits_today ?? 0),
        next_7_days: Number(r?.next_7_days ?? 0),
        visits_yesterday: Number(r?.visits_yesterday ?? 0),
        calls_yesterday: Number(r?.calls_yesterday ?? 0),
    };
}
